"""Mount fsttm_web on an aiohttp application (pip install fsttm-web[aiohttp]).

    from aiohttp import web
    from fsttm_web.aiohttp import mount
    app = web.Application()
    app.router.add_get("/ws", my_ws_handler)    # the backend (fsttm_web.protocol)
    mount(app)                                   # /lib/, /assets/<name>, the reference page at /
    web.run_app(app, port=8080)

Add your own routes (the /ws backend) before mount(): the page's static
route at / is a catch-all prefix.
"""
from aiohttp import web

from . import LIB, WEB, asset

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
