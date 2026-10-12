// app.js — the page: the dialog (the floor machine over SpeechRecognition +
// speechSynthesis) with its state on view — the floor diagram, the turn
// timings, the numbers and the event log, laid out as the Python TUI's
// panels; ?selftest (the §3 table in this Chrome + what this Chrome
// offers), ?parity (the 54-row intent corpus, step 1).
import { loadAssets, LlamaBackend } from './backend/llama.js';
import { connect } from './backend/ws.js';
import { parseCorpus, parseRef, runParity, summarize } from './parity.js';
import { FSTTM } from 'fsttm-web/fsttm';
import { Attention } from 'fsttm-web/attention';
import { Dialog, attachRecognizer } from 'fsttm-web/dialog';
import { BrowserTTS, splitSentences } from 'fsttm-web/tts';
import { Bench } from './bench.js';
import { runEventTable } from './eventtable.js';
import { FsmView } from './fsmview.js';

const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const base = location.origin;
const get = async f => { const r = await fetch(`assets/${f}`); if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.text(); };
const assets = await loadAssets(get);
const table = await (await fetch('lib/fsttm.json')).json();

// a panel follows its newest line unless the reader scrolled up in it
function append(box, node, max = 400) {
  const atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.append(node);
  while (box.children.length > max) box.firstChild.remove();
  if (atEnd) box.scrollTop = box.scrollHeight;
}

function line(who, text, meta) {
  const d = document.createElement('div');
  d.className = `msg ${who}`;
  d.textContent = text;
  if (meta) { const m = document.createElement('small'); m.textContent = meta; d.append(m); }
  append($('chat'), d);
}

// ── replies: long = free conversation (several sentences, to talk over);
// short = the intent turn (JSON + one ack), the harness's path ───────────
let longReplies = q.get('reply') !== 'short';
const showReplies = () => { $('replyBtn').textContent = `replies: ${longReplies ? 'long' : 'short'}`; };
$('replyBtn').onclick = () => { longReplies = !longReplies; showReplies(); };
showReplies();

// the backend adapter (metis-agent FRAMEWORK §6): turn(id, text, mode) →
// sentences, cut(id, heard). Served by metis-agent, the page talks to it
// over /ws (backend/ws.js); served by llama-server, to /completion
// (backend/llama.js). ?backend=llama|ws forces one.
const want = q.get('backend');
const wsURL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
let onAgentFrame = () => {}; // set below, once the panes exist
const agentWs = want === 'llama' ? null : await connect(wsURL, { onFrame: f => onAgentFrame(f) });
if (want === 'ws' && !agentWs) throw new Error(`no metis-agent at ${wsURL}`);
const backend = agentWs ?? new LlamaBackend({ base, assets });
const backendName = agentWs ? 'metis-agent (ws)' : 'llama-server';
let domains = [];
async function llm(text, { signal, id }) {
  $('status').textContent = 'thinking…';
  const sentences = [];
  for await (const s of backend.turn(id, text, longReplies ? 'talk' : 'intent', { signal })) sentences.push(s);
  const info = backend.info[id] ?? {};
  return { voice: sentences.join(' '), json: info.json, firstMs: info.firstMs, mode: longReplies ? 'long' : 'short' };
}

// ── the dialog, live from page load: typing talks to it at once, the mic
// adds the recognizer ────────────────────────────────────────────────────
const fsm = new FsmView($('fsm'));
const fsttm = new FSTTM(table);
const attention = new Attention({ wakeWords: ['nina', 'hey nina', 'hello nina'],
  sleepPhrases: ['go to sleep', 'voice off', 'stop listening', "that's all"], startAsleep: q.has('asleep') });
const tts = new BrowserTTS();
const turns = [];
// narrations voiced (the rest are shown): what was said out loud before the
// rack, at quiescence and surprises (RAG §8.4: per-clause talk was the
// cost); ?narrate=all voices every one, ?narrate=none none
const narrateMode = q.get('narrate') ?? 'default';
const VOICED = new Set(['surprise', 'notice', 'result', 'quiescence', 'task', 'announce', 'reading']);
const trail = []; // the last floor states, {state, t}: a short state is seen here
let recognition = {};

const bench = new Bench({ sink: e => {
  const row = document.createElement('div');
  row.textContent = `${(e.t / 1000).toFixed(2).padStart(7)} ${e.kind} ${JSON.stringify({ ...e, t: undefined, kind: undefined })}`;
  append($('events'), row, 600);
  onEvent(e);
} });

const bargeIn = q.get('barge_in') ?? 'words';
const dialog = new Dialog({ fsttm, attention, tts, bargeIn, log: bench.log, llm,
  onHeard: (id, heard) => backend.cut(id, heard),
  onTurn: r => { if (r.json) line('intent', r.json, 'intent'); } });
window.fsttmDialog = dialog; // for CDP drivers (the cut bench, E5)
window.fsttmBench = bench;
window.fsttmBackend = backend;

// ── metis-agent's frames: narrations voiced floor permitting (say() parks
// them while the user holds the floor or she sleeps), the rest logged ────
onAgentFrame = f => {
  // a frame's own kind (narration, runtime) is logged as `of`: bench.log's kind is the frame's ev
  const { ev, t, kind, ...rest } = f;
  if (kind !== undefined) rest.of = kind;
  if (ev === 'narration') {
    const text = f.form === 'R' ? f.line : (f.sentence || f.line);
    const voice = narrateMode === 'all' || (narrateMode !== 'none' && VOICED.has(f.kind));
    bench.log('narration', { ...rest, voiced: voice });
    line('narr', text, `${f.kind} · ${f.form}${f.path ? ' · ' + f.path : ''}${f.form === 'R+N' ? ' · ' + f.line : ''}${voice ? '' : ' · shown, not voiced'}`);
    if (voice && text) dialog.say(splitSentences(text), 'narration');
    return;
  }
  if (ev === 'domains') { domains = f.domains ?? []; scheduleStats(); }
  if (ev === 'command') line('narr', `${f.name} ${JSON.stringify(f.args ?? {})}`, `command ${f.id}`);
  bench.log(ev === 'rack' ? 'rack' : ev, ev === 'rack' ? { last: f.last, paths: (f.paths ?? []).length } : rest);
};
$('bargeSel').value = bargeIn;
$('bargeSel').onchange = () => { dialog.bargeIn = $('bargeSel').value; bench.log('policy', { bargeIn: dialog.bargeIn }); };

function onEvent(e) {
  switch (e.kind) {
    case 'final': if (e.text) line('user', e.text, `final · ${e.state}`); break;
    case 'speak': line('nina', e.sentences.join(' '), e.why); break;
    case 'cut': line('cut', `[interrupted · ${e.why}] heard: "${e.heard ?? ''}"`,
      `onset→cut ${e.onsetToCutMs != null ? Math.round(e.onsetToCutMs) + ' ms' : '—'}${e.estimated ? ' · heard estimated' : ''}` +
      (e.rest ? ` · unsaid, out of the context until "continue": "${e.rest}"` : '')); break;
    case 'resume': line('cut', `resuming (${e.why}) from the cut word`); break;
    case 'fsttm': trail.push({ state: e.dst, t: e.t }); if (trail.length > 7) trail.shift(); break;
    case 'attention': if (e.action === 'ignore') line('cut', 'ignored: asleep — say "nina …", flip the switch, or type'); break;
    case 'echo': if (e.final) line('cut', `dropped as her own echo: "${e.text}"`); break;
    case 'keyword_stop': line('cut', `stop: "${e.text}"`); break;
    case 'llm': $('status').textContent = `reply ${Math.round(e.ms)} ms`; break;
    case 'llm_aborted': $('status').textContent = 'reply aborted'; break;
    case 'llm_error': line('error', e.error, 'llm'); $('status').textContent = 'llm error'; break;
    case 'rec_error': if (e.error !== 'no-speech') line('error', `${e.error} ${e.message ?? ''}`, 'microphone'); break;
    case 'recognition': recognition = e; break;
  }
  turnEvent(e);
  showState();
  scheduleStats();
}

// ── turns · timing ─────────────────────────────────────────────────────────
function turnEvent(e) {
  const cur = turns.at(-1);
  if (e.kind === 'llm') {
    turns.push({ n: turns.length + 1, mode: e.mode ?? '?', text: e.text, first: e.firstMs, ms: e.ms, dwell: null, end: 'parked' });
  } else if (e.kind === 'llm_aborted') {
    turns.push({ n: turns.length + 1, mode: longReplies ? 'long' : 'short', text: e.text, end: 'aborted (new words)' });
  } else if (cur && e.kind === 'speak' && e.why === 'reply') {
    cur.dwell = e.freeuDwell; cur.end = 'speaking…';
  } else if (cur && e.kind === 'speak' && e.why === 'resume') {
    cur.end = 'speaking…'; cur.resumed = (cur.resumed ?? 0) + 1;
  } else if (cur && e.kind === 'tts_end' && cur.end === 'speaking…') {
    cur.end = cur.resumed ? `spoken · resumed ×${cur.resumed}` : 'spoken';
  } else if (cur && e.kind === 'cut' && cur.end === 'speaking…') {
    cur.end = `cut · ${e.why} · ${e.onsetToCutMs != null ? Math.round(e.onsetToCutMs) + ' ms' : '—'}`;
  } else return;
  renderTurns();
}

const ms = v => v == null ? '—' : `${Math.round(v)}`;
function renderTurns() {
  const body = $('turns');
  const atEnd = body.parentElement.parentElement;
  const follow = atEnd.scrollHeight - atEnd.scrollTop - atEnd.clientHeight < 40;
  body.replaceChildren(...turns.slice(-200).map(t => {
    const tr = document.createElement('tr');
    for (const [v, cls] of [[t.n], [t.mode], [t.text, 'max-w-[16rem] truncate'], [ms(t.first), 'text-right'], [ms(t.ms), 'text-right'],
      [ms(t.dwell), 'text-right'], [t.end, t.end.startsWith('cut') ? 'text-amber-300' : '']]) {
      const td = document.createElement('td');
      td.className = `cell ${cls ?? ''}`;
      td.textContent = v ?? '';
      if (v === t.text) td.title = t.text;
      tr.append(td);
    }
    return tr;
  }));
  if (follow) atEnd.scrollTop = atEnd.scrollHeight;
}

// ── the floor, the attention, the numbers ──────────────────────────────────
function showState() {
  fsm.show(fsttm.state, fsttm.prev);
  $('floor').textContent = fsttm.state;
  $('floor').className = `pill ${fsttm.isSystem() ? 'text-emerald-300' : 'text-sky-300'}`;
  $('attn').textContent = attention.state;
  $('attn').className = attention.awake() ? 'text-emerald-300' : 'text-amber-300';
  $('attnSwitch').checked = attention.awake();
}

setInterval(() => { // the dwell in the current state and §3.2's costs, live
  const tau = fsttm.now() - fsttm.since;
  $('dwell').textContent = `${fsttm.state} for ${(tau / 1000).toFixed(1)} s${fsttm.prev ? ` · from ${fsttm.prev}` : ''}`;
  $('trail').replaceChildren(...trail.flatMap((x, i) => {
    const s = document.createElement('span');
    const until = i + 1 < trail.length ? trail[i + 1].t : null;
    s.className = i === trail.length - 1 ? 'text-green-400 font-bold' : i === trail.length - 2 ? 'text-blue-400' : '';
    s.textContent = until != null ? `${x.state} ${Math.round(until - x.t)} ms` : x.state;
    return i ? [document.createTextNode(' → '), s] : [s];
  }));
  const c = fsttm.systemActionsCost();
  $('costs').textContent = 'system cost now: ' + Object.entries(c).map(([k, v]) => `${k} ${v < 1e4 ? v.toFixed(1) : v.toExponential(1)}`).join(' · ');
}, 100);

let statsDue = false;
function scheduleStats() {
  if (statsDue) return;
  statsDue = true;
  setTimeout(() => { statsDue = false; renderStats(); }, 250);
}

function renderStats() {
  const m = bench.metrics();
  const lastCut = bench.events.findLast(e => e.kind === 'cut');
  const rows = [
    ['attention', attention.state],
    ['replies', longReplies ? 'long (free dialog)' : 'short (intent)'],
    ['barge-in', dialog.bargeIn],
    ['recognizer', recCtl ? (recognition.processLocally ? 'on-device' : 'cloud') : 'off'],
    ['tts heard', tts.boundaries ? 'word boundaries' : 'estimated by time'],
    ['backend', backendName],
    ...(agentWs ? [['domains', domains.length ? domains.map(d => `${d.display || d.path} (${d.state})`).join(', ') : 'none']] : []),
    ['', ''],
    ['turns', turns.length],
    ['barge-ins', `${m.cuts}${m.cuts ? ' · ' + Object.entries(m.byPolicy).map(([k, v]) => `${k} ${v}`).join(', ') : ''}`],
    ['onset→cut', m.onsetToCutP50 != null ? `p50 ${ms(m.onsetToCutP50)} · max ${ms(m.onsetToCutMax)} ms` : '—'],
    ['last cut', lastCut ? `${lastCut.why} · ${ms(lastCut.onsetToCutMs)} ms · "${(lastCut.heard ?? '').split(' ').slice(-4).join(' ')}"` : '—'],
    ['false cuts', m.falseCuts],
    ['echo drops', m.echoDrops],
    ['', ''],
    ['first token', m.llmFirstTokenP50 != null ? `p50 ${ms(m.llmFirstTokenP50)} ms` : '—'],
    ['reply', m.llmFirstSentenceP50 != null ? `p50 ${ms(m.llmFirstSentenceP50)} ms` : '—'],
    ['FREEu dwell', m.freeuDwellP50 != null ? `p50 ${ms(m.freeuDwellP50)} ms` : '—'],
    ['tts', `${m.ttsSeconds} s spoken`],
  ];
  $('stats').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.className = 'text-slate-500 text-right'; dt.textContent = k;
    const dd = document.createElement('dd'); dd.className = 'text-slate-300 truncate'; dd.textContent = String(v); dd.title = String(v);
    return [dt, dd];
  }));
}

// ── input: typing, the mic, the switch ─────────────────────────────────────
$('chatForm').onsubmit = e => {
  e.preventDefault();
  const user = $('chatInput').value.trim();
  if (!user) return;
  $('chatInput').value = '';
  // typing is addressing her: no wake word needed
  if (attention.force(true)) bench.log('attention', { state: 'AWAKE', forced: 'typed' });
  bench.log('typed', { text: user });
  dialog.final(user);
};

let recCtl = null;
async function micOn() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { line('error', 'no SpeechRecognition in this browser'); return; }
  if (!recognition.api) bench.log('recognition', await probeLocal(SR));
  // pressing mic is mic possession: awake at once, like the harness's
  // ForceAttention (?asleep keeps the wake-word start)
  if (!q.has('asleep') && attention.force(true)) bench.log('attention', { state: 'AWAKE', forced: 'mic' });
  const rec = new SR();
  if (recognition.processLocally) rec.processLocally = true;
  recCtl = attachRecognizer(rec, dialog);
  $('micBtn').textContent = 'mic on';
  $('micDot').className = 'inline-block w-2.5 h-2.5 rounded-full bg-emerald-400';
  showState(); scheduleStats();
}

function micOff() {
  recCtl.stop(); recCtl = null;
  $('micBtn').textContent = 'mic off';
  $('micDot').className = 'inline-block w-2.5 h-2.5 rounded-full bg-slate-700';
  if (attention.force(false)) bench.log('attention', { state: 'ASLEEP', forced: 'mic' });
  showState(); scheduleStats();
}

$('micBtn').onclick = () => (recCtl ? micOff() : micOn());
$('attnSwitch').onchange = () => {
  if (attention.force($('attnSwitch').checked)) bench.log('attention', { state: attention.state, forced: 'switch' });
  showState();
};

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

$('sayLong').onclick = () => dialog.announce('Here is a long announcement so you can talk over me. ' +
  'The kitchen is quiet, the pot is empty, and nothing has been ordered for a while, so I will keep talking until somebody interrupts me.');
$('clearBtn').onclick = () => $('events').replaceChildren();
$('saveBench').onclick = () => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bench.jsonl()], { type: 'application/jsonl' }));
  a.download = `fsttm-bench-${Date.now()}.jsonl`;
  a.click();
  line('intent', JSON.stringify(bench.metrics()), 'metrics');
};

showState(); renderStats();
$('status').textContent = 'ready';

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
      const td = document.createElement('td'); td.className = 'cell'; td.textContent = v; tr.append(td);
    }
    if (r.same === false) tr.title = `harness: ${r.harnessJson}`;
    append($('parityRows'), tr, 1000);
    $('status').textContent = `parity ${recs.length}/${rows.length}`;
  }
  const s = summarize(recs);
  $('paritySum').textContent = `intent class ${s.classOK}/${s.n} · pass-1 JSON identical to the harness ${s.same}/${s.n} · ` +
    `first token p50 ${s.firstP50} ms, p90 ${s.firstP90} ms · prompt tokens evaluated: row 1 ${s.p1PromptNFirst}, later rows max ${s.p1PromptNMax}`;
  document.body.dataset.parity = JSON.stringify(s);
  $('status').textContent = 'parity done';
}
