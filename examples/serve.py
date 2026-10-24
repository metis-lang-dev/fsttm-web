"""The reference page on a Python server, its dialog against a stub backend, and the host's
backchannel at /host. pip install -e 'fsttm-web[aiohttp]'; python examples/serve.py; open
http://localhost:8397/?backend=ws&host — then, at a terminal: python -m fsttm_web.chat ws://localhost:8397/host"""
import sys

from aiohttp import WSMsgType, web

import fsttm_web.protocol as wire
from fsttm_web.aiohttp import host_route, mount
from fsttm_web.chat import Relay

relay = Relay()


async def ws(request):
    sock, backend = web.WebSocketResponse(), wire.Echo()
    await sock.prepare(request)
    relay.add_page(sock.send_json)
    try:
        async for msg in sock:
            if msg.type == WSMsgType.TEXT and (m := wire.parse(msg.data)) and not await relay.from_page(m):
                for f in backend.handle(m):
                    await sock.send_json(f)
    finally:
        relay.drop_page(sock.send_json)
    return sock


def app():
    a = web.Application()
    a.router.add_get("/ws", ws)
    host_route(a, relay)
    mount(a)
    return a


if __name__ == "__main__":
    web.run_app(app(), host="127.0.0.1", port=int(sys.argv[1]) if len(sys.argv) > 1 else 8397)
