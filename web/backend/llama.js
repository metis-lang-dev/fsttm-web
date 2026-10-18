// backend/llama.js — the framework's standalone backend: a plain
// llama-server (run.sh). The backend adapter on top of a two-pass intent
// turn (pass 1 the intent JSON under a grammar, pass 2 one spoken line) and
// the free dialog, over llama-server's /completion.
//
// Rendering is Gemma 4's chat template, byte for byte:
//   <|turn>system\n{system}<turn|>\n<|turn>user\n{user}<turn|>\n<|turn>model\n
// The system turn is the constant prefix; cache_prompt keeps it in the KV
// slot, so a turn evaluates only the user tail. The BOS comes from the server.

import { splitSentences } from 'fsttm-web/tts';

export const PASS2 = { temperature: 0.4, top_k: 40, n_predict: 50 }; // config.ws.yaml pass2
const PASS1_MAX = 80;                  // the pass-1 token cap
const CUE = '\nSpoken response:';      // pass 2: bare continuation (Pass2Turn off)
const EOT = '<turn|>';

export function renderSystem(system) {
  return `<|turn>system\n${system}${EOT}\n`;
}

export function renderTurn(system, user) {
  // the user text trimmed of \r\n
  const u = user.replace(/^[\r\n]+|[\r\n]+$/g, '');
  return `${renderSystem(system)}<|turn>user\n${u}${EOT}\n<|turn>model\n`;
}

// clean: trim, drop thought-channel markup, drop
// a trailing end-of-turn.
export function clean(text) {
  let t = dropChannel(text.trim());
  if (t.endsWith(EOT)) t = t.slice(0, -EOT.length).trim();
  if (t.endsWith('<|end|>')) t = t.slice(0, -'<|end|>'.length).trim();
  return t.trim();
}

function dropChannel(t) {
  const open = '<|channel>', close = '<channel|>';
  if (t.startsWith(open)) {
    const i = t.indexOf(close);
    if (i < 0) return '';
    t = t.slice(i + close.length).trim();
  }
  for (const m of [open, close]) {
    const i = t.indexOf(m);
    if (i >= 0) t = t.slice(0, i).trim();
  }
  return t;
}

// complete POSTs one /completion with stream:true and returns the text, the
// client-side first-token ms, and the server's timings (prompt_n is the
// number of prompt tokens evaluated — the cache_prompt evidence).
export async function complete(base, body, { signal } = {}) {
  const t0 = performance.now();
  const res = await fetch(`${base}/completion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: true, cache_prompt: true }),
    signal,
  });
  if (!res.ok) throw new Error(`/completion ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', firstMs = null, last = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const ev = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of ev.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const d = JSON.parse(line.slice(6));
        if (d.content) {
          if (firstMs === null) firstMs = performance.now() - t0;
          text += d.content;
        }
        if (d.stop) last = d;
      }
    }
  }
  return { text, firstMs, totalMs: performance.now() - t0, timings: last?.timings ?? {},
    tokensCached: last?.tokens_cached, stopType: last?.stop_type };
}

// twoPass is one intent turn: pass 1 greedy under the grammar, pass 2 the
// spoken ack continued after the JSON and the cue, cut at the first newline.
export async function twoPass(base, { system, gbnf, user, pass2 = PASS2, signal }) {
  const prompt = renderTurn(system, user);
  const p1 = await complete(base, {
    prompt, grammar: gbnf, n_predict: PASS1_MAX,
    temperature: 0, top_k: 1, samplers: ['top_k', 'temperature'],
  }, { signal });
  const json = clean(p1.text);
  const p2 = await complete(base, {
    prompt: prompt + p1.text + CUE, n_predict: pass2.n_predict,
    temperature: pass2.temperature, top_k: pass2.top_k, stop: ['\n'],
  }, { signal });
  let voice = p2.text;
  const nl = voice.indexOf('\n');
  if (nl >= 0) voice = voice.slice(0, nl);
  voice = clean(voice);
  return { json, voice, p1, p2 };
}

export function intentOf(json) {
  try { return JSON.parse(json).intent ?? '?'; } catch { return '?'; }
}

// loadAssets reads (by basename: web/assets/ in the page, prompt/ and grammar/
// in node) the intent turn's system prompt (example-prompt + its pass-2
// examples, concatenated byte for byte) and its grammar. The example is a
// desk assistant with a light (LIGHT_ON / LIGHT_OFF / TIME / CHITCHAT /
// UNKNOWN): an application gives its own.
export async function loadAssets(read, { prompt = 'example-prompt.txt', examples = 'example-pass2.txt', grammar = 'example.gbnf' } = {}) {
  const [p, x, g] = await Promise.all([read(prompt), read(examples), read(grammar)]);
  return { system: p + x, gbnf: g };
}

// ── long replies (step 2's barge-in bench) ────────────────────────────────
// The intent turn answers in one short ack, too short to talk over. talk is
// a plain spoken conversation on the same model and slot: no grammar, no
// JSON, a few sentences, the recent turns as context. It is the page's
// "replies: long" mode.
export const TALK_SYSTEM = `You are a warm, curious and talkative voice assistant, chatting with a person out loud.
Be genuinely helpful: answer what was asked, then add something of your own: an example, a detail, a small story, an opinion, or a question back.
Keep the conversation going and show interest in the person. Have opinions and a sense of humour; never say you cannot chat.
Keep it short: two to four natural spoken sentences, no lists, no headings, no markup, no emoji.
If the person interrupted you, pick up from what they said, not from what you were saying.`;
export const TALK = { temperature: 1.0, top_k: 64, top_p: 0.95, min_p: 0.05, repeat_penalty: 1.1, n_predict: 160 };

export function renderTalk(history, user, system = TALK_SYSTEM) {
  let p = renderSystem(system);
  for (const h of history.slice(-12)) {
    const role = h.role === 'user' ? 'user' : 'model';
    const text = h.interrupted ? `${h.text} [interrupted]` : h.text;
    p += `<|turn>${role}\n${text}${EOT}\n`;
  }
  return p + `<|turn>user\n${user.trim()}${EOT}\n<|turn>model\n`;
}

export async function talk(base, { user, history = [], signal, opts = TALK }) {
  // the dialog pushes the user's turn before replying: drop it from history
  const prior = history.length && history.at(-1).role === 'user' && history.at(-1).text === user
    ? history.slice(0, -1) : history;
  const r = await complete(base, { prompt: renderTalk(prior, user), stop: [EOT], ...opts }, { signal });
  return { voice: clean(r.text).replace(/\s*\n+\s*/g, ' '), r };
}

// ── the backend adapter ────────────────────────────────────────────────────
// turn(id, text, mode, {signal}) → async iterable of sentences
// cut(id, heard)                 → turn id was heard up to heard
// mode: 'intent' (the two-pass turn: JSON + one ack) | 'talk' (free dialog).
// The dialog history in talk mode is the backend's: the user's turns and
// the replies as heard — a cut reply is kept up to the cut word and marked
// [interrupted], so the next prompt shares the KV prefix up to it.
export class LlamaBackend {
  constructor({ base, assets, talkOpts = TALK, keep = 12 }) {
    Object.assign(this, { base, assets, talkOpts, keep });
    this.history = []; // {role: user|system, text, id?, full?, interrupted?}
    this.info = {};    // id → {json, firstMs, mode} of the turn (the page's panes)
  }

  async *turn(id, text, mode, { signal } = {}) {
    if (mode === 'intent') {
      const r = await twoPass(this.base, { ...this.assets, user: text, signal });
      this.info[id] = { json: r.json, firstMs: r.p1.firstMs, mode };
      this.remember(id, text, r.voice); // talk turns see the intent turns too, as the page's history did
      if (r.voice) yield* splitSentences(r.voice);
      return;
    }
    const t = await talk(this.base, { user: text, history: this.history, signal, opts: this.talkOpts });
    this.info[id] = { json: '', firstMs: t.r.firstMs, mode };
    this.remember(id, text, t.voice);
    yield* splitSentences(t.voice);
  }

  remember(id, text, voice) {
    this.history.push({ role: 'user', text: text.trim() });
    if (voice) this.history.push({ role: 'system', id, text: voice, full: voice });
    this.history = this.history.slice(-2 * this.keep);
  }

  cut(id, heard) {
    const h = this.history.find(x => x.id === id);
    if (!h) return;
    h.text = heard.trim() || '...';
    h.interrupted = norm(heard) !== norm(h.full);
  }
}

const norm = s => s.replace(/\s+/g, ' ').trim();
