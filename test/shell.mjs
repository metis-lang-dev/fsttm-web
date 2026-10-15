// node test/shell.mjs — the consoles' shell (lib/shell.js): the docks and
// the strip on a minimal DOM — header toggles open/collapsed, ✕ hides, the
// strip shows+expands or hides, the layout kept under its key, #right and
// #split hidden when no dock is shown.
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL', m); } };

class El {
  constructor(id, attrs = {}) { this.id = id; this.dataset = attrs.dataset || {}; this.attrs = {}; this.hidden = false; this.style = {};
    this.cls = new Set(); this.kids = []; this.parentElement = null; this.listeners = {}; this.textContent = '';
    this.classList = { toggle: (c, on) => on ? this.cls.add(c) : this.cls.delete(c), contains: c => this.cls.has(c) }; this.tag = attrs.tag || 'div'; }
  add(k) { k.parentElement = this; this.kids.push(k); return k; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(t, f) { this.listeners[t] = f; }
  click(target = this) { this.listeners.click?.({ target }); }
  closest(sel) { for (let e = this; e; e = e.parentElement) if (sel.split(',').some(s => e.matches(s.trim()))) return e; return null; }
  matches(s) { return s === '.' + [...this.cls][0] || s === this.tag || (s.startsWith('.') && this.cls.has(s.slice(1))); }
  querySelector(s) { return this.kids.find(k => k.matches(s)) || null; }
}
const names = ['chat', 'catalog'];
const byId = {}, headers = [], strips = [];
for (const id of ['right', 'split', 'left']) byId['#' + id] = new El(id);
for (const d of names) {
  const dock = new El('dock-' + d, { dataset: { dock: d } }); byId['#dock-' + d] = dock;
  const h = dock.add(new El('', { tag: 'header' }));
  const tw = h.add(new El('')); tw.cls.add('tw'); dock.kids.push(tw);
  const x = h.add(new El('', { tag: 'button' })); x.cls.add('x');
  headers.push(h);
  const b = new El('', { dataset: { strip: d } }); strips.push(b); byId[`[data-strip="${d}"]`] = b;
}
const mem = {};
globalThis.localStorage = { getItem: k => k in mem ? mem[k] : null, setItem: (k, v) => { mem[k] = v; } };
globalThis.document = {
  querySelector: s => byId[s] || null,
  querySelectorAll: s => s === '.dock>header' ? headers : s === '[data-strip]' ? strips : [],
};
await import('../lib/shell.js');
const S = globalThis.MetisShell;
ok(S && typeof S.docks === 'function' && typeof S.splitter === 'function', 'MetisShell is set');

const ui = S.docks({ names, key: 't.docks.v1', defaults: { chat: { shown: true, open: true }, catalog: { shown: true, open: false } } });
ui.apply();
const d = n => byId['#dock-' + n];
ok(d('chat').cls.has('open') && d('catalog').cls.has('collapsed'), 'defaults: chat open, catalog collapsed');
ok(strips[0].attrs['aria-pressed'] === 'true' && !byId['#right'].hidden, 'strip pressed, the right side shown');
headers[1].click(headers[1]);
ok(d('catalog').cls.has('open') && d('catalog').querySelector('.tw').textContent === '▾', 'the header expands');
headers[0].click(headers[0].kids[1]);
ok(d('chat').hidden && strips[0].attrs['aria-pressed'] === 'false', '✕ hides');
strips[1].click();
ok(d('catalog').hidden && byId['#right'].hidden && byId['#split'].hidden, 'every dock hidden: #right and #split hide');
strips[0].click();
ok(!d('chat').hidden && d('chat').cls.has('open') && !byId['#right'].hidden, 'the strip shows and expands');
ok(JSON.parse(mem['t.docks.v1']).chat.shown === true && JSON.parse(mem['t.docks.v1']).catalog.shown === false, 'the layout kept under its key');
const again = S.docks({ names, key: 't.docks.v1', defaults: {} });
ok(again.state.chat.shown && !again.state.catalog.shown, 'a reload reads the kept layout');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
