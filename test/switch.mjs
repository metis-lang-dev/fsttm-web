// node test/switch.mjs — the header's voice card (lib/switch.js) on a fake DOM: the voice switch in the widget
// (the user, 2026-11-07), following the panel, kept per page, Shift+8 outside a text field.
let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };

class Node_ {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.kids = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this.title = '';
    this.classList = { set: new Set(), add: c => this.classList.set.add(c), remove: c => this.classList.set.delete(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  append(...k) { this.kids.push(...k); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  get textContent() { return this.kids.map(k => typeof k === 'string' ? k : k.textContent).join(''); }
  set textContent(v) { this.kids = [String(v)]; }
}
const doc = new Node_('document');
doc.createElement = t => new Node_(t);
globalThis.document = doc;
const store = new Map();
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
const { voiceWidget, keyMatch } = await import('../lib/switch.js');

function panel(voice = true) {
  const subs = new Set();
  const p = { Recognizer: null, subscribe: f => subs.add(f), toggleMic() {},
    core: { voice, setVoice(on) { this.voice = !!on; for (const f of subs) f({ state: { voice: this.voice, listening: false } }); } } };
  return p;
}
const key = (code, k, o = {}) => ({ code, key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, repeat: false, target: null, prevented: false,
  preventDefault() { this.prevented = true; }, ...o });
const press = e => { for (const f of doc.listeners.keydown || []) f(e); return e; };

ok(keyMatch('Shift+8', key('Digit8', '*', { shiftKey: true })) && !keyMatch('Shift+8', key('Digit8', '8')) && keyMatch('F9', key('F9', 'F9'))
  && !keyMatch('Shift+8', key('Digit8', '*', { shiftKey: true, ctrlKey: true })), 'keyMatch: Shift+8 by the digit key, F9 by name, no other modifier');

{
  const p = panel(true), w = voiceWidget(p, { store: 'fw-voice:test' });
  const labels = w.el.kids.map(k => k.kids.find(x => x.attrs?.class === 'fw-sw-label')?.textContent);
  ok(JSON.stringify(labels) === '["mic","voice"]', `the card: mic, then voice ${JSON.stringify(labels)}`);
  ok(w.voice.state === 'on', 'the voice switch shows the panel\'s voice');
  w.voice.el.onclick();
  ok(p.core.voice === false && w.voice.state === 'off' && store.get('fw-voice:test') === '0', 'a click: the voice off, kept');
  const e = press(key('Digit8', '*', { shiftKey: true }));
  ok(p.core.voice === true && w.voice.state === 'on' && e.prevented && store.get('fw-voice:test') === '1', 'Shift+8: the voice on, kept');
  press(key('Digit8', '*', { shiftKey: true, target: { tagName: 'INPUT' } }));
  ok(p.core.voice === true, 'Shift+8 in a text field: a star typed, the voice left as it is');
  p.core.setVoice(false);
  ok(w.voice.state === 'off', 'the panel\'s voice changed elsewhere (ctl{voice}): the switch follows');
}
{
  store.set('fw-voice:kept', '0');
  doc.listeners.keydown = [];
  const p = panel(true);
  voiceWidget(p, { store: 'fw-voice:kept' });
  ok(p.core.voice === false, 'a page reopened: the voice as it was left');
  const w = voiceWidget(panel(true), { voice: false });
  ok(w.voice === null && w.el.kids.length === 1, 'voice: false leaves the switch out');
}
console.log(`switch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
