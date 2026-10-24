"""The host's side of the panel's backchannel (fsttm_web.protocol: chat, ctl; the README's "The
wire"): a program or a test on the host types as the person, speaks as her, sets the strip, and
reads the dialog as the person sees it — every row with its source and tags, every event, the
state.

In the backend's own process (it holds the page's socket):

    chat = Chat(sock.send_json)                  # in the page's socket handler
    async for msg in sock:
        m = wire.parse(msg.data)
        if chat.feed(m):                         # chat, event, state: the host's
            continue
        ...                                      # say_text, cut, heard: the backend's

    await chat.user("put the tomato in the microwave")
    row = await chat.expect(ev="chat", who="system")        # her answer
    await chat.ctl(barge_in="energy")
    await chat.expect(lambda f: f.get("barge_in") == "energy", ev="state")

From another process, through a Relay on the server (fsttm_web.aiohttp.host_route):

    chat = await Chat.connect("ws://127.0.0.1:8397/host")
    ...
    await chat.close()

and at a terminal: python -m fsttm_web.chat ws://127.0.0.1:8397/host

The host's tool, for any page with the dialog panel (the reference page, a console, the world page),
whatever its backend: fsttm-chat (python -m fsttm_web.chat) serves /page on 8395 and types as the
host; the page connects by itself when its URL has ?fw_host (?fw_host=PORT, ?fw_host=ws://…/page:
the panel's hostParam). Other hosts (a test's Chat.connect) at /host. No mic needed.
"""
import asyncio
import json
import os
import sys

from . import protocol as wire


def _matches(frame, pred, match):
    return all(frame.get(k) == v for k, v in match.items()) and (pred is None or pred(frame))


class Chat:
    """One page's backchannel. send: an async callable taking a frame (a dict); feed(frame):
    each frame from the page, which keeps what is the host's (chat, event, state)."""

    def __init__(self, send):
        self._send = send
        self.frames = []          # every host frame from the page, in order
        self.rows = {}            # row n → its last chat frame (a row comes again on each new tag)
        self.state = {}           # the page's last state
        self._cursor = 0          # expect() reads on from here
        self._cond = asyncio.Condition()
        self._closer = None

    # ── to the page ──────────────────────────────────────────────────────
    async def user(self, text, id=None):
        """A line as the person's: the panel's one entry (the floor, attention, a turn)."""
        await self._send(wire.chat("user", text, id=id))

    async def system(self, text, voice=True, id=None):
        """Her words: shown, and spoken unless voice is False."""
        await self._send(wire.chat("system", text, id=id, voice=None if voice else False))

    async def ctl(self, **controls):
        """The strip: barge_in="words"|"energy"|"none", voice=bool, attention="awake"|"asleep",
        reply=<a mode of the page's>, mic=bool."""
        await self._send(wire.ctl(**controls))

    # ── from the page ────────────────────────────────────────────────────
    def feed(self, frame):
        """A frame from the page; True when it is the host's (kept), False when it is the backend's."""
        if not isinstance(frame, dict) or frame.get("ev") not in wire.HOST_FRAMES:
            return False
        self.frames.append(frame)
        if frame["ev"] == "chat" and frame.get("row") is not None:
            self.rows[frame["row"]] = frame
        elif frame["ev"] == "state":
            self.state = {k: v for k, v in frame.items() if k != "ev"}
        asyncio.get_running_loop().create_task(self._wake())
        return True

    async def _wake(self):
        async with self._cond:
            self._cond.notify_all()

    def mark(self):
        """Where the frames are now: expect(since=mark) looks from here, whatever came first."""
        return len(self.frames)

    async def expect(self, pred=None, timeout=5.0, since=None, **match):
        """The next frame from the page whose fields equal match and for which pred(frame) holds;
        TimeoutError after timeout seconds. By default it reads on from the last frame an expect()
        returned (the frames it passes are used up); with since=mark() it looks at every frame
        from the mark and uses nothing up, so two waits need not come in the frames' order."""
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        i = since
        async with self._cond:
            while True:
                while (i if since is not None else self._cursor) < len(self.frames):
                    if since is not None:
                        f = self.frames[i]
                        i += 1
                    else:
                        f = self.frames[self._cursor]
                        self._cursor += 1
                    if _matches(f, pred, match):
                        return f
                left = end - loop.time()
                if left <= 0:
                    raise TimeoutError(f"no frame like {match or ''}{' + pred' if pred else ''} in {timeout} s; "
                                       f"the last: {self.frames[-3:]}")
                try:
                    await asyncio.wait_for(self._cond.wait(), left)
                except asyncio.TimeoutError:
                    pass

    def __aiter__(self):
        return self._each()

    async def _each(self):
        i = len(self.frames)
        while True:
            async with self._cond:
                while i >= len(self.frames):
                    await self._cond.wait()
            while i < len(self.frames):
                yield self.frames[i]
                i += 1

    def said(self):
        """Her words so far, as the rows show them (who system), in order."""
        return [r["text"] for n, r in sorted(self.rows.items()) if r.get("who") == "system"]

    # ── over a socket of its own (a Relay's host route) ─────────────────
    @classmethod
    async def connect(cls, url):
        """A Chat over a websocket to a Relay's host route (aiohttp's client)."""
        import aiohttp
        session = aiohttp.ClientSession()
        try:
            ws = await session.ws_connect(url)
        except BaseException:
            await session.close()
            raise
        chat = cls(ws.send_json)

        async def read():
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT and (m := wire.parse(msg.data)):
                    chat.feed(m)
        reader = asyncio.get_running_loop().create_task(read())

        async def close():
            reader.cancel()
            await ws.close()
            await session.close()
        chat._closer = close
        return chat

    async def close(self):
        if self._closer:
            await self._closer()


class Relay:
    """The pages and the hosts of one server, joined: a host's chat/ctl goes to the pages (the
    last that opened, or all), a page's chat/event/state to every host. Transport-free: each side
    is an async send callable (fsttm_web.aiohttp.host_route serves the hosts' side)."""

    def __init__(self, to="last"):
        self.to = to              # "last": the page opened last; "all": every page
        self.pages = []
        self.hosts = []

    def add_page(self, send):
        self.pages.append(send)
        return send

    def drop_page(self, send):
        if send in self.pages:
            self.pages.remove(send)

    def add_host(self, send):
        self.hosts.append(send)
        return send

    def drop_host(self, send):
        if send in self.hosts:
            self.hosts.remove(send)

    async def from_page(self, frame):
        """A page's frame: True (sent on to the hosts) when it is a host frame."""
        if not isinstance(frame, dict) or frame.get("ev") not in wire.HOST_FRAMES:
            return False
        for send in list(self.hosts):
            try:
                await send(frame)
            except Exception:
                self.drop_host(send)
        return True

    async def from_host(self, frame):
        """A host's frame (chat, ctl) to the pages; False when there is no page."""
        targets = self.pages[-1:] if self.to == "last" else list(self.pages)
        for send in targets:
            try:
                await send(frame)
            except Exception:
                self.drop_page(send)
        return bool(targets)


# ── the CLI: stdin lines as the person, the page's frames printed ───────
HELP = """a line (or /user <words>) is the person's: the panel's one entry, as if heard
/system <words>   her words, spoken      /quiet <words>   her words, shown only
/ctl barge_in=energy voice=0 attention=asleep reply=talk mic=1   the strip
/events           the events on/off      /help            this      /quit"""


def _value(v):
    return {"1": True, "true": True, "on": True, "0": False, "false": False, "off": False}.get(v.lower(), v)


def _show(f, events):
    if f["ev"] == "chat":
        tags = f" [{', '.join(f['tags'])}]" if f.get("tags") else ""
        return f"{f.get('who', '?'):>6} · {f.get('via', '')}: {f.get('text', '')}{tags}"
    if f["ev"] == "state":
        return "state  " + " ".join(f"{k}={v}" for k, v in f.items() if k != "ev")
    if events:
        return "event  " + json.dumps({k: v for k, v in f.items() if k != "ev"})
    return None


async def main(url):
    chat = await Chat.connect(url)
    print(f"connected to {url}\n{HELP}", file=sys.stderr)
    await repl(chat)


async def serve(port, bind="127.0.0.1"):
    """A Relay on port: the pages at /page, other hosts at /host, and this terminal as one more."""
    from aiohttp import web
    from .aiohttp import host_route, page_route
    relay = Relay()
    chat = Chat(relay.from_host)

    async def heard(frame):
        chat.feed(frame)
    relay.add_host(heard)
    app = web.Application()
    page_route(app, relay, on_page=lambda n: print(f"-- pages open: {n}", file=sys.stderr, flush=True))
    host_route(app, relay)
    runner = web.AppRunner(app)
    await runner.setup()
    await web.TCPSite(runner, bind, port).start()
    url = f"ws://{bind}:{port}/page"
    hint = "?fw_host" if port == PORT else f"?fw_host={port}"
    print(f"fsttm-chat: open the page with {hint} on its URL (any page with the dialog panel; {url}); "
          f"other hosts at ws://{bind}:{port}/host\n{HELP}", file=sys.stderr)
    try:
        await repl(chat, relay)
    finally:
        await runner.cleanup()


def _stdin_lines():
    """stdin's lines on a queue ("" at its end): the loop's reader, so Ctrl-C ends at once (a thread
    blocked in readline would hold the exit); a thread where stdin cannot be watched."""
    loop, q = asyncio.get_running_loop(), asyncio.Queue()
    buf = bytearray()

    def readable():                       # the fd itself: a buffered readline would keep a second line unseen
        data = os.read(fd, 65536)
        if not data:
            loop.remove_reader(fd)
            if buf:
                q.put_nowait(buf.decode(errors="replace"))
            q.put_nowait("")
            return
        buf.extend(data)
        while (i := buf.find(b"\n")) >= 0:
            q.put_nowait(buf[:i + 1].decode(errors="replace"))
            del buf[:i + 1]
    try:
        fd = sys.stdin.fileno()
        loop.add_reader(fd, readable)
    except (NotImplementedError, OSError, ValueError):
        import threading

        def pump():
            for line in iter(sys.stdin.readline, ""):
                loop.call_soon_threadsafe(q.put_nowait, line)
            loop.call_soon_threadsafe(q.put_nowait, "")
        threading.Thread(target=pump, daemon=True).start()
    return q


async def repl(chat, relay=None):
    """stdin lines as the host's (HELP), the page's rows and state printed."""
    events = False

    async def show():
        last = {}
        async for f in chat:
            if f["ev"] == "chat" and last.get(f.get("row")) == f:
                continue
            last[f.get("row")] = f
            line = _show(f, events)
            if line:
                print(line, flush=True)
    printer = asyncio.get_running_loop().create_task(show())
    lines = _stdin_lines()
    try:
        while True:
            line = await lines.get()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            if line == "/quit":
                break
            if line == "/events":
                events = not events
            elif relay is not None and not relay.pages and (not line.startswith("/") or line.split()[0] in ("/user", "/system", "/quiet", "/ctl")):
                print("-- no page yet: open one with ?fw_host on its URL (it connects by itself)", file=sys.stderr)
            elif line.startswith("/user "):
                await chat.user(line[6:])
            elif line.startswith("/system "):
                await chat.system(line[8:])
            elif line.startswith("/quiet "):
                await chat.system(line[7:], voice=False)
            elif line.startswith("/ctl "):
                kv = dict(p.split("=", 1) for p in line[5:].split() if "=" in p)
                await chat.ctl(**{k: _value(v) for k, v in kv.items()})
            elif line.startswith("/"):
                print(HELP, file=sys.stderr)
            else:
                await chat.user(line)
    finally:
        printer.cancel()
        await chat.close()


PORT = 8395           # the panel's ?fw_host without a port


def cli(argv=None):
    """fsttm-chat [PORT [BIND]]: the host's tool (pages at /page, ?fw_host); fsttm-chat ws://…/host: a
    host of another server's Relay (examples/serve.py's /host)."""
    a = sys.argv[1:] if argv is None else argv
    if a[:1] == ["--serve"]:
        a = a[1:]
    try:
        if not a or (a[0].isdigit() and len(a) <= 2):
            asyncio.run(serve(int(a[0]) if a else PORT, *a[1:]))
        elif len(a) == 1 and a[0].startswith(("ws://", "wss://")):
            asyncio.run(main(a[0]))
        else:
            sys.exit(f"fsttm-chat [PORT [BIND]]   the host's tool: open a page with ?fw_host (PORT {PORT}) or ?fw_host=PORT\n"
                     "fsttm-chat ws://HOST:PORT/host   a host of a server's Relay (fsttm_web.aiohttp.host_route)")
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cli()
