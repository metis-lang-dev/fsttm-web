"""fsttm_web, the Python UI library: one source (the checkout's lib/ and
web/ in an editable install), the mount on aiohttp, the stub backend over
the page's wire. pip install -e '.[aiohttp]' pytest; pytest test/test_python.py"""
import asyncio
from pathlib import Path

import fsttm_web
import fsttm_web.protocol as wire

REPO = Path(__file__).resolve().parents[1]


def test_one_source():
    assert fsttm_web.LIB.resolve() == (REPO / "lib").resolve()        # the checkout's lib/, no copy
    assert (fsttm_web.LIB / "dialog.js").read_text() == (REPO / "lib/dialog.js").read_text()
    for name, src in [("example.gbnf", "grammar"), ("example-prompt.txt", "prompt"), ("example-pass2.txt", "prompt")]:
        assert fsttm_web.asset(name).resolve() == (REPO / src / name).resolve()
    assert fsttm_web.asset("dog.gbnf") is None                    # 0.4.0: the reference page's assets are the example's
    assert fsttm_web.routes(page=False) == [("/lib/", fsttm_web.LIB)]
    assert set(fsttm_web.IMPORT_MAP["imports"]) == {"fsttm-web/fsttm", "fsttm-web/attention", "fsttm-web/dialog", "fsttm-web/tts",
                                                     "fsttm-web/ws", "fsttm-web/panel", "fsttm-web/narrator",
                                                     "fsttm-web/bench", "fsttm-web/fsmview"}
    assert not hasattr(fsttm_web, "SHELL") and not (fsttm_web.LIB / "shell.css").exists()   # 0.3.0: no consoles' shell


def test_echo_backend():
    b = wire.Echo()
    assert b.handle({"ev": "say_text", "id": "s-t1", "text": "go to the door", "mode": "intent"}) == [
        {"ev": "intent", "id": "s-t1", "intent": {"intent": "CHITCHAT"}, "voice": "You said: go to the door."}]
    t = b.handle({"ev": "say_text", "id": "s-t2", "text": "hi", "mode": "talk"})
    assert [f["done"] for f in t] == [False, False, True] and t[0]["text"] == "You said: hi."
    assert b.handle({"ev": "cut", "id": "s-t2", "heard": "You said"}) == [] and b.frames[-1]["heard"] == "You said"
    assert wire.parse("not json") is None and wire.parse('{"ev":"cut"}') == {"ev": "cut"}


def test_mount_serves_the_page_and_the_wire():
    from aiohttp import WSMsgType, web
    from aiohttp.test_utils import TestClient, TestServer
    from fsttm_web.aiohttp import mount

    async def ws(request):
        sock, backend = web.WebSocketResponse(), wire.Echo()
        await sock.prepare(request)
        async for msg in sock:
            if msg.type == WSMsgType.TEXT and (m := wire.parse(msg.data)):
                for f in backend.handle(m):
                    await sock.send_json(f)
        return sock

    async def run():
        app = web.Application()
        app.router.add_get("/ws", ws)
        mount(app)
        async with TestClient(TestServer(app)) as c:
            for path in ["/", "/lib/dialog.js", "/lib/fsttm.json", "/assets/example.gbnf", "/app.js", "/backend/ws.js"]:
                assert (await c.get(path)).status == 200, path
            assert (await c.get("/assets/nope")).status == 404
            assert "importmap" in await (await c.get("/")).text()
            w = await c.ws_connect("/ws")
            await w.send_json({"ev": "say_text", "id": "s-t1", "text": "sit", "mode": "intent"})
            assert (await w.receive_json())["voice"] == "You said: sit."
            await w.close()
    asyncio.run(run())


def test_the_host_frames():
    assert wire.chat("user", "hi") == {"ev": "chat", "who": "user", "text": "hi"}
    assert wire.chat("system", "hello", id="h1", voice=False) == {"ev": "chat", "who": "system", "text": "hello", "id": "h1", "voice": False}
    assert wire.ctl(barge_in="energy", voice=None, mic=True) == {"ev": "ctl", "barge_in": "energy", "mic": True}
    assert set(wire.HOST_FRAMES) == {"chat", "event", "state"}


def test_chat_feeds_and_expects():
    from fsttm_web.chat import Chat

    async def run():
        sent = []

        async def send(f):
            sent.append(f)
        chat = Chat(send)
        await chat.user("go to the door")
        await chat.system("The door is open.", voice=False)
        await chat.ctl(barge_in="none")
        assert sent == [wire.chat("user", "go to the door"), wire.chat("system", "The door is open.", voice=False), wire.ctl(barge_in="none")]
        assert not chat.feed({"ev": "intent", "id": "x"}) and not chat.feed(None)          # the backend's, not the host's
        assert chat.feed({"ev": "chat", "who": "user", "text": "go to the door", "row": 1, "via": "host", "tags": []})
        later = asyncio.get_running_loop().call_later(0.05, chat.feed, {"ev": "chat", "who": "system", "text": "I go.", "row": 2, "tags": ["spoken"]})
        f = await chat.expect(lambda f: "spoken" in f["tags"], ev="chat", who="system", timeout=2)
        assert f["text"] == "I go." and chat.said() == ["I go."]
        chat.feed({"ev": "state", "floor": "FREEs", "barge_in": "none"})
        assert (await chat.expect(ev="state"))["barge_in"] == "none" and chat.state["floor"] == "FREEs"
        m = chat.mark()
        chat.feed({"ev": "event", "kind": "speak", "t": 1})
        chat.feed({"ev": "event", "kind": "final", "t": 2})
        assert (await chat.expect(ev="event", kind="final", since=m))["t"] == 2      # in any order from a mark,
        assert (await chat.expect(ev="event", kind="speak", since=m))["t"] == 1      # nothing used up
        try:
            await chat.expect(ev="chat", timeout=0.05)
            raise AssertionError("expect() past the last frame must time out")
        except TimeoutError:
            pass
        later.cancel()
    asyncio.run(run())


def test_the_relay_and_the_host_route():
    from aiohttp import WSMsgType, web
    from aiohttp.test_utils import TestClient, TestServer
    from fsttm_web.aiohttp import host_route
    from fsttm_web.chat import Chat, Relay

    relay = Relay()

    async def page(request):   # a page's socket: what the host sends arrives; the page's host frames go on
        sock = web.WebSocketResponse()
        await sock.prepare(request)
        relay.add_page(sock.send_json)
        async for msg in sock:
            if msg.type == WSMsgType.TEXT and (m := wire.parse(msg.data)):
                await relay.from_page(m)
        relay.drop_page(sock.send_json)
        return sock

    async def run():
        app = web.Application()
        app.router.add_get("/ws", page)
        host_route(app, relay)
        async with TestClient(TestServer(app)) as c:
            h = await c.ws_connect("/host")
            await h.send_json(wire.chat("user", "hello"))
            assert (await h.receive_json())["ev"] == "error"                              # no page yet
            p = await c.ws_connect("/ws")
            await asyncio.sleep(0.05)
            chat = await Chat.connect(str(c.make_url("/host")))
            await chat.user("hello")
            assert await p.receive_json() == wire.chat("user", "hello")                   # the page gets the host's line
            await p.send_json({"ev": "chat", "who": "system", "text": "You said: hello.", "row": 2, "tags": []})
            assert (await chat.expect(ev="chat", who="system"))["text"] == "You said: hello."
            assert (await h.receive_json())["text"] == "You said: hello."                 # every host hears the page
            await p.send_json({"ev": "say_text", "id": "s-t1", "text": "x", "mode": "intent"})   # the backend's: not relayed
            await p.send_json({"ev": "state", "floor": "FREEs"})
            assert (await h.receive_json())["ev"] == "state"
            await chat.close()
            await h.close()
            await p.close()
    asyncio.run(run())
