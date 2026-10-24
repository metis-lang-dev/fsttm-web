// narrator.js — a floor-independent narration stream: the page's selected text
// read aloud sentence by sentence, on one page-wide key (narrator s-4fa5f66e).
//
//   const narrator = new Narrator({ tts, synth, rate });   // tts: the dialog's BrowserTTS (voice, rate, and the yield)
//   attachSelection(narrator, document);                    // a new selection resets the narrator to it
//   attachKey(narrator, document, { key: 'F8' });           // press: start / pause / resume (on from the word) · long or double press: stop
//   narrator.onchange = s => …                              // {state, i, n, sentence, text}: the indicator
//
// The narrator never takes the floor and never touches the floor machine: it
// owns its utterances (one per sentence, the cursor advanced on onend) and
// YIELDS to the dialog, whose BrowserTTS it wraps: before the dialog speaks it
// pauses (state 'yielding'), after the dialog's onend it resumes at its cursor;
// a barge-in cancel() of the dialog's speech, which empties the synth's whole
// queue, re-queues the narrator's current sentence rather than losing it.
// States: stopped · reading · paused · yielding (reading, held for the dialog).
import { splitSentences } from './tts.js';

export class Narrator {
  constructor({ tts = null, synth = tts?.synth ?? globalThis.speechSynthesis, rate = null, min = 1 } = {}) {
    this.tts = tts;
    this.synth = synth;
    this.rate = rate;          // null: the dialog's rate
    this.min = min;            // splitSentences' minimum (1: every sentence its own utterance)
    this.text = '';
    this.sentences = [];
    this.i = 0;                // the cursor: the sentence to read next
    this.from = 0;             // … and where in it: a pause or a yield resumes at the word it reached
    this.charsPerMs = null;    // measured on our own finished utterances (null: the dialog's, at our rate)
    this.state = 'stopped';
    this.onchange = null;
    this.gen = 0;              // the utterance generation: an end of an older one is ignored
    this.u = null;             // the utterance being read
    this.dialogSpeaking = false;
    if (tts) this._wrap(tts);
  }

  get n() { return this.sentences.length; }
  get sentence() { return this.sentences[this.i] ?? ''; }
  snapshot() { return { state: this.state, i: this.i, n: this.n, sentence: this.sentence, text: this.text }; }
  _set(state) { this.state = state; this.onchange?.(this.snapshot()); }

  // select: a new non-empty text resets the narrator to it, stopped at its
  // first sentence (the same text, or an empty one, changes nothing)
  select(text) {
    const t = (text ?? '').replace(/\s+/g, ' ').trim();      // a selection across elements carries newlines and tabs
    if (!t || t === this.text) return false;
    this._cut();
    this.text = t;
    this.sentences = splitSentences(t, this.min);
    this.i = 0;
    this.from = 0;
    this._set('stopped');
    return true;
  }

  // press: stopped → reading · reading → paused (cut at the word being read; a
  // resume reads on from that word) · paused → reading · yielding → paused
  press() {
    if (!this.n) return;
    if (this.state === 'reading') { this._hold(); this._set('paused'); return; }
    if (this.state === 'yielding') { this._set('paused'); return; }
    if (this.i >= this.n) { this.i = 0; this.from = 0; }   // read it again from the top
    if (this._busy()) { this._set('yielding'); return; }
    this._set('reading');
    this._speak();
  }

  // stop: a long press or a double press — silent, the cursor back at the top
  stop() { this._cut(); this.i = 0; this.from = 0; this._set('stopped'); }

  // the dialog is speaking: its BrowserTTS's chain (its cur), not a flag — a speak over a
  // speaking dialog cancels the old chain (whose onend(false) would clear a flag) and
  // queues the new one in the same tick (opus's review of step 1)
  _busy() { return this.tts ? this.tts.speaking : this.dialogSpeaking; }

  _cut() {
    this.gen++;
    if (this.u) { this.u = null; this.synth.cancel(); }
  }
  // where the utterance being read has got to, in its sentence: the word onboundary named, else
  // by the time spoken (as the dialog's heard text, tts.js), back to that word's start
  _reached() {
    const u = this.u;
    if (!u) return this.from;
    const s = this.sentences[this.i] ?? '';
    let at = u.char;
    if (!u.bounded) {
      const rate = this.rate ?? this.tts?.rate ?? 1, base = (this.tts?.charsPerMs ?? 0.014) * rate / (this.tts?.rate ?? 1);
      at = u.startedAt ? Math.round((performance.now() - u.startedAt) * (this.charsPerMs ?? base)) : 0;
    }
    const pos = Math.min(s.length, u.from + at);
    if (pos >= s.length) return s.length;
    return Math.max(u.from, s.lastIndexOf(' ', pos) + 1);    // the start of the word being read
  }
  // hold: cut where it got to; the next _speak() reads on from there (the sentence's end: the next one)
  _hold() {
    if (this.u) {
      const at = this._reached();
      if (at >= (this.sentences[this.i] ?? '').length) { this.i++; this.from = 0; } else this.from = at;
    }
    this._cut();
  }

  _speak() {
    if (this.state !== 'reading') return;
    if (this.i >= this.n) { this.u = null; this._set('stopped'); return; }    // read to the end
    const gen = ++this.gen;
    const from = this.from;
    const text = this.sentences[this.i].slice(from);
    const u = new SpeechSynthesisUtterance(text);
    Object.assign(u, { from, char: 0, bounded: false, startedAt: null });
    if (this.tts?.voice) u.voice = this.tts.voice;
    u.rate = this.rate ?? this.tts?.rate ?? 1;
    // the dialog's echo window sees what is read: tts.narrating while a sentence is said, tts.onnarrated(text) when it ends
    if (this.tts) this.tts.narrating = text;
    const said = () => { if (this.tts?.narrating === text) { this.tts.narrating = null; this.tts.onnarrated?.(text); } };
    u.onstart = () => { u.startedAt = performance.now(); };
    u.onboundary = e => { u.bounded = true; u.char = e.charIndex ?? u.char; };
    u.onend = () => {
      said();
      if (gen !== this.gen) return;
      const ms = u.startedAt ? performance.now() - u.startedAt : 0;
      if (ms > 300) this.charsPerMs = text.length / ms;
      this.u = null; this.i++; this.from = 0; this.onchange?.(this.snapshot()); this._speak();
    };
    u.onerror = e => { said(); if (gen !== this.gen) return; this.u = null;    // interrupted/canceled: not ours to advance on
      if (e?.error === 'interrupted' || e?.error === 'canceled') return; this.i++; this.from = 0; this._speak(); };
    this.u = u;
    this.synth.speak(u);
    this.onchange?.(this.snapshot());
  }

  // the dialog's speech, seen through its BrowserTTS: speak() and cancel()
  _wrap(tts) {
    const speak = tts.speak.bind(tts), cancel = tts.cancel.bind(tts);
    tts.speak = (sentences, opts = {}) => {
      this.dialogSpeaking = true;
      if (this.state === 'reading') { this._hold(); this._set('yielding'); }  // before the dialog's utterance is queued; resumed at the word
      const r = speak(sentences, { ...opts, onend: completed => { opts.onend?.(completed); this._dialogEnd(); } });
      this.dialogSpeaking = true;                                              // the old chain's onend(false) ran inside speak
      return r;
    };
    tts.cancel = () => {
      const had = tts.cur !== null;                                            // an idle cancel touches no synth (tts.js)
      const heard = cancel();                                                   // else the synth's whole queue is gone
      if (!had) return heard;
      if (this.u) { const at = this._reached(); this.from = at < (this.sentences[this.i] ?? '').length ? at : 0;
        if (!this.from && at) this.i++; this.u = null; this.gen++; }           // our sentence with it: re-queued at its word, not lost
      if (this.state === 'reading') this._set('yielding');                      // the dialog's onend(false) resumes it
      return heard;
    };
  }

  _dialogEnd() {
    this.dialogSpeaking = false;
    if (this.state !== 'yielding') return;
    // the dialog may speak again at once (a resume, a chain): resume only when the synth is free
    const back = () => { if (this.state !== 'yielding' || this._busy()) return; this._set('reading'); this._speak(); };
    typeof queueMicrotask === 'function' ? queueMicrotask(back) : setTimeout(back, 0);
  }
}

// attachSelection: selectionchange (debounced: a drag changes it continuously)
// → narrator.select(the selection's text)
export function attachSelection(narrator, doc = document, { debounce = 150 } = {}) {
  let t = null;
  const h = () => { clearTimeout(t); t = setTimeout(() => narrator.select(doc.getSelection?.()?.toString() ?? ''), debounce); };
  doc.addEventListener('selectionchange', h);
  return () => { clearTimeout(t); doc.removeEventListener('selectionchange', h); };
}

// attachKey: one page-wide key. A press (keyup within `long` ms) acts at once;
// a second press within `double` ms, or a hold of `long` ms, stops.
export function attachKey(narrator, target = document, { key = 'F8', long = 600, double = 300 } = {}) {
  let downAt = null, lastUp = -Infinity, holdTimer = null;   // -Infinity: a first press within `double` ms of load is no double (opus)
  const down = e => {
    if (e.key !== key || e.repeat) return;
    e.preventDefault();
    downAt = performance.now();
    holdTimer = setTimeout(() => { holdTimer = null; downAt = null; narrator.stop(); }, long);
  };
  const up = e => {
    if (e.key !== key) return;
    e.preventDefault();
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    if (downAt === null) return;                                  // the hold already stopped it
    downAt = null;
    const now = performance.now();
    if (now - lastUp < double) { lastUp = 0; narrator.stop(); return; }
    lastUp = now;
    narrator.press();
  };
  target.addEventListener('keydown', down);
  target.addEventListener('keyup', up);
  return () => { target.removeEventListener('keydown', down); target.removeEventListener('keyup', up); };
}

// NarratorView: the indicator — the state, n of N, the current sentence
export function narratorView(el, narrator, { key = 'F8' } = {}) {
  el.classList.add('narrator');
  el.innerHTML = `<span class="narrator-state"></span><span class="narrator-pos"></span><span class="narrator-sentence"></span>`;
  const [st, pos, sen] = el.children;
  const WORDS = { stopped: 'narrator', reading: 'reading', paused: 'paused', yielding: 'yielding' };
  const render = s => {
    el.dataset.state = s.state;
    el.title = `${key}: start / pause / resume · hold or double ${key}: stop · select text to reset`;
    st.textContent = WORDS[s.state];
    pos.textContent = s.n ? `${Math.min(s.i + 1, s.n)} of ${s.n}` : 'select text';
    sen.textContent = s.state === 'stopped' && !s.n ? '' : s.sentence;
  };
  narrator.onchange = render;
  render(narrator.snapshot());
  return render;
}
