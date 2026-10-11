// dialog.js — the dialog agent in the browser (DESIGN.md §3–4): browser
// signals → FSTTM actions, attention in front, barge-in by policy, textual
// echo rejection, and the heard-text record of every system turn.
//
// It is pure logic over injected parts, so the §3 table is verified with
// scripted signals in node and in Chrome alike; attachRecognizer() wires a
// real SpeechRecognition to the same entry points.
//
//   recognizer → speechStart() · interim(text) · final(text)
//   tts        → BrowserTTS-like: speak(sentences,{onstart,onend}) · cancel() → heard · sentence · speaking
//   llm        → async (text, {signal}) → {voice, firstMs}
//   log        → bench.js (kind, fields)

import { splitSentences } from './tts.js';

export const STOP_WORDS = ['stop', 'halt', 'freeze', 'quiet'];

// keywordStop: at most three words, one of them a stop word (the harness's
// F12 rule; here it also runs on interims).
export function keywordStop(text, words = STOP_WORDS) {
  const w = text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return w.length > 0 && w.length <= 3 && w.some(x => words.includes(x));
}

const toks = s => (s.toLowerCase().match(/[a-z0-9']+/g) ?? []);

// userWords: the words of a transcript that are not the system's own
// speech. The measured case (Chrome 154, on-device en-US, laptop speakers
// and mic, no AEC on the recognizer's capture) is one interim that grows
// across the whole spoken text, so DESIGN.md §4's ratio over the interim
// would hide user words appended to it; what counts is the novel words.
// One novel word in a long echo is a misrecognition, not the user.
export function userWords(text, spoken) {
  const t = toks(text);
  const vocab = new Set(toks(spoken));
  const novel = t.filter(x => !vocab.has(x));
  if (novel.length === 1 && t.length > 3) return [];
  return novel;
}

// isEcho is userWords' complement: a transcript with no user words.
export const isEcho = (text, spoken) => toks(text).length > 0 && userWords(text, spoken).length === 0;

export class Dialog {
  constructor({ fsttm, attention, tts, llm, bargeIn = 'words', stopWords = STOP_WORDS,
    log = () => {}, now = () => performance.now(), onTurn = () => {} }) {
    Object.assign(this, { fsttm, attention, tts, llm, bargeIn, stopWords, log, now, onTurn });
    this.history = [];       // {role: user|system, text, interrupted?}
    this.parked = [];        // system utterances waiting for a free floor
    this.abort = null;       // AbortController of the LLM call in flight
    this.onset = null;       // performance time of the user's onset
    this.cutInterim = null;  // the interim that triggered the last cut
    this.lastFinalAt = null;
    this.lastSpoken = { text: '', until: -Infinity }; // the system's last words, for late echoes
    fsttm.onChange = (ev, src, dst) => {
      this.log('fsttm', { event: ev, src, dst });
      if ((dst === 'FREEu' || dst === 'FREEs') && this.parked.length) queueMicrotask(() => this.flush());
    };
  }

  get state() { return this.fsttm.state; }

  // spoken is what the recognizer may hear of us now: the turn being
  // spoken, plus the last one for 4 s after it ended (late finals)
  spoken() {
    const cur = this.tts.speaking ? (this.tts.cur?.sentences ?? [this.tts.sentence]).join(' ') : '';
    const late = this.now() < this.lastSpoken.until ? this.lastSpoken.text : '';
    return `${cur} ${late}`.trim();
  }

  remember(text) { this.lastSpoken = { text, until: this.now() + 4000 }; }

  // ── recognizer signals ────────────────────────────────────────────────
  speechStart() {
    this.onset = this.now();
    this.log('onset', { state: this.state, asleep: !this.attention.awake() });
    if (!this.attention.awake()) return; // ASLEEP: only a final's wake word counts
    if (this.fsttm.isSystem() && this.state === 'SYSTEM') {
      this.fsttm.tryAction('user', 'G'); // SYSTEM -(K,G)-> BOTHs: barge-in attempt
      if (this.bargeIn === 'energy') this.cut('energy');
      return;
    }
    if (this.state === 'FREEu' || this.state === 'FREEs') this.fsttm.tryAction('user', 'G'); // tentative grab
  }

  interim(text) {
    if (!text.trim()) return;
    const spoken = this.spoken();
    if (spoken && isEcho(text, spoken)) {
      this.log('echo', { text });
      return;
    }
    if (spoken) text = userWords(text, spoken).join(' '); // the user's words past the echo
    this.log('interim', { text, state: this.state });
    if (!this.attention.awake()) return;
    const busy = this.tts.speaking || this.abort;
    if (busy && keywordStop(text, this.stopWords)) { // "stop" on a partial: at once, any policy
      this.cutInterim = text;
      this.cut('keyword');
      return;
    }
    if (this.state === 'BOTHs' && this.bargeIn === 'words') { this.cutInterim = text; this.cut('words'); return; }
    if (this.state === 'FREEu' || this.state === 'FREEs') this.fsttm.tryAction('user', 'G'); // onset missed: the words confirm the grab
  }

  async final(text) {
    text = text.trim();
    this.log('final', { text, state: this.state, cutInterim: this.cutInterim });
    this.cutInterim = null;
    if (!text) return;
    const spoken = this.spoken();
    if (spoken && isEcho(text, spoken)) { this.log('echo', { text, final: true }); return; }
    if (spoken) text = userWords(text, spoken).join(' ');
    const d = this.attention.onUtterance(text);
    this.log('attention', { action: d.action, state: this.attention.state });
    if (d.action === 'ignore') return;
    if (this.state === 'SYSTEM') this.fsttm.tryAction('user', 'G'); // words with no onset or interim before them
    if (this.state === 'BOTHs') this.cut(this.bargeIn === 'none' ? 'none' : 'final'); // policy none cuts only now
    if (this.state === 'FREEu' || this.state === 'FREEs') this.fsttm.tryAction('user', 'G');
    this.fsttm.tryAction('user', 'R'); // USER -(W,R)-> FREEu: the utterance goes to the LLM
    this.lastFinalAt = this.now();
    if (d.action === 'sleep') return this.say(['Voice controls disabled.'], 'sleep');
    const cmd = d.action === 'wake' ? d.text : text;
    if (!cmd) return; // the wake word alone: awake and listening
    this.history.push({ role: 'user', text: cmd });
    if (keywordStop(cmd, this.stopWords)) { this.log('keyword_stop', { text: cmd }); return; }
    await this.reply(cmd);
  }

  // ── the system side ───────────────────────────────────────────────────
  async reply(text) {
    this.abort?.abort();
    const ctl = new AbortController();
    this.abort = ctl;
    const t0 = this.now();
    let r;
    try {
      r = await this.llm(text, { signal: ctl.signal, history: this.history });
    } catch (e) {
      if (ctl.signal.aborted) { this.log('llm_aborted', { text }); return; }
      this.log('llm_error', { error: String(e) });
      return;
    } finally {
      if (this.abort === ctl) this.abort = null;
    }
    if (ctl.signal.aborted) return;
    this.log('llm', { ms: this.now() - t0, firstMs: r.firstMs, voice: r.voice, json: r.json });
    this.onTurn(r);
    if (r.voice) this.say(splitSentences(r.voice), 'reply');
  }

  // say takes the floor when it is free (FREEu/FREEs) and speaks; while the
  // user holds it, the utterance waits (W) — never talk over the user.
  say(sentences, why = 'say') {
    if (!this.attention.awake() && why !== 'sleep') { this.log('parked', { why, asleep: true }); this.parked.push({ sentences, why }); return; }
    if (this.state === 'USER' || this.state === 'BOTHu' || this.tts.speaking) {
      this.log('parked', { why, state: this.state });
      this.parked.push({ sentences, why });
      return;
    }
    if (!this.fsttm.tryAction('system', 'G')) { this.parked.push({ sentences, why }); return; }
    const t = this.now();
    this.log('speak', { why, sentences, freeuDwell: this.lastFinalAt != null ? t - this.lastFinalAt : null });
    this.lastFinalAt = null;
    this.tts.speak(sentences, {
      onstart: i => this.log('tts_start', { i }),
      onend: completed => {
        if (!completed) return; // a cut releases the floor itself
        this.remember(sentences.join(' '));
        this.history.push({ role: 'system', text: sentences.join(' ') });
        this.fsttm.tryAction('system', 'R'); // SYSTEM -(R,W)-> FREEs on audio end, never on text end
        this.log('tts_end', { completed });
      },
    });
  }

  // announce is system-initiated: on a free floor at once; over the user
  // only when STOP-class (system G → BOTHu), else parked.
  announce(text, { stopClass = false } = {}) {
    if (stopClass && this.state === 'USER') {
      this.fsttm.tryAction('system', 'G'); // USER -(G,K)-> BOTHu
      this.log('announce', { text, over: 'user' });
      this.tts.speak([text], { onend: c => { if (c) { this.remember(text); this.fsttm.tryAction('system', 'R'); } } });
      return;
    }
    this.say([text], 'announce');
  }

  flush() {
    if (!this.parked.length || this.state === 'USER' || this.tts.speaking || !this.attention.awake()) return;
    const p = this.parked.shift();
    this.say(p.sentences, p.why);
  }

  // cut is the system's R during overlap: TTS cancelled, the LLM stream
  // aborted, the turn recorded as heard and marked [interrupted].
  cut(why) {
    const all = this.tts.cur?.sentences?.join(' ') ?? '';
    const heard = this.tts.cancel();
    if (all) this.remember(all);
    if (this.abort) { this.abort.abort(); this.abort = null; }
    const ms = this.onset != null ? this.now() - this.onset : null;
    const estimated = !!this.tts.estimated;
    if (heard !== null) this.history.push({ role: 'system', text: heard, interrupted: true, estimated });
    if (this.state === 'BOTHs' || this.state === 'SYSTEM' || this.state === 'BOTHu') this.fsttm.tryAction('system', 'R');
    this.log('cut', { why, onsetToCutMs: ms, heard, estimated, interim: this.cutInterim, state: this.state });
  }
}

// attachRecognizer wires a (webkit)SpeechRecognition to the dialog and
// keeps it running (Chrome ends a continuous session after silence).
export function attachRecognizer(rec, dialog, { lang = 'en-US' } = {}) {
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  let want = true;
  rec.onspeechstart = () => dialog.speechStart();
  rec.onresult = e => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) dialog.final(r[0].transcript); else dialog.interim(r[0].transcript);
    }
  };
  rec.onerror = e => dialog.log('rec_error', { error: e.error, message: e.message });
  rec.onend = () => { dialog.log('rec_end', {}); if (want) try { rec.start(); } catch {} };
  rec.start();
  return { stop() { want = false; rec.stop(); } };
}
