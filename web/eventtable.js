// eventtable.js — the dialog's event table as scripted scenarios: each
// row is browser signals in, FSTTM transitions and dialog actions out.
// Runs in node (test/dialog.mjs) and in Chrome (index.html?selftest) on the
// same Dialog; the TTS and the LLM are fakes so every row is deterministic
// (what Chrome's real speechSynthesis does is measured separately).
import { FSTTM } from 'fsttm-web/fsttm';
import { Attention } from 'fsttm-web/attention';
import { Dialog } from 'fsttm-web/dialog';
import { Bench } from './bench.js';

export class FakeTTS {
  constructor() { this.cur = null; this.spoken = []; }
  get speaking() { return this.cur !== null; }
  get sentence() { return this.cur ? this.cur.sentences[this.cur.i] : ''; }
  speak(sentences, { onstart, onend } = {}) {
    this.cur = { sentences, i: 0, char: 0, onend };
    this.spoken.push(sentences.join(' '));
    onstart?.(0);
  }
  progress(chars) { if (this.cur) this.cur.char = chars; }
  finish() { const c = this.cur; if (!c) return; this.cur = null; c.onend?.(true); }
  heard() { const c = this.cur; return c ? c.sentences[c.i].slice(0, c.char).trim() : null; }
  cancel() { const c = this.cur; if (!c) return null; const h = this.heard(); this.cur = null; c.onend?.(false); return h; }
}

const tick = () => new Promise(r => setTimeout(r, 0));

async function make(table, { bargeIn = 'words', asleep = false, llmDelay = 0 } = {}) {
  let clock = 0;
  const bench = new Bench({ now: () => clock });
  const trans = [];
  const tts = new FakeTTS();
  const calls = [];
  const llm = async (text, { signal }) => {
    calls.push(text);
    if (llmDelay) await new Promise((res, rej) => {
      const t = setTimeout(res, llmDelay);
      signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
    });
    return { voice: `You said ${text}. That is a long enough reply to be one sentence.`, json: '{"intent":"CHITCHAT"}', firstMs: 25 };
  };
  const fsttm = new FSTTM(table, { now: () => clock });
  const d = new Dialog({ fsttm, attention: new Attention({ startAsleep: asleep }), tts, llm, bargeIn,
    log: bench.log, now: () => clock, autoResumeMs: 5 });
  const prev = fsttm.onChange;
  fsttm.onChange = (e, s, t) => { trans.push(`${s}→${t}`); prev(e, s, t); };
  return { d, tts, calls, trans, bench, adv: ms => { clock += ms; } };
}

// rows: [signal, the event-table row it verifies, run(ctx) → observed string, expected string]
export function rows() {
  return [
    ['onspeechstart (recognition)', 'user G → USER (tentative)', async c => { c.d.speechStart(); return c.d.state; }, 'USER'],
    ['first non-empty interim, not echo', 'confirms the grab (onset missed: FREEu → USER)', async c => { c.d.interim('what time'); return c.d.state; }, 'USER'],
    ['final result', 'user R → FREEu, utterance to the LLM', async c => {
      c.d.speechStart(); c.adv(800); const p = c.d.final('what time is it'); await tick();
      const s = c.trans.join(' '); await p; return `${s} | llm(${c.calls.join(',')})`;
    }, 'FREEu→USER USER→FREEu FREEu→SYSTEM | llm(what time is it)'],
    ['first sentence of the reply ready', 'system G → SYSTEM, speak; FREEu dwell logged', async c => {
      c.d.speechStart(); c.adv(500); await c.d.final('hello there');
      const sp = c.bench.events.find(e => e.kind === 'speak');
      return `${c.d.state} speaking=${c.tts.speaking} dwell=${sp?.freeuDwell}`;
    }, 'SYSTEM speaking=true dwell=0'],
    ['onend of the last chunk', 'system R → FREEs (on audio end)', async c => {
      await c.d.final('hello there'); const before = c.d.state; c.tts.finish(); return `${before}→${c.d.state}`;
    }, 'SYSTEM→FREEs'],
    ['user onset while SYSTEM (words)', 'user G → BOTHs, system K: no cut on energy', async c => {
      await c.d.final('hello there'); c.d.speechStart(); return `${c.d.state} speaking=${c.tts.speaking}`;
    }, 'BOTHs speaking=true'],
    ['… then a non-echo interim (words)', 'system R: TTS cancelled → USER; heard text marked [interrupted]', async c => {
      await c.d.final('hello there'); c.tts.progress(12); c.d.speechStart(); c.adv(320); c.d.interim('no wait');
      const h = c.d.history.at(-1); const cut = c.bench.events.find(e => e.kind === 'cut');
      return `${c.d.state} speaking=${c.tts.speaking} heard="${h.text}" interrupted=${h.interrupted} onset→cut=${cut.onsetToCutMs}ms`;
    }, 'USER speaking=false heard="You said hel" interrupted=true onset→cut=320ms'],
    ['user words while SYSTEM, no speechstart (Chrome sends one per session)', 'one word: user G → BOTHs, she keeps talking; the second word cuts', async c => {
      await c.d.final('hello there'); c.d.interim('wait'); const mid = `${c.d.state}/${c.tts.speaking}`;
      c.d.interim('wait please'); return `${mid} → ${c.d.state}/${c.tts.speaking}`;
    }, 'BOTHs/true → USER/false'],
    ['"continue" after a cut', 'the context keeps what was heard; she resumes at the cut word, no LLM call', async c => {
      await c.d.final('hello there'); c.tts.progress(9); c.d.interim('no wait');
      const cut = c.d.history.at(-1).text; await c.d.final('continue');
      const resumed = c.tts.spoken.at(-1); c.tts.finish();
      return `heard="${cut}" resumed="${resumed}" llm=${c.calls.length} context="${c.d.history.at(-1).text}" interrupted=${c.d.history.at(-1).interrupted}`;
    }, 'heard="You said" resumed="hello there. That is a long enough reply to be one sentence." llm=1 context="You said hello there. That is a long enough reply to be one sentence." interrupted=false'],
    ['a new question after a cut', 'the unsaid rest is dropped: the LLM sees only what was heard', async c => {
      await c.d.final('hello there'); c.tts.progress(9); c.d.interim('no wait');
      await c.d.final('what time is it');
      return `resume=${c.d.resume === null} prior="${c.d.history.at(-2).text}" llm(${c.calls.join(',')})`;
    }, 'resume=true prior="You said" llm(hello there,what time is it)'],
    ['energy cut, then no words (a cough)', 'auto-resume after autoResumeMs', async c => {
      await c.d.final('hello there'); c.tts.progress(9); c.d.speechStart(); const mid = `${c.d.state}/${c.tts.speaking}`;
      await new Promise(r => setTimeout(r, 20));
      return `${mid} → ${c.d.state}/${c.tts.speaking} "${c.tts.spoken.at(-1)}"`;
    }, 'USER/false → SYSTEM/true "hello there. That is a long enough reply to be one sentence."', { bargeIn: 'energy' }],
    ['a final starting with words she used apart ("what", "about")', 'not echo: the final reaches the LLM whole', async c => {
      c.d.llm = async (text) => { c.calls.push(text); return { voice: 'What a lovely evening it is. Tell me about your plans for tonight, please.', json: '', firstMs: 25 }; };
      await c.d.final('hello there'); c.adv(500); await c.d.final('what about jupiter');
      return `llm(${c.calls.join(',')})`;
    }, 'llm(hello there,what about jupiter)'],
    ['echo interim during SYSTEM', '[echo] dropped, never a grab', async c => {
      await c.d.final('hello there'); c.d.speechStart(); c.d.interim('you said hello there');
      return `${c.d.state} speaking=${c.tts.speaking} echo=${c.bench.events.filter(e => e.kind === 'echo').length}`;
    }, 'BOTHs speaking=true echo=1'],
    ['interim = the echo so far + user words (on-device grows one interim)', 'the user words cut; the echo part is not theirs', async c => {
      await c.d.final('hello there'); c.d.speechStart(); c.d.interim('you said hello there that is'); const mid = c.tts.speaking;
      c.d.interim('you said hello there that is go to the kitchen');
      return `echo first=${mid} → ${c.d.state} speaking=${c.tts.speaking} cut on "${c.bench.events.find(e => e.kind === 'cut')?.interim}"`;
    }, 'echo first=true → USER speaking=false cut on "go the kitchen"'],
    ['final of our own words just after the TTS ended', 'echo: dropped, never answered (the feedback loop)', async c => {
      await c.d.final('hello there'); c.tts.finish(); c.adv(900);
      await c.d.final('you said hello there that is a long enough reply to be one sentence');
      return `${c.d.state} llm=${c.calls.length} echo=${c.bench.events.filter(e => e.kind === 'echo').length}`;
    }, 'FREEs llm=1 echo=1'],
    ['user onset while SYSTEM (energy)', 'system R at onspeechstart', async c => {
      await c.d.final('hello there'); c.d.speechStart(); return `${c.d.state} speaking=${c.tts.speaking}`;
    }, 'USER speaking=false', { bargeIn: 'energy' }],
    ['user onset + interim while SYSTEM (none)', 'K until the final; the final cuts', async c => {
      await c.d.final('hello there'); c.d.speechStart(); c.d.interim('no wait'); const mid = `${c.d.state}/${c.tts.speaking}`;
      const p = c.d.final('no wait stop that'); await tick(); const after = `${c.d.history.at(-2)?.interrupted}`; await p;
      return `${mid} then interrupted=${after}`;
    }, 'BOTHs/true then interrupted=true', { bargeIn: 'none' }],
    ['announcement while USER', 'W: parked, spoken when the floor frees', async c => {
      c.d.speechStart(); c.d.announce('Battery low.'); const mid = `${c.d.state}/${c.tts.speaking}`;
      c.d.final(''); c.d.fsttm.tryAction('user', 'R'); await tick(); return `${mid} → ${c.d.state}/${c.tts.spoken.at(-1)}`;
    }, 'USER/false → SYSTEM/Battery low.'],
    ['STOP-class announcement while USER', 'system G → BOTHu', async c => {
      c.d.speechStart(); c.d.announce('Stop, obstacle ahead.', { stopClass: true }); return `${c.d.state}/${c.tts.speaking}`;
    }, 'BOTHu/true'],
    ['"stop" in an interim while the LLM streams', 'system R at once, stream aborted, nothing spoken', async c => {
      const p = c.d.final('tell me a story'); await tick(); c.d.speechStart(); c.d.interim('stop'); await p;
      return `aborted=${c.bench.events.some(e => e.kind === 'llm_aborted')} spoken=${c.tts.spoken.length} cut=${c.bench.events.find(e => e.kind === 'cut')?.why}`;
    }, 'aborted=true spoken=0 cut=keyword', { llmDelay: 50 }],
    ['"halt" in an interim while SYSTEM', 'system R at once (any policy)', async c => {
      await c.d.final('hello there'); c.d.interim('halt'); return `${c.d.state} speaking=${c.tts.speaking}`;
    }, 'FREEs speaking=false', { bargeIn: 'none' }],
    ['utterance while ASLEEP', 'dropped', async c => {
      c.d.speechStart(); await c.d.final('stand up'); return `${c.d.state} llm=${c.calls.length}`;
    }, 'FREEu llm=0', { asleep: true }],
    ['wake word while ASLEEP', 'AWAKE, then as above (the remainder is the command)', async c => {
      c.d.speechStart(); await c.d.final('hey computer what time is it');
      return `${c.d.attention.state} llm(${c.calls.join(',')}) ${c.d.state}`;
    }, 'AWAKE llm(what time is it) SYSTEM', { asleep: true }],
  ];
}

export async function runEventTable(table) {
  const out = [];
  for (const [signal, action, run, want, opts] of rows()) {
    const c = await make(table, opts);
    let got;
    try { got = await run(c); } catch (e) { got = `throws ${e.message}`; }
    out.push({ signal, action, want, got, pass: got === want, policy: opts?.bargeIn ?? 'words' });
  }
  return out;
}
