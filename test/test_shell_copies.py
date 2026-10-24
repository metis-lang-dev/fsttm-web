"""The reference page's shell: web/vendor/shell.css + shell.js are this repo's copies of the consoles'
common web style (metis-loop console/lib/shell.*, the origin; metis-agent console/shell.*; metis-worlds
web/vendor/shell.*; the copies rule of shell-copy s-7c739dd7). Each copy's first comment names its own
repo; the code below it is the same. A checkout not beside this one is skipped."""
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
WEB = ROOT / "web"


def sibling(*parts):
    d = ROOT
    for _ in range(5):
        d = d.parent
        c = d.joinpath(*parts)
        if c.exists():
            return c
    return None


def code(p):
    """The file past its first comment block."""
    text = Path(p).read_text()
    return text[text.index("*/") + 2:] if text.lstrip().startswith("/*") else text


@pytest.mark.parametrize("name", ["shell.css", "shell.js"])
@pytest.mark.parametrize("other", [("metis-loop", "console", "lib"), ("metis-agent", "console"), ("metis-worlds", "web", "vendor")])
def test_the_shell_is_the_consoles(name, other):
    o = sibling(*other, name)
    if o is None:
        pytest.skip("no %s checkout beside this one" % other[0])
    assert code(WEB / "vendor" / name) == code(o), "web/vendor/%s differs from %s past its header: copy the consoles' code" % (name, o)


def test_the_page_loads_the_shell():
    html = (WEB / "index.html").read_text()
    assert 'href="vendor/shell.css"' in html and 'src="vendor/shell.js"' in html
    for d in ("dialog",):
        assert re.search(r'class="dock" id="dock-%s" data-dock="%s"' % (d, d), html) and 'data-strip="%s"' % d in html
