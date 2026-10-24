"""Mount fsttm_web on an aiohttp application (pip install fsttm-web[aiohttp]).

    from aiohttp import web
    from fsttm_web.aiohttp import mount
    app = web.Application()
    app.router.add_get("/ws", my_ws_handler)    # the backend (fsttm_web.protocol)
    mount(app)                                   # /lib/, /assets/<name>, the reference page at /
    web.run_app(app, port=8080)

Add your own routes (the /ws backend) before mount(): the page's static
route at / is a catch-all prefix.

The host's backchannel from another process (fsttm_web.chat): a Relay joins the pages' sockets
and the hosts'. The page's handler adds its socket and hands it the host frames; host_route
serves the hosts at /host (Chat.connect, python -m fsttm_web.chat ws://…/host):

    relay = Relay()
    async def my_ws_handler(request):
        sock = web.WebSocketResponse(); await sock.prepare(request)
        relay.add_page(sock.send_json)
        async for msg in sock:
            m = wire.parse(msg.data)
            if m and not await relay.from_page(m):
                ...                                  # the backend's frames
        relay.drop_page(sock.send_json)
        return sock
    host_route(app, relay)
"""
from aiohttp import WSMsgType, web

from . import LIB, WEB, asset
from . import protocol as wire

_NO_CACHE = {"Cache-Control": "no-store"}


def mount(app, page=True, extra_assets=None):
    """The library at /lib/, the page's assets by name at /assets/<name>
    (extra_assets: {name: path} beside the canonical ones, e.g. a corpus of
    WAVs as {"corpus-wav": dir}), and — page=True — the reference page at /."""
    extra = dict(extra_assets or {})

    async def assets(request):
        name = request.match_info["name"]
        head, _, rest = name.partition("/")
        if head in extra:
            base = extra[head]
            p = (base / rest) if rest else base
            if not p.resolve().is_relative_to(base.resolve()):
                raise web.HTTPForbidden()
        else:
            p = asset(name)
        if p is None or not p.is_file():
            raise web.HTTPNotFound()
        return web.FileResponse(p, headers=_NO_CACHE)

    app.router.add_get("/assets/{name:.+}", assets)
    app.router.add_static("/lib/", LIB, append_version=False)
    if page:
        async def index(request):
            return web.FileResponse(WEB / "index.html", headers=_NO_CACHE)
        app.router.add_get("/", index)
        app.router.add_static("/", WEB, append_version=False)
    return app


def host_route(app, relay, path="/host"):
    """The hosts' side of a Relay (fsttm_web.chat): each host socket at path sends chat/ctl to the
    pages and hears their chat/event/state."""
    async def host(request):
        sock = web.WebSocketResponse(heartbeat=30)
        await sock.prepare(request)
        relay.add_host(sock.send_json)
        try:
            async for msg in sock:
                if msg.type == WSMsgType.TEXT and (m := wire.parse(msg.data)) and m["ev"] in ("chat", "ctl"):
                    if not await relay.from_host(m):
                        await sock.send_json(wire.error("", "no page on the backend's socket"))
        finally:
            relay.drop_host(sock.send_json)
        return sock
    app.router.add_get(path, host)
    return app
