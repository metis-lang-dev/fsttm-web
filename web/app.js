// app.js — the reference page: one dialog panel (lib/panel.js) in the consoles' shell — the chat
// on the left, its sections (the floor machine, the state and the numbers, the event log) in the
// docks, the mic switch (lib/switch.js) in the band — over the backend the page is served with;
// the host's backchannel (?host, or run.sh's terminal); the narrator (F8); ?selftest (the event
// table in this Chrome + what this Chrome offers). Everything else is the panel's.
import { loadAssets, LlamaBackend } from './backend/llama.js';
import { connect, WsBackend } from './backend/ws.js';
import { StubBackend } from './backend/stub.js';
import { Attention } from 'fsttm-web/attention';
import { cancelledMic } from 'fsttm-web/dialog';
import { BrowserTTS } from 'fsttm-web/tts';
import { Panel, probeLocal } from 'fsttm-web/panel';
import { micSwitch } from 'fsttm-web/switch';
import { Narrator, attachSelection, attachKey, narratorView } from 'fsttm-web/narrator';
import { runEventTable } from './eventtable.js';

const $ = id => document.getElementById(id);
const q = new URLSearchParams(location.search);
const table = await (await fetch('lib/fsttm.json')).json();

// the backend: one that speaks the library's wire on /ws (fsttm_web.protocol; examples/serve.py
// is one), llama-server's /completion (backend/llama.js), or the stub in the page.
// ?backend=ws|llama|stub forces one; else /ws when it answers, llama-server otherwise.
const want = q.get('backend');
const wsURL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const ws = want === 'llama' || want === 'stub' ? null : await connect(wsURL);
if (want === 'ws' && !ws) throw new Error(`no backend at ${wsURL}`);
const get = async f => { const r = await fetch(`assets/${f}`); if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.text(); };
const backend = want === 'stub' ? new StubBackend() : ws ?? new LlamaBackend({ base: location.origin, assets: await loadAssets(get) });
const backendName = want === 'stub' ? 'stub (in the page)' : ws ? 'ws' : 'llama-server';
$('backend').textContent = backendName;

// the host's backchannel: ?host on a ws backend is its own socket; ?host=ws://… a Relay's /page
// (python -m fsttm_web.chat --serve); else the one run.sh started, when it wrote assets/host.json
const hostQ = q.get('host');
let hostURL = hostQ && /^wss?:/.test(hostQ) ? hostQ : null;
if (!hostURL && !(q.has('host') && ws) && want !== 'stub' && !q.has('selftest'))
  hostURL = await fetch('assets/host.json').then(r => r.ok ? r.json() : null, () => null).then(j => j?.url ?? null, () => null);
const hostLink = hostURL ? new WsBackend(hostURL, { reconnect: 2000, onReopen: () => panel.core.hostOpened() }) : null;

// narrations voiced (the rest are shown): the kinds a backend says out loud (surprises, results,
// notices, quiescence …); ?narrate=all voices every one, ?narrate=none none
const narrateMode = q.get('narrate') ?? 'default';
const VOICED = new Set(['surprise', 'notice', 'result', 'quiescence', 'task', 'announce', 'reading']);
const narrate = f => f.form !== 'R' && (narrateMode === 'all' || (narrateMode !== 'none' && VOICED.has(f.kind) && !(f.kind === 'quiescence' && !f.sentence)));

// the wake words: ?wake=a,b (the library's neutral DEFAULT_WAKE otherwise); ?asleep: the wake word first
const attention = new Attention({ wakeWords: q.get('wake')?.split(',').map(w => w.trim()).filter(Boolean),
  sleepPhrases: ['go to sleep', 'voice off', 'stop listening', "that's all"], startAsleep: q.has('asleep') });
const tts = new BrowserTTS();

const panel = new Panel($('dialog'), {
  backend, table, tts, attention, backendName, narrate, title: 'dialog',
  bargeIn: q.get('barge_in') ?? 'words', voice: q.get('voice') !== '0',
  // replies: long = free conversation (several sentences, to talk over); short = the intent turn (JSON + one ack)
  modes: [{ value: 'talk', label: 'replies: long' }, { value: 'intent', label: 'replies: short' }],
  reply: q.get('reply') === 'short' ? 'intent' : 'talk',
  // the sections in the docks (the shell opens and closes them); the mic is the band's switch
  sections: ['floor', 'state', 'events'], meta: true, micButton: false,
  sectionsIn: { floor: $('sec-floor'), state: $('sec-state'), events: $('sec-events') },
  // the recognizer through the echo canceller (?raw_mic: the raw mic, her voice dropped by text), on-device
  // where this Chrome has it; the mic wakes her unless ?asleep keeps the wake-word start
  mic: q.has('raw_mic') ? null : cancelledMic, onDevice: true, micWakes: !q.has('asleep'),
  flipKey: null, holdKey: null,          // no side channel here: Space and Ctrl+Space stay the page's
  host: q.has('host') || !!hostLink,      // the rows, the events and the state back to the host (the wire's backchannel)
  hostLink,
  onEvent: e => {
    if (e.kind === 'heard' || e.kind === 'typed') $('status').textContent = 'thinking…';
    else if (e.kind === 'llm') $('status').textContent = `reply ${Math.round(e.ms)} ms`;
    else if (e.kind === 'llm_aborted') $('status').textContent = 'reply aborted';
    else if (e.kind === 'llm_error') $('status').textContent = 'llm error';
  },
});
window.panel = panel;
$('mic').replaceWith(Object.assign(micSwitch(panel).el, { id: 'mic' }));

// the docks: the strip shows and hides them, a header folds one; the panel draws what is open
const DOCKS = ['floor', 'state', 'events'];
const docks = MetisShell.docks({ names: DOCKS, key: 'fsttm-web.docks.v1',
  defaults: { floor: { shown: true, open: true }, state: { shown: true, open: false }, events: { shown: false, open: true } },
  onChange: st => { for (const n of DOCKS) panel.showSection(n, !!(st[n]?.shown && st[n]?.open)); } });
docks.apply();
MetisShell.splitter();
window.docks = docks;

if (hostLink) {
  hostLink.opened.then(() => panel.core.hostOpened(), () => {});
  const h = $('host'); h.hidden = false;
  const show = () => { h.innerHTML = `<b>HOST</b><span class="v">${hostLink.isOpen ? 'on' : 'waiting'}</span>`; h.title = hostURL; };
  show(); setInterval(show, 1000);
}
window.say = text => panel.say(text);          // the panel's public entry (a script, a CDP driver)
window.fsttmDialog = panel.core.dialog;        // for CDP drivers (a cut bench)
window.fsttmBench = panel.core.bench;
window.fsttmBackend = backend;
if (want === 'ws' || ws) panel.note(`backend: ${wsURL}`);

// the narrator: the page's selection read aloud on F8, floor-independent, yielding to the dialog's speech
const narrator = new Narrator({ tts, rate: Number(q.get('narrate_rate')) || null });
attachSelection(narrator, document);
attachKey(narrator, document, { key: q.get('narrate_key') ?? 'F8' });
narratorView($('narrator'), narrator, { key: q.get('narrate_key') ?? 'F8' });
window.fsttmNarrator = narrator;

$('sayLong').onclick = () => panel.core.dialog.announce('Here is a long announcement so you can talk over me. ' +
  'The kitchen is quiet, the pot is empty, and nothing has been ordered for a while, so I will keep talking until somebody interrupts me.');
$('status').textContent = 'ready';
document.body.dataset.ready = '1';

// ── ?selftest: the event table in this Chrome + what this Chrome offers ─────
if (q.has('selftest')) {
  $('mode').textContent = 'SELFTEST'; $('mode').hidden = false;
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
  for (const r of rows) panel.note(`${r.pass ? 'ok' : 'FAIL'} [${r.policy}] ${r.signal} → ${r.action} · got: ${r.got}`);
  panel.note(`this Chrome: ${JSON.stringify(caps)}`);
  $('status').textContent = `selftest ${rows.filter(r => r.pass).length}/${rows.length}`;
}
