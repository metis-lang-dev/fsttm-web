// app.js — the page: chat (intent mode, step 1), voice (the dialog over
// SpeechRecognition + speechSynthesis, step 2), ?selftest (the §3 table in
// this Chrome + what this Chrome offers), ?bench (every event as JSONL).
import { loadAssets, twoPass, intentOf } from './llm.js';
import { parseCorpus, parseRef, runParity, summarize } from './parity.js';
import { FSTTM } from './fsttm.js';
import { Attention } from './attention.js';
import { Dialog, attachRecognizer } from './dialog.js';
import { BrowserTTS } from './tts.js';
import { Bench } from './bench.js';
import { runEventTable } from './eventtable.js';

const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const base = location.origin;
const get = async f => { const r = await fetch(`assets/${f}`); if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.text(); };
const assets = await loadAssets(get);
const table = await (await fetch('fsttm.json')).json();
$('status').textContent = 'ready';

function line(who, text, meta) {
  const d = document.createElement('div');
  d.className = `msg ${who}`;
  d.textContent = text;
  if (meta) { const m = document.createElement('small'); m.textContent = meta; d.append(m); }
  $('chat').append(d);
  $('chat').scrollTop = $('chat').scrollHeight;
}

// ── chat (intent mode) ───────────────────────────────────────────────────
let busy = false;
$('chatForm').onsubmit = async e => {
  e.preventDefault();
  const user = $('chatInput').value.trim();
  if (!user || busy) return;
  $('chatInput').value = '';
  if (dialog) { line('user', user, 'typed → the dialog'); dialog.final(user); return; }
  busy = true; $('status').textContent = 'thinking…';
  line('user', user);
  try {
    const r = await twoPass(base, { ...assets, user });
    line('intent', r.json, `${intentOf(r.json)} · first token ${Math.round(r.p1.firstMs)} ms · json ${Math.round(r.p1.totalMs)} ms · ` +
      `prompt tokens evaluated ${r.p1.timings.prompt_n} (cached ${r.p1.tokensCached})`);
    line('nina', r.voice, `ack ${Math.round(r.p2.totalMs)} ms`);
  } catch (err) { line('error', String(err)); }
  busy = false; $('status').textContent = 'ready'; $('chatInput').focus();
};

// ── voice (the dialog) ───────────────────────────────────────────────────
let dialog = null, recCtl = null;
const bench = new Bench({ sink: e => {
  const row = document.createElement('div');
  row.textContent = JSON.stringify(e);
  $('events').append(row);
  while ($('events').children.length > 300) $('events').firstChild.remove();
  $('events').scrollTop = $('events').scrollHeight;
  if (e.kind === 'fsttm') $('floor').textContent = e.dst;
  if (e.kind === 'attention') $('attn').textContent = e.state;
  if (e.kind === 'final') line('user', e.text, `final · ${e.state}`);
  if (e.kind === 'speak') line('nina', e.sentences.join(' '), e.why);
  if (e.kind === 'cut') line('cut', `[interrupted] heard: "${e.heard ?? ''}"`, `${e.why} · onset→cut ${Math.round(e.onsetToCutMs ?? -1)} ms`);
} });

async function startVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { line('error', 'no SpeechRecognition in this browser'); return; }
  const local = await probeLocal(SR);
  bench.log('recognition', local);
  const fsttm = new FSTTM(table);
  const attention = new Attention({ wakeWords: ['nina', 'hey nina', 'hello nina'],
    sleepPhrases: ['go to sleep', 'voice off', 'stop listening', "that's all"], startAsleep: q.get('awake') === null });
  const tts = new BrowserTTS();
  dialog = new Dialog({ fsttm, attention, tts, bargeIn: q.get('barge_in') ?? 'words', log: bench.log,
    llm: async (text, { signal }) => {
      const r = await twoPass(base, { ...assets, user: text, signal });
      return { voice: r.voice, json: r.json, firstMs: r.p1.firstMs };
    } });
  window.fsttmDialog = dialog; // for CDP drivers (the cut bench, E5)
  $('floor').textContent = fsttm.state;
  $('attn').textContent = attention.state;
  const rec = new SR();
  if (local.processLocally) rec.processLocally = true;
  recCtl = attachRecognizer(rec, dialog);
  $('micBtn').textContent = 'mic on';
}

// probeLocal: on-device recognition for en-US (DESIGN.md §6) — what this
// Chrome says, and install() when it says downloadable
async function probeLocal(SR) {
  const out = { api: !!SR, available: typeof SR?.available === 'function' };
  if (!out.available) return out;
  try {
    out.local = await SR.available({ langs: ['en-US'], processLocally: true });
    out.cloud = await SR.available({ langs: ['en-US'], processLocally: false });
    if (out.local === 'downloadable' && typeof SR.install === 'function') {
      out.install = await SR.install({ langs: ['en-US'], processLocally: true });
      out.local = await SR.available({ langs: ['en-US'], processLocally: true });
    }
    out.processLocally = out.local === 'available';
  } catch (e) { out.error = String(e); }
  return out;
}

$('micBtn').onclick = () => {
  if (recCtl) { recCtl.stop(); recCtl = null; $('micBtn').textContent = 'mic off'; return; }
  startVoice();
};
$('sayLong').onclick = () => dialog?.announce('Here is a long announcement so you can talk over me. ' +
  'The kitchen is quiet, the pot is empty, and nothing has been ordered for a while, so I will keep talking until somebody interrupts me.');
$('saveBench').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bench.jsonl()], { type: 'application/jsonl' }));
  a.download = `fsttm-bench-${Date.now()}.jsonl`;
  a.click();
  line('intent', JSON.stringify(bench.metrics()), 'metrics');
};
window.fsttmBench = bench; // for CDP readers (the E5 bench, the tests)

// ── ?selftest: the §3 table in this Chrome + what this Chrome offers ─────
if (q.has('selftest')) {
  $('mode').textContent = 'selftest';
  const rows = await runEventTable(table);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const caps = { userAgent: navigator.userAgent, recognition: await probeLocal(SR) };
  caps.voices = await new Promise(res => {
    const v = speechSynthesis.getVoices();
    if (v.length) return res(v.length);
    speechSynthesis.onvoiceschanged = () => res(speechSynthesis.getVoices().length);
    setTimeout(() => res(speechSynthesis.getVoices().length), 2000);
  });
  if (q.has('tts')) caps.tts = await new Promise(res => { // opt-in (audible): one real utterance — which events fire, when
    const t0 = performance.now(), ev = [];
    const u = new SpeechSynthesisUtterance('Testing one two three.');
    u.onstart = () => ev.push(['start', Math.round(performance.now() - t0)]);
    u.onboundary = e => ev.push(['boundary', e.charIndex, Math.round(performance.now() - t0)]);
    u.onend = () => { ev.push(['end', Math.round(performance.now() - t0)]); res(ev); };
    u.onerror = e => { ev.push(['error', e.error]); res(ev); };
    speechSynthesis.speak(u);
    setTimeout(() => { ev.push(['timeout 5s']); res(ev); }, 5000);
  });
  document.body.dataset.selftest = JSON.stringify({ rows, caps });
  for (const r of rows) line(r.pass ? 'intent' : 'error', `${r.pass ? 'ok' : 'FAIL'} [${r.policy}] ${r.signal} → ${r.action}`, `got: ${r.got}`);
  line('intent', JSON.stringify(caps), 'this Chrome');
  $('status').textContent = `selftest ${rows.filter(r => r.pass).length}/${rows.length}`;
}

// ── ?parity (step 1) ─────────────────────────────────────────────────────
if (q.has('parity')) {
  $('mode').textContent = 'parity';
  $('parity').hidden = false;
  const rows = parseCorpus(await get('dog-corpus.tsv'));
  const ref = parseRef(await get('harness-e2b.jsonl'));
  const recs = [];
  for await (const r of runParity(base, assets, rows, ref)) {
    recs.push(r);
    const tr = document.createElement('tr');
    tr.className = r.class ? (r.same ? 'same' : 'diff') : 'miss';
    for (const v of [r.class ? (r.same ? '=' : '≠') : '✗', r.utt, r.want, r.got, r.firstMs, r.p1PromptN, r.json, r.voice]) {
      const td = document.createElement('td'); td.textContent = v; tr.append(td);
    }
    if (r.same === false) tr.title = `harness: ${r.harnessJson}`;
    $('parityRows').append(tr);
    $('status').textContent = `parity ${recs.length}/${rows.length}`;
  }
  const s = summarize(recs);
  $('paritySum').textContent = `intent class ${s.classOK}/${s.n} · pass-1 JSON identical to the harness ${s.same}/${s.n} · ` +
    `first token p50 ${s.firstP50} ms, p90 ${s.firstP90} ms · prompt tokens evaluated: row 1 ${s.p1PromptNFirst}, later rows max ${s.p1PromptNMax}`;
  document.body.dataset.parity = JSON.stringify(s);
  $('status').textContent = 'parity done';
}
