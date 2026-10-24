// panel.js — the dialog as a widget panel: the one voice/text input (the mic, the text
// line, the floor and the input's mode) and the intent chat (what was heard or typed,
// the intent the backend made of it, the backend's words), over the library's floor
// (dialog.js) and its wire (ws.js, or any adapter with the same turn/cut/heard).
//
//   const panel = new Panel(document.getElementById('dock'), { backend, table });
//   window.say = text => panel.say(text);       // the panel's public entry
//
// One entry for every input. A typed line, a recognized utterance and panel.say(text)
// (a script, a test, a backend's own text socket) all take the same path: the floor's
// final(), then a turn on the backend; the mode, the floor and the channel rules apply
// to each alike.
//
// Two channels. The backend is the main one. A page with a second consumer of the
// voice (another agent's chat, say) gives `side: { label, send(text, { id }) → words }`.
// flip() moves the input between the two; hold() / release() is the quasimode (the
// side channel only while a key is held: push-to-talk). onChannel tells the page. The
// page's own state of the input (a mode its rules keep, e.g. dictation) is shown with
// setMode(text).
//
// PanelCore is the logic (no DOM: node tests drive it, test/panel.mjs); Panel renders
// it into an element the page gives (a dock, a sidebar), with lib/panel.css.

import { FSTTM } from './fsttm.js';
import { Attention } from './attention.js';
import { Dialog, attachRecognizer, cancelledMic } from './dialog.js';
import { BrowserTTS, splitSentences } from './tts.js';

export class PanelCore {
  // backend: turn(id, text, mode, {signal}) → sentences, cut(id, heard), heard(id, text),
  //   info[id].json (the intent's JSON, when the backend has one) and an onFrame slot;
  // table: lib/fsttm.json; tts: BrowserTTS-like; side: { label, send }
  // onRow(row), onState(state): the view's; onFrame(frame): a frame the panel does not
  // know (the application's own); log(kind, fields): every dialog event
  constructor({ backend, table, tts = null, attention = null, side = null, bargeIn = 'words', voice = true,
    stopWords, onRow = () => {}, onState = () => {}, onFrame = () => {}, onChannel = () => {}, log = () => {},
    now, dialog = null, maxRows = 300 }) {
    Object.assign(this, { backend, side, voice, onRow, onState, onFrame, onChannel, log, maxRows });
    this.rows = [];
    this.floor = 'FREEs';
    this.channel = 'main';
    this.held = false;           // the quasimode: the side channel while held
    this.mode = '';              // the page's word for its input's mode
    this.listening = false;
    this.via = null;             // the source of the final in progress: text | voice | say (the dialog calls turn() inside final(), synchronously)
    this.turns = new Map();      // dialog turn id → { person, agent } rows
    this.tts = tts ?? new BrowserTTS();
    this.dialog = dialog ?? new Dialog({
      fsttm: new FSTTM(table, now ? { now } : {}), attention: attention ?? new Attention({ enabled: false, startAsleep: false }),
      tts: this.tts, bargeIn, ...(stopWords ? { stopWords } : {}), ...(now ? { now } : {}),
      log: (k, f) => this.event(k, f),
      llm: (text, o) => this.turn(text, o),
      onHeard: (id, heard) => this.heard(id, heard),
    });
    if (backend && 'onFrame' in backend) backend.onFrame = f => this.frame(f);
  }

  state() {
    return { floor: this.floor, channel: this.channel, held: this.held, mode: this.mode, listening: this.listening,
      voice: this.voice, side: this.side?.label ?? null };
  }
  changed() { this.onState(this.state()); }

  row(r) {
    const row = { n: (this.rows.at(-1)?.n ?? 0) + 1, tags: [], ...r };
    this.rows.push(row);
    if (this.rows.length > this.maxRows) this.rows.splice(0, this.rows.length - this.maxRows);
    while (this.turns.size > this.maxRows) this.turns.delete(this.turns.keys().next().value);
    this.onRow(row, 'add');
    return row;
  }
  tag(row, t) { if (row) { row.tags.push(t); this.onRow(row, 'tag'); } }

  // ── the input ───────────────────────────────────────────────────────────
  // say: the public entry (a typed line, a script, a backend's text socket)
  say(text, { via = 'say' } = {}) {
    text = String(text ?? '').trim();
    if (!text) return Promise.resolve();
    this.via = via;                // an utterance the floor drops (a stop phrase, an echo) never reaches turn(): nothing to undo
    try { return this.dialog.final(text); } finally { this.via = null; }
  }
  // listen: the mic, a SpeechRecognition (new SR()); what it finalizes goes down say().
  // opts.stream: the echo-cancelled mic (cancelledMic()) the recognizer listens to — her
  // voice never reaches it, and the dialog's textual echo rejection is off; unlisten stops it
  listen(rec, { stream = null, ...opts } = {}) {
    if (this.recognizer) return;
    const core = this, dialog = this.dialog;
    this.stream = stream;
    this.recognizer = attachRecognizer(rec, {
      speechStart: () => dialog.speechStart(),
      interim: t => dialog.interim(t),
      final: t => core.say(t, { via: 'voice' }),
      log: (k, f) => dialog.log(k, f),
      set textEcho(v) { dialog.textEcho = v; },
      get textEcho() { return dialog.textEcho; },
    }, { ...opts, track: stream?.getAudioTracks()[0] ?? null });
    this.listening = true;
    this.changed();
  }
  unlisten() {
    this.recognizer?.stop();
    this.recognizer = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    this.listening = false;
    this.changed();
  }
  setVoice(on) { this.voice = !!on; if (!on) this.tts.cancel?.(); this.changed(); }
  setMode(mode) { this.mode = mode ?? ''; this.changed(); }

  // ── the channels ────────────────────────────────────────────────────────
  setChannel(ch) {
    if (ch === 'side' && !this.side) return false;
    if (ch === this.channel) return true;
    this.channel = ch;
    this.onChannel(ch, this.held ? 'held' : 'flip');
    this.changed();
    return true;
  }
  flip() { return this.setChannel(this.channel === 'main' ? 'side' : 'main'); }
  // hold / release: the quasimode — the side channel while a key is held, back on release
  hold() {
    if (this.held || !this.side) return false;
    this.held = true;
    this.before = this.channel;
    this.setChannel('side');
    this.changed();
    return true;
  }
  release() {
    if (!this.held) return false;
    this.held = false;
    this.setChannel(this.before ?? 'main');
    this.changed();
    return true;
  }

  // ── a turn ───────────────────────────────────────────────────────────────
  // the dialog's llm: the utterance went past the floor, the echo and attention rules
  async turn(text, { id, signal } = {}) {
    const via = this.via ?? 'say';
    const ch = this.channel;
    const person = this.row({ who: 'person', text, via, channel: ch, turn: id });
    const t0 = performance.now();
    let words = '', agent = null;
    try {
      if (ch === 'side') {
        words = String(await this.side.send(text, { id, signal }) ?? '');
        if (words) agent = this.row({ who: 'agent', text: words, channel: 'side', turn: id });
      } else {
        const sentences = [];
        for await (const s of this.backend.turn(id, text, 'intent', { signal })) sentences.push(s);
        const json = this.backend.info?.[id]?.json;
        if (json) this.row({ who: 'intent', text: json, turn: id });
        words = sentences.join(' ');
        if (words) agent = this.row({ who: 'agent', text: words, channel: 'main', turn: id });
      }
    } catch (e) {
      if (signal?.aborted) throw e;
      this.row({ who: 'note', text: `${ch === 'side' ? this.side.label : 'the backend'}: ${e.message ?? e}`, turn: id });
      throw e;
    }
    this.turns.set(id, { person, agent });
    return { voice: this.voice ? words : '', firstMs: performance.now() - t0 };
  }

  // ── the backend's own frames ─────────────────────────────────────────────
  frame(f) {
    if (f.ev === 'narration') {
      const text = f.sentence ?? f.line ?? '';
      if (!text) return;
      const row = this.row({ who: 'agent', text, channel: 'main', narration: f.kind ?? true, form: f.form });
      const key = `n:${f.id}`;
      this.turns.set(key, { agent: row });
      if (this.voice && f.form !== 'R') this.dialog.say(splitSentences(text), 'narration', key);
      return;
    }
    this.onFrame(f);
  }

  heard(id, heard) {
    if (id?.startsWith('n:')) this.backend?.heard?.(id.slice(2), heard);
    else if (id && this.turns.get(id)?.person?.channel !== 'side') this.backend?.cut?.(id, heard);   // the side channel's words are not the backend's
  }

  // the dialog's events: the floor, what was spoken, a cut
  event(kind, f = {}) {
    if (kind === 'fsttm') { this.floor = f.dst; this.changed(); }
    else if (kind === 'speak') {
      this.speaking = this.turns.get(this.dialog.speakingId)?.agent ?? null;
      this.tag(this.speaking, 'spoken');
    } else if (kind === 'cut') {
      this.tag(this.speaking, `cut · heard "${f.heard ?? ''}"${f.estimated ? ' (estimated)' : ''}`);
    }
    this.log(kind, f);        // the page's: keyword_stop (a stop phrase never reaches turn()), echo, …
  }
}

// holdable: may a held key at this focus be push-to-talk? Not where the key has a meaning
// of its own — typing (a text field, an editable) or activation (Space clicks a button, a
// link, a summary, a checkbox; a widget with such a role) — so the keyboard keeps working
export function holdable(el) {
  if (!el || el.isContentEditable) return !el;
  const tag = (el.tagName ?? '').toUpperCase();
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY', 'OPTION'].includes(tag)) return false;
  if (tag === 'A' && el.hasAttribute?.('href')) return false;
  const role = el.getAttribute?.('role') ?? '';
  return !['button', 'checkbox', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'link', 'radio', 'textbox', 'combobox', 'slider', 'spinbutton'].includes(role);
}

// ── the view ──────────────────────────────────────────────────────────────
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e[k] = v; else if (v != null && v !== false) e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : String(c));
  return e;
};

export class Panel {
  // root: the element the panel fills; opts: PanelCore's, plus
  //   flipKey ('ctrl+space' by default: flip the channel), holdKey (' ': push-to-talk
  //   when held holdMs and the focus is holdable(): not a text field, not a control the key
  //   activates; null: none), holdMs (400),
  //   Recognizer (window.SpeechRecognition ?? webkitSpeechRecognition), title,
  //   mic (cancelledMic: the echo-cancelled mic the recognizer listens to; null: the raw
  //   mic, her voice dropped by text); the page's onRow / onState are called after the
  //   view has drawn
  constructor(root, opts = {}) {
    const { flipKey = 'ctrl+space', holdKey = ' ', holdMs = 400, title = 'dialog',
      Recognizer = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition, mic = cancelledMic,
      onRow = () => {}, onState = () => {}, ...core } = opts;
    Object.assign(this, { root, flipKey, holdKey, holdMs, Recognizer, mic });
    this.rowEl = new Map();
    this.core = new PanelCore({ ...core,                       // the page's onRow / onState after the view's
      onRow: (r, how) => { this.drawRow(r, how); onRow(r, how); }, onState: s => { this.drawState(s); onState(s); } });
    root.classList.add('fw-panel');
    this.dom = {
      floor: el('span', { class: 'fw-floor' }), mode: el('span', { class: 'fw-mode' }), channel: el('span', { class: 'fw-channel' }),
      log: el('ol', { class: 'fw-log', 'aria-live': 'polite', 'aria-label': 'the dialog' }),
      text: el('input', { class: 'fw-text', type: 'text', autocomplete: 'off', placeholder: 'say or type', 'aria-label': 'say or type' }),
      mic: el('button', { class: 'fw-mic', type: 'button', 'aria-pressed': 'false' }, 'mic'),
      voice: el('input', { type: 'checkbox', checked: this.core.voice }),
    };
    const d = this.dom;
    const form = el('form', { class: 'fw-input' }, d.mic, d.text, el('label', { class: 'fw-voice' }, d.voice, ' voice'));
    root.replaceChildren(
      el('div', { class: 'fw-bar' }, el('span', { class: 'fw-title' }, title), d.channel, d.mode, d.floor),
      d.log, form);
    form.onsubmit = e => { e.preventDefault(); const t = d.text.value; d.text.value = ''; this.core.say(t, { via: 'text' }); };
    d.mic.onclick = () => this.toggleMic();
    d.voice.onchange = () => this.core.setVoice(d.voice.checked);
    if (!this.Recognizer) { d.mic.disabled = true; d.mic.title = 'no SpeechRecognition in this browser'; }
    this.keys();
    this.drawState(this.core.state());
  }

  say(text) { return this.core.say(text); }
  setMode(m) { this.core.setMode(m); }
  flip() { return this.core.flip(); }
  note(text) { return this.core.row({ who: 'note', text }); }
  async toggleMic() {
    if (this.core.listening) return this.core.unlisten();
    if (!this.Recognizer || this.opening) return;
    this.opening = true;
    try {
      const stream = this.mic ? await this.mic().catch(() => null) : null; // refused or absent: the raw mic
      this.core.listen(new this.Recognizer(), { stream });
      if (!this.core.recognizer?.track) this.note('the mic without the echo canceller: her voice reaches the recognizer, dropped by text');
    } finally { this.opening = false; }
  }

  keys() {
    const k = this.flipKey?.toLowerCase().split('+') ?? [];
    const flip = e => k.length && e.ctrlKey === k.includes('ctrl') && e.altKey === k.includes('alt')
      && e.shiftKey === k.includes('shift') && (e.key === ' ' ? 'space' : e.key.toLowerCase()) === k[k.length - 1];

    let timer = null;
    document.addEventListener('keydown', e => {
      if (flip(e)) { e.preventDefault(); this.core.flip(); return; }
      if (this.holdKey == null || e.key !== this.holdKey || e.ctrlKey || e.altKey || e.metaKey || !holdable(document.activeElement)) return;
      e.preventDefault();                       // the page does not scroll while the key may become a hold
      if (e.repeat || timer || this.core.held) return;
      timer = setTimeout(() => { timer = null; this.core.hold(); }, this.holdMs);
    });
    document.addEventListener('keyup', e => {
      if (e.key !== this.holdKey) return;
      if (timer) { clearTimeout(timer); timer = null; }   // a tap, not a hold
      else this.core.release();
    });
    window.addEventListener('blur', () => { if (timer) { clearTimeout(timer); timer = null; } this.core.release(); });
  }

  drawState(s) {
    const d = this.dom;
    d.floor.textContent = s.floor;
    d.floor.title = 'the floor';
    d.mode.textContent = s.mode;
    d.mode.hidden = !s.mode;
    d.channel.textContent = s.channel === 'side' ? `→ ${s.side}${s.held ? ' (held)' : ''}` : '';
    d.channel.hidden = s.channel !== 'side';
    this.root.dataset.channel = s.channel;
    d.mic.textContent = s.listening ? 'mic on' : 'mic';
    d.mic.setAttribute('aria-pressed', String(s.listening));
    d.voice.checked = s.voice;
  }

  drawRow(r, how) {
    let li = this.rowEl.get(r.n);
    if (!li) {
      const who = r.who === 'person' ? (r.via === 'voice' ? 'heard' : r.via === 'text' ? 'typed' : 'said')
        : r.who === 'intent' ? 'intent' : r.who === 'agent' ? (r.narration ? 'unasked' : r.channel === 'side' ? this.core.side?.label ?? 'side' : 'reply') : 'note';
      li = el('li', { class: `fw-row fw-${r.who}${r.channel === 'side' ? ' fw-side' : ''}` },
        el('span', { class: 'fw-who' }, who), el(r.who === 'intent' ? 'code' : 'span', { class: 'fw-text' }, r.text),
        el('span', { class: 'fw-tags' }));
      this.rowEl.set(r.n, li);
      const box = this.dom.log, end = box.scrollTop + box.clientHeight >= box.scrollHeight - 4;
      box.append(li);
      while (box.children.length > 300) { this.rowEl.delete(Number(box.firstChild.dataset.fwRow)); box.firstChild.remove(); }
      li.dataset.fwRow = r.n;                   // data-fw-row: a page's own data-* never meets the panel's
      if (end) box.scrollTop = box.scrollHeight;
    }
    if (how === 'tag') li.querySelector('.fw-tags').replaceChildren(...r.tags.map(t => el('span', { class: 'fw-tag' }, t)));
  }
}
