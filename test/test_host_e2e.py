"""The host's backchannel end to end: examples/serve.py (the stub backend, the Relay, /host) and the
reference page in a headless Chrome (?backend=ws&host); a Chat on /host types as the person, speaks
as her and sets the strip, and reads the rows, the events and the state the page sends back.
pip install -e '.[aiohttp]' pytest; Chrome (CHROME=… else google-chrome); pytest test/test_host_e2e.py"""
import asyncio
import importlib.util
import os
import shutil
import signal
import socket
import subprocess
import tempfile
from pathlib import Path

import pytest

aiohttp = pytest.importorskip("aiohttp")
CHROME = os.environ.get("CHROME") or shutil.which("google-chrome") or shutil.which("chromium")
REPO = Path(__file__).resolve().parents[1]


def _serve_module():
    spec = importlib.util.spec_from_file_location("fw_serve", REPO / "examples" / "serve.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.mark.skipif(not CHROME, reason="no Chrome (CHROME=…)")
def test_a_host_drives_the_page_and_reads_it():
    from aiohttp import web
    from fsttm_web.chat import Chat

    serve = _serve_module()

    async def run():
        port = _free_port()
        runner = web.AppRunner(serve.app())
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", port).start()
        prof = tempfile.mkdtemp(prefix="fw-host-chrome-")
        chrome = subprocess.Popen([CHROME, "--headless=new", f"--user-data-dir={prof}", "--no-first-run",
                                   "--autoplay-policy=no-user-gesture-required",
                                   f"http://127.0.0.1:{port}/?backend=ws&host"],
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        chat = None
        try:
            for _ in range(150):                      # the page has opened its socket
                if serve.relay.pages:
                    break
                await asyncio.sleep(0.1)
            assert serve.relay.pages, "the page never opened /ws"
            chat = await Chat.connect(f"ws://127.0.0.1:{port}/host")
            await asyncio.sleep(0.3)

            # as the person: the one entry, a turn on the stub, her answer spoken
            m = chat.mark()
            await chat.user("hello there", id="q1")
            u = await chat.expect(ev="chat", who="user", host_id="q1", since=m, timeout=10)
            assert u["text"] == "hello there" and u["via"] == "host" and u["id"]
            s = await chat.expect(lambda f: f["text"].startswith("You said: hello there.") and "spoken" in f["tags"],
                                  ev="chat", who="system", timeout=20)
            assert s["via"] == "backend" and s["id"] == u["id"]
            kinds = {f["kind"] for f in chat.frames if f["ev"] == "event"}
            assert {"final", "heard", "llm", "speak", "fsttm"} <= kinds, kinds   # the events, mirrored

            # the strip from the host: the state comes back
            await chat.ctl(barge_in="energy", reply="intent")
            st = await chat.expect(lambda f: f.get("barge_in") == "energy" and f.get("reply") == "intent", ev="state", timeout=5)
            assert st["voice"] is True

            # as her: shown and spoken; then the voice off: shown only
            await chat.system("The door is open.")
            await chat.expect(lambda f: f["text"] == "The door is open." and "spoken" in f["tags"], ev="chat", who="system", timeout=15)
            await chat.ctl(voice=False)
            await chat.expect(lambda f: f.get("voice") is False, ev="state", timeout=5)
            await chat.system("Shown only.")
            q = await chat.expect(lambda f: f["text"] == "Shown only.", ev="chat", who="system", timeout=5)
            await asyncio.sleep(1.0)
            assert "spoken" not in chat.rows[q["row"]]["tags"]

            # the intent mode now: the stub's CHITCHAT row comes back
            await chat.user("what time is it")
            await chat.expect(lambda f: "CHITCHAT" in f["text"], ev="chat", who="intent", timeout=10)
            assert chat.said()[0].startswith("You said: hello there.")
        finally:
            if chat:
                await chat.close()
            try:
                os.killpg(chrome.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            try:
                chrome.wait(5)
            except subprocess.TimeoutExpired:
                os.killpg(chrome.pid, signal.SIGKILL)
            await runner.cleanup()
            shutil.rmtree(prof, ignore_errors=True)
    asyncio.run(run())


@pytest.mark.skipif(not CHROME, reason="no Chrome (CHROME=…)")
def test_the_terminal_drives_a_page_without_a_socket():
    """run.sh's terminal: python -m fsttm_web.chat --serve (a Relay of its own) and the page on a backend
    without a socket (here the stub in the page), its hostLink at /page: lines typed on stdin are the
    person's, the page's rows print on stdout."""
    import sys
    from aiohttp import web
    from fsttm_web.aiohttp import mount

    async def run():
        port, hport = _free_port(), _free_port()
        runner = web.AppRunner(mount(web.Application()))
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", port).start()
        env = {**os.environ, "PYTHONPATH": str(REPO / "python") + os.pathsep + os.environ.get("PYTHONPATH", "")}
        term = await asyncio.create_subprocess_exec(sys.executable, "-m", "fsttm_web.chat", "--serve", str(hport),
                                                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                                                    stderr=asyncio.subprocess.PIPE, env=env)
        prof = tempfile.mkdtemp(prefix="fw-term-chrome-")
        chrome = None
        out, err = [], []

        async def pump(stream, into):
            async for line in stream:
                into.append(line.decode())
        pumps = [asyncio.ensure_future(pump(term.stdout, out)), asyncio.ensure_future(pump(term.stderr, err))]

        async def until(pred, what, timeout=15):
            for _ in range(int(timeout * 10)):
                if pred():
                    return
                await asyncio.sleep(0.1)
            raise AssertionError(f"{what}: stdout {out[-8:]} stderr {err[-8:]}")
        try:
            await until(lambda: any("/page" in l for l in err), "the terminal is up")
            term.stdin.write(b"before any page\n")
            await term.stdin.drain()
            await until(lambda: any("no page yet" in l for l in err), "a line with no page: said so")
            chrome = subprocess.Popen([CHROME, "--headless=new", f"--user-data-dir={prof}", "--no-first-run",
                                       f"http://127.0.0.1:{port}/?backend=stub&voice=0&host=ws://127.0.0.1:{hport}/page"],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            await until(lambda: any("pages open: 1" in l for l in err), "the page connected by itself")
            await until(lambda: any(l.startswith("state ") for l in out), "the state on connect")
            term.stdin.write(b"hello there\n")
            await term.stdin.drain()
            await until(lambda: any("user · host: hello there" in l for l in out), "the typed line, the person's row")
            await until(lambda: any("system · backend: You said: hello there." in l for l in out), "the stub's answer printed")
            term.stdin.write(b"/quiet The door is open.\n/ctl barge_in=energy\n")
            await term.stdin.drain()
            await until(lambda: any("system · host: The door is open." in l for l in out), "her words, as the host's")
            await until(lambda: any(l.startswith("state ") and "barge_in=energy" in l for l in out), "ctl: the state back")
            term.stdin.write(b"/quit\n")
            await term.stdin.drain()
            assert await asyncio.wait_for(term.wait(), 5) == 0
        finally:
            if term.returncode is None:
                term.kill()
                await term.wait()
            for p in pumps:
                p.cancel()
            if chrome:
                try:
                    os.killpg(chrome.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    chrome.wait(5)
                except subprocess.TimeoutExpired:
                    os.killpg(chrome.pid, signal.SIGKILL)
            await runner.cleanup()
            shutil.rmtree(prof, ignore_errors=True)
    asyncio.run(run())
