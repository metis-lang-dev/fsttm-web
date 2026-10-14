"""fsttm_web — the FSTTM dialog framework for the browser, as a Python UI
library.

The browser side is lib/ (ES modules, no dependencies): the floor machine
(fsttm.js + fsttm.json), attention (wake/sleep), the dialog (barge-in, echo
rejection, the heard-text cut, resume) and speechSynthesis with the heard
text. This package ships that same lib/ and the reference page (web/), and
mounts them on a Python web server; the page talks to the Python side over
one websocket (fsttm_web.protocol).

    import fsttm_web
    fsttm_web.LIB            # the directory served at /lib/ (the import map's target)
    fsttm_web.WEB            # the reference page
    fsttm_web.asset("dog.gbnf")   # the page's assets/<name>, from their canonical files
    fsttm_web.routes()       # [(url prefix, directory)] for any static server

    from fsttm_web.aiohttp import mount     # pip install fsttm-web[aiohttp]
    mount(app)                               # /lib/, /assets/, and the reference page at /

One source: an installed wheel carries copies made at build time (lib/,
web/, prompt/, grammar/, test/fixtures/); an editable install
(`pip install -e fsttm-web`) reads them from the checkout. Nothing is
copied by hand.
"""
from pathlib import Path

__version__ = "0.2.0"

_PKG = Path(__file__).resolve().parent


def _root():
    """The wheel's own copies when present, else the checkout (editable)."""
    if (_PKG / "lib" / "dialog.js").is_file():
        return None
    root = _PKG.parents[1]                      # fsttm-web/python/fsttm_web → fsttm-web
    if (root / "lib" / "dialog.js").is_file():
        return root
    raise RuntimeError("fsttm_web: lib/ not found beside the package nor in a checkout at %s" % root)


ROOT = _root()
LIB = (ROOT or _PKG) / "lib"
WEB = (ROOT or _PKG) / "web"
_ASSET_DIRS = ([ROOT / "prompt", ROOT / "grammar", ROOT / "test" / "fixtures"] if ROOT else
               [_PKG / "assets" / d for d in ("prompt", "grammar", "fixtures")])

# the reference page's assets/<name> (web/backend/llama.js loadAssets, the
# ?parity corpus): canonical files in prompt/, grammar/, test/fixtures/
ASSETS = {p.name: p for d in _ASSET_DIRS if d.is_dir() for p in sorted(d.iterdir()) if p.is_file()}


def asset(name):
    """The file behind the page's assets/<name>, or None."""
    return ASSETS.get(name)


def routes(page=True):
    """[(url prefix, directory)] for a static server: the library at /lib/,
    and the reference page at / (page=False: the library alone, for an
    application that serves its own page with an import map onto /lib/).
    The assets are files by name (ASSETS), not a directory."""
    out = [("/lib/", LIB)]
    if page:
        out.append(("/", WEB))
    return out


IMPORT_MAP = {
    "imports": {
        "fsttm-web/fsttm": "./lib/fsttm.js",
        "fsttm-web/attention": "./lib/attention.js",
        "fsttm-web/dialog": "./lib/dialog.js",
        "fsttm-web/tts": "./lib/tts.js",
    }
}
"""The import map a page puts in a <script type="importmap"> so its
`import … from 'fsttm-web/dialog'` resolves to the mounted /lib/."""
