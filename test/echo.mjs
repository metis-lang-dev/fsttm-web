// node test/echo.mjs — the echo measure on the alf demo's echoes (alf-demo 3c, the journal of
// 2026-10-24 10:06–10:07: the page's TTS heard back re-spelled), then the dialog over a narration
// backlog: late finals of every line are echo, the user's words still pass, "stop" at any time.
import { readFile } from 'node:fs/promises';
import { FSTTM } from 'fsttm-web/fsttm';
import { Attention } from 'fsttm-web/attention';
import { Dialog, ECHO, echoShare, isEcho, pastEcho, norm } from 'fsttm-web/dialog';
import { splitSentences } from 'fsttm-web/tts';
import { FakeTTS } from '../web/eventtable.js';

let pass = 0, fail = 0;
const check = (name, ok, got = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n      got: ${got}`}`); };

const LINES = ['I go to countertop 3.', 'Countertop 3 has nothing to open.', 'I take tomato 1 from countertop 3.',
  'I go to microwave 1.', 'I open microwave 1.', 'I put tomato 1 in microwave 1.', 'Done: the task is done.'];
const CARD = splitSentences('ALFWorld: a household scene from ALFRED, in text mode (TextWorld): one game is one room and one task. ' +
  'Ask me, for example: "put a tomato in the microwave" or "put the apple on the countertop".');
const REPLY = ['What a lovely evening it is. Tell me about your plans for tonight, please.'];

// ── the measure ───────────────────────────────────────────────────────
check('norm spells numbers, keeps letters, one of a doubled letter', norm('Countertop 3, tomato1 & 42!') === 'countertopthretomatoonefortytwo' && norm('All right') === norm('Alright'), norm('Countertop 3, tomato1 & 42!'));
// [spoken, transcript]: what the recognizer made of her (the brief's corpus; the backlog = all seven lines)
const ECHOES = [
  [['I go to countertop 3.'], 'counter top three'],
  [['I take tomato 1 from countertop 3.'], 'Countered I take tomato one from countertop'],
  [['I go to microwave 1.', 'I open microwave 1.'], 'I go to microwave one I open microwave one'],
  [['I put tomato 1 in microwave 1.'], 'one in microwave one'],
  [CARD, 'Alf World the house'], [CARD, 'Alf World the'], [CARD, 'Alf World'],
  [LINES, 'counter top three'], [LINES, 'Countered I take tomato one from countertop'],
  [LINES, 'I go to microwave one I open microwave one'], [LINES, 'one in microwave one'],
  [['Alright, back to the basics with one through five!'], 'All right'], // the user's bench, 2026-10-24 125.6 s: an energy cut on it
];
// the user's words over the same speech
const USER = [
  [REPLY, 'what about jupiter'], [['I go to countertop 3.'], 'put the tomato in the microwave'],
  [LINES, 'put the tomato in the microwave'], [LINES, 'take the tomato'], [LINES, 'go to the kitchen'],
  [LINES, 'what is in the fridge'], [LINES, 'new game'], [CARD, 'what can you do'], [CARD, 'start a new game'],
  [CARD, 'put the pencil in the drawer'], [CARD, 'tell me more'],
  [CARD, 'new game'], [CARD, 'put a mug in the sink'], [CARD, 'go to the fridge'],
  [LINES, 'put the apple in the fridge'], [LINES, 'open the fridge'], [LINES, 'what is on the table'],
];
// the user's words that start with hers, word for word: text cannot tell them from her echo, the segment's
// start can (her quiet longer than the recognizer's lag: no echo in it), checked on the dialog below
const SAME = [[CARD, 'put the apple in the fridge'], [LINES, 'go to countertop two']];
const past = (t, sp) => JSON.stringify(pastEcho(t, sp));
let minEcho = 1, maxUser = 0;
for (const [sp, t] of ECHOES) { const s = echoShare(t, sp); minEcho = Math.min(minEcho, s); check(`echo ${s.toFixed(2)} "${t}"`, isEcho(t, sp), s); }
for (const [sp, t] of USER) { const s = echoShare(t, sp); maxUser = Math.max(maxUser, s); check(`user ${s.toFixed(2)} "${t}"`, !isEcho(t, sp) && pastEcho(t, sp) === t, `${s} past "${pastEcho(t, sp)}"`); }
console.log(`     echoes share ${minEcho.toFixed(2)}–1.00, the user's words at most ${maxUser.toFixed(2)}; ECHO = ${ECHO}`);
for (const [sp, t] of SAME) console.log(`     her words first ${echoShare(t, sp).toFixed(2)} "${t}": past the echo "${pastEcho(t, sp)}", echo=${isEcho(t, sp)}`);
check('ECHO lies between them', minEcho >= ECHO && maxUser < ECHO, `${minEcho} ${maxUser}`);
for (const sp of [LINES, CARD, ['Stop the timer.']]) check(`"stop" is never echo (${sp[0].slice(0, 20)}…)`, !isEcho('stop', sp));
{ const Q = ['Have you ever thought about how all those different worlds manage to stay in orbit around the Sun?']; // Chrome, 2026-10-24
  check('the growing edge: "managed to" for "manage to" is echo', isEcho('Have you ever thought about how all those different worlds managed to', Q) && isEcho('managed to stay', Q),
    past('Have you ever thought about how all those different worlds managed to', Q)); }
{ const R = splitSentences('That sounds like a fun little experiment! Word dialogue is super interesting because it lets us explore how different ways of speaking can change the whole mood.'); // Chrome bench, 2026-10-24 28.3 s
  const t = 'That sounds like a fun little experiment can we continue to explore how different';
  check('her echo, the user\'s words, hers again: not echo, the user\'s words go on', !isEcho(t, R) && pastEcho(t, R).startsWith('can we continue'), past(t, R)); }
check('a short phrase of words she said apart is the user\'s', !isEcho('Can we', ['Word dialogue lets us explore how different ways of speaking can change the whole mood.']));
check('nothing said: nothing is echo', !isEcho('counter top three', []));
// the prefix split: the echo first, then the user
check('pastEcho: a re-spelled echo, then the user', pastEcho('counter top three put the apple in the fridge', LINES) === 'put the apple in the fridge', past('counter top three put the apple in the fridge', LINES));
check('pastEcho: a misheard word inside the echo stays in it', pastEcho('I take tomato won from countertop three', LINES) === '', past('I take tomato won from countertop three', LINES));
{ const LONG = splitSentences('There are 3 apples on the countertop and 12 eggs in the fridge, and the milk is on shelf 2. ' +
    'If you want, I can bring you the apples first, then the eggs, and after that the milk. Or I can wait here until you decide.');
  const t = 'there are three apples on the counter top and twelve eggs in the fridge and the milk is on shelf two if you want I can bring you the apples first then the eggs and after that the milk or I can wait here';
  check(`pastEcho: an interim grown across ${LONG.length} sentences is one echo after another`, pastEcho(t, LONG) === '' && pastEcho(`${t} no thanks bring the bread`, LONG) === 'no thanks bring the bread', past(`${t} no thanks bring the bread`, LONG)); }
check('pastEcho: words she said apart are the user\'s', pastEcho('what about jupiter', REPLY) === 'what about jupiter', past('what about jupiter', REPLY));

// ── the dialog over a narration backlog ───────────────────────────────
const table = JSON.parse(await readFile(new URL('../lib/fsttm.json', import.meta.url), 'utf8'));
function make() {
  let clock = 0;
  const events = [], calls = [];
  const tts = new FakeTTS();
  const d = new Dialog({ fsttm: new FSTTM(table, { now: () => clock }), attention: new Attention({ startAsleep: false }), tts,
    llm: async text => { calls.push(text); return { voice: '', firstMs: 1 }; },
    log: (kind, f) => events.push({ kind, ...f }), now: () => clock });
  return { d, tts, events, calls, adv: ms => { clock += ms; } };
}
const tick = () => new Promise(r => setTimeout(r, 0));
// the task's lines are said within 0.3 s and queue; the TTS speaks them one after another (~2 s each)
async function backlog(c, lines = LINES) {
  lines.forEach(l => c.d.say([l], 'narration'));
  for (let i = 0; i < lines.length; i++) { await tick(); c.adv(2000); c.tts.finish(); }
  await tick();
}

{ // the late finals of the journal, each heard while a later line is spoken
  const c = make();
  for (const l of LINES) c.d.say([l], 'narration');
  const heard = { 2: 'counter top three', 3: 'Countered I take tomato one from countertop', 5: 'I go to microwave one I open microwave one', 6: 'one in microwave one' };
  for (let i = 0; i < LINES.length; i++) {
    await tick(); c.adv(2000);
    if (heard[i]) { c.d.interim(heard[i]); await c.d.final(heard[i]); }
    c.tts.finish();
  }
  await tick();
  const echo = c.events.filter(e => e.kind === 'echo' && e.final).length;
  check('backlog: four late finals are echo, no LLM turn, no cut', echo === 4 && c.calls.length === 0 && !c.events.some(e => e.kind === 'cut'),
    `echo=${echo} llm=${c.calls} cuts=${c.events.filter(e => e.kind === 'cut').map(e => e.why)}`);
  check('backlog: every line said whole', c.tts.spoken.length === LINES.length && c.d.history.every(h => !h.interrupted), JSON.stringify(c.d.history));
}
{ // a line's final comes seconds after the line (the journal: 2–3 s); the 4 s window held only the last line
  const c = make(); await backlog(c); c.adv(6000);
  await c.d.final('one in microwave one');
  check('backlog ended 6 s ago: the line before the last is still echo', c.calls.length === 0, c.calls);
  c.adv(13000); await c.d.final('one in microwave one');
  check('past the window (12 s): the same words are the user\'s', c.calls.join() === 'one in microwave one', c.calls);
}
{ // the fsttm-web page itself (the user, 2026-10-24): a long reply, the user talks over it, the final is the
  // reply heard back re-spelled + the user's words; only the user's words reach the LLM
  const c = make();
  c.d.say(splitSentences('There are 3 apples on the countertop and 12 eggs in the fridge, and the milk is on shelf 2. ' +
    'If you want, I can bring you the apples first, then the eggs, and after that the milk.'), 'reply', 't1');
  await tick(); c.adv(4000); c.d.speechStart();
  c.d.interim('there are three apples on the counter top and twelve eggs');
  const held = c.tts.speaking;
  c.d.interim('there are three apples on the counter top and twelve eggs what about the');
  await c.d.final('there are three apples on the counter top and twelve eggs what about the bread');
  check('long reply: the echo re-spelled + the user\'s words → only the user\'s words reach the LLM',
    held && c.calls.join() === 'what about the bread' && c.events.find(e => e.kind === 'cut')?.interim === 'what about the', `held=${held} llm=${c.calls} cut=${JSON.stringify(c.events.find(e => e.kind === 'cut'))}`);
}
{ // the card line heard back as "Alf World the" was the loop
  const c = make(); c.d.say(CARD, 'narration'); await tick(); c.adv(2500);
  c.d.speechStart(); c.d.interim('Alf World the'); await c.d.final('Alf World the');
  check('card line: "Alf World the" over it is echo, no cut, no turn', c.tts.speaking && c.calls.length === 0 && !c.events.some(e => e.kind === 'cut'),
    `speaking=${c.tts.speaking} llm=${c.calls} cut=${c.events.find(e => e.kind === 'cut')?.why}`);
}
{ // the user's words while she narrates still barge in and reach the agent
  const c = make(); c.d.say(['I go to countertop 3.'], 'narration'); await tick(); c.adv(500);
  c.d.speechStart(); c.d.interim('put the tomato'); const cut = c.events.find(e => e.kind === 'cut')?.why;
  await c.d.final('put the tomato in the microwave');
  check('user words over a line: cut (words), the turn reaches the LLM', cut === 'words' && c.calls.join() === 'put the tomato in the microwave', `cut=${cut} llm=${c.calls}`);
}
{ // the echo first, then the user, in one growing interim (on-device recognition)
  const c = make(); c.d.say(['I take tomato 1 from countertop 3.'], 'narration'); await tick(); c.adv(500);
  c.d.speechStart(); c.d.interim('I take tomato one'); const mid = c.tts.speaking;
  c.d.interim('I take tomato one from countertop three new game');
  check('echo then user words: the echo holds, the user words cut', mid && c.events.find(e => e.kind === 'cut')?.interim === 'new game',
    `mid=${mid} cut=${JSON.stringify(c.events.find(e => e.kind === 'cut'))}`);
}
{ // her words first: after she was quiet, the segment holds no echo; over her, the same words are echo
  for (const [sp, t] of SAME) {
    const c = make(); c.d.say(sp, 'narration'); await tick(); c.adv(3000); c.tts.finish(); c.adv(1500);
    const words = t.split(' ');
    for (let i = 1; i <= words.length; i++) { c.d.interim(words.slice(0, i).join(' ')); c.adv(150); }
    await c.d.final(t);
    check(`"${t}" 1.5 s after her: the user's, whole`, c.calls.join() === t, c.calls);
    const o = make(); o.d.say(sp, 'narration'); await tick(); o.adv(3000); o.tts.finish(); o.adv(400);
    o.d.interim(words.slice(0, 2).join(' ')); o.adv(1100); await o.d.final(t);
    check(`"${t}" begun 0.4 s after her (the recognizer's lag): measured on text, her words stripped`, o.calls.join() !== t, o.calls);
  }
}
{ // the narrator's reading (F8) is echo: tts.narrating while read, the ring after (tts.onnarrated)
  const c = make(); c.tts.narrating = 'The plant is dry, water it today.';
  await c.d.final('the plant is dry water it to day');
  c.tts.onnarrated(c.tts.narrating); c.tts.narrating = null; c.adv(3000);
  await c.d.final('the plant is dry');
  check('the narrator\'s sentence heard back, while read and 3 s after: echo', c.calls.length === 0 && c.events.filter(e => e.kind === 'echo').length === 2, c.calls);
}
{ // "stop" at any time: over a line, over the card line, right after the backlog
  for (const [name, sp] of [['a line', ['I go to countertop 3.']], ['the card line', CARD]]) {
    const c = make(); c.d.say(sp, 'narration'); await tick(); c.adv(400);
    c.d.speechStart(); c.d.interim('stop');
    check(`"stop" over ${name}: cut at once (keyword)`, c.events.find(e => e.kind === 'cut')?.why === 'keyword' && !c.tts.speaking, JSON.stringify(c.events.at(-1)));
  }
  const c = make(); await backlog(c); c.adv(1000); await c.d.final('stop');
  check('"stop" just after the backlog: not echo', c.events.some(e => e.kind === 'keyword_stop'), JSON.stringify(c.events.slice(-3)));
}
{ // the recognizer on the echo-cancelled track: start(track), and the raw mic where a browser refuses it
  const { attachRecognizer } = await import('fsttm-web/dialog');
  const log = []; const dlg = { log: (k, f) => log.push([k, f]), speechStart() {}, interim() {}, final() {} };
  const track = { label: 'mic (cancelled)' };
  const rec = { starts: [], start(...a) { this.starts.push(a.length); }, stop() {} };
  const ctl = attachRecognizer(rec, dlg, { track }); rec.onend();
  check('start(track) at start and at every restart, the text echo off', rec.starts.join() === '1,1' && ctl.track === track && dlg.textEcho === false && log.some(([k, f]) => k === 'rec_track' && f.used), JSON.stringify([rec.starts, log]));
  const old = { starts: [], start(...a) { if (a.length) throw new TypeError('no track'); this.starts.push(0); }, stop() {} };
  log.length = 0; const ctl2 = attachRecognizer(old, dlg, { track }); old.onend();
  check('refused: the raw mic, logged once, the text echo on', old.starts.join() === '0,0' && ctl2.track === null && dlg.textEcho === true && log.filter(([k]) => k === 'rec_track').length === 1, JSON.stringify([old.starts, log]));
  // the user's bench (2026-10-24 12.2 s): "How are you today" dropped as her "…chat with you today" on the cancelled track
  const c = make(); c.d.textEcho = false; c.d.say(["Hello there! I'm so happy to chat with you today."], 'reply'); await tick(); c.adv(1500);
  c.d.interim('How are you today'); await c.d.final('How are you today');
  check('the text echo off: words like hers are the user\'s', c.calls.join() === 'How are you today', c.calls);
}
console.log(`${pass}/${pass + fail} echo checks`);
process.exit(fail ? 1 : 0);
