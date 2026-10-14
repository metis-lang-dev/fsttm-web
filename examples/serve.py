"""The reference page on a Python server, its dialog against a stub backend.
pip install -e 'fsttm-web[aiohttp]'; python examples/serve.py; open http://localhost:8397/?backend=ws"""
import sys

from aiohttp import WSMsgType, web

import fsttm_web.protocol as wire
from fsttm_web.aiohttp import mount


async def ws(request):
    sock, backend = web.WebSocketResponse(), wire.Echo()
    await sock.prepare(request)
    async for msg in sock:
        if msg.type == WSMsgType.TEXT and (m := wire.parse(msg.data)):
            for f in backend.handle(m):
                await sock.send_json(f)
    return sock

app = web.Application()
app.router.add_get("/ws", ws)
mount(app)
web.run_app(app, host="127.0.0.1", port=int(sys.argv[1]) if len(sys.argv) > 1 else 8397)
