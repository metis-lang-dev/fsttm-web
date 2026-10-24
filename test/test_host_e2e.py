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
            await chat.user("hello there")
            u = await chat.expect(ev="chat", who="user", timeout=10)
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
