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
    for name, src in [("dog.gbnf", "grammar"), ("dog-prompt.txt", "prompt"), ("dog-corpus.tsv", "test/fixtures")]:
        assert fsttm_web.asset(name).resolve() == (REPO / src / name).resolve()
    assert fsttm_web.routes(page=False) == [("/lib/", fsttm_web.LIB)]
    assert set(fsttm_web.IMPORT_MAP["imports"]) == {"fsttm-web/fsttm", "fsttm-web/attention", "fsttm-web/dialog", "fsttm-web/tts",
                                                     "fsttm-web/shell"}
    assert all(f.is_file() and f.parent == fsttm_web.LIB for f in fsttm_web.SHELL)


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
            for path in ["/", "/lib/dialog.js", "/lib/fsttm.json", "/assets/dog.gbnf", "/app.js", "/backend/ws.js"]:
                assert (await c.get(path)).status == 200, path
            assert (await c.get("/assets/nope")).status == 404
            assert "importmap" in await (await c.get("/")).text()
            w = await c.ws_connect("/ws")
            await w.send_json({"ev": "say_text", "id": "s-t1", "text": "sit", "mode": "intent"})
            assert (await w.receive_json())["voice"] == "You said: sit."
            await w.close()
    asyncio.run(run())
