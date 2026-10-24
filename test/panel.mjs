// node test/panel.mjs — the panel's logic (lib/panel.js PanelCore) on a fake backend and
// the event table's fake TTS: one entry for every input, the intent chat's rows, the
// narration, a cut back to the backend, the two channels and the quasimode.
import { readFile } from 'node:fs/promises';
import { PanelCore, holdable, BARGE_IN, SECTIONS } from '../lib/panel.js';
import { Attention } from '../lib/attention.js';
import { FakeTTS } from '../web/eventtable.js';

const table = JSON.parse(await readFile(new URL('../lib/fsttm.json', import.meta.url), 'utf8'));
let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const tick = () => new Promise(r => setTimeout(r, 0));

class FakeBackend {
  constructor() { this.turns = []; this.cuts = []; this.heards = []; this.info = {}; this.onFrame = () => {}; }
  async *turn(id, text, mode) {
    this.turns.push({ id, text, mode });
    this.info[id] = { json: JSON.stringify({ intent: 'GO', widget: text.split(' ').pop().toUpperCase() }) };
    yield `I move to ${text.split(' ').pop()}.`;
  }
  cut(id, heard) { this.cuts.push([id, heard]); }
  heard(id, text) { this.heards.push([id, text]); }
}

function make(opts = {}) {
  const backend = new FakeBackend(), tts = new FakeTTS(), states = [], channels = [], frames = [], events = [];
  const side = opts.side === false ? null : { label: 'the chat', sent: [], send: async t => { side.sent.push(t); return `noted: ${t}`; } };
  const p = new PanelCore({ backend, table, tts, side, onState: s => states.push(s), onChannel: (c, how) => channels.push([c, how]),
    onFrame: f => frames.push(f), log: k => events.push(k), ...opts });
  return { p, backend, tts, side, states, channels, frames, events };
}
const rows = p => p.rows.map(r => `${r.who}${r.via ? ':' + r.via : ''}${r.channel === 'side' ? ':side' : ''} ${r.text}`);

// 1. a typed line, a script's say and a recognized utterance: one path, rows by source
{
  const { p, backend, tts } = make();
  await p.say('go to the panel', { via: 'text' });
  ok(backend.turns.length === 1 && backend.turns[0].text === 'go to the panel' && backend.turns[0].mode === 'intent', 'a typed line is a backend turn');
  ok(JSON.stringify(rows(p)) === JSON.stringify(['person:text go to the panel', 'intent {"intent":"GO","widget":"PANEL"}', 'agent I move to panel.']),
    `the intent chat: ${JSON.stringify(rows(p))}`);
  ok(tts.spoken[0] === 'I move to panel.' && p.rows[2].tags.includes('spoken'), 'the reply is voiced and tagged spoken');
  tts.finish();
  await p.say('go to the note');
  ok(p.rows[3].via === 'say', 'panel.say(text) is the same entry, marked say');
  tts.finish();
  let rec = null;
  p.listen({ start() { rec = this; }, stop() {} });
  ok(p.state().listening && rec, 'listen attaches the recognizer');
  rec.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: 'go to the side' }], { isFinal: true })] });
  for (let i = 0; i < 5; i++) await tick();      // the recognizer does not await the turn
  ok(p.rows.at(-3).via === 'voice' && backend.turns.length === 3, 'a recognized final takes the same path, marked voice');
  tts.finish();
  await p.say('   ');
  ok(backend.turns.length === 3, 'an empty line is no turn');
  // the echo-cancelled mic: the recognizer listens to its track, the textual echo is off; unlisten stops it
  p.unlisten();
  let stopped = 0, args = null;
  const stream = { getAudioTracks: () => [{ label: 'cancelled' }], getTracks: () => [{ stop: () => stopped++ }] };
  p.listen({ start(...a) { args = a; }, stop() {} }, { stream });
  ok(args?.[0]?.label === 'cancelled' && p.dialog.textEcho === false && p.recognizer.track, 'listen on a stream: start(track), the textual echo off');
  p.unlisten();
  ok(stopped === 1 && p.stream === null, 'unlisten stops the stream');
  p.listen({ start() {}, stop() {} });
  ok(p.dialog.textEcho === true, 'the raw mic: the textual echo on');
  p.unlisten();
}

// 2. voice off: the chat, no speech
{
  const { p, tts } = make({ voice: false });
  await p.say('go to the panel');
  ok(tts.spoken.length === 0 && p.rows.length === 3, 'voice off: rows, nothing spoken');
}

// 3. the backend's narration: a row, voiced when the floor is free, heard back
{
  const { p, backend, tts, frames } = make();
  const before = p.rows.length;
  p.backend.onFrame({ ev: 'narration', id: 'r6', kind: 'v3-turn', sentence: 'The game is over: start a new game to give another task.' });
  ok(p.rows.length === before, 'a v3-turn narration is the turn\'s voice: no row of its own, nothing spoken');
  p.backend.onFrame({ ev: 'narration', id: 'r7', kind: 'v3-voice', sentence: 'The modal dialog is up.' });
  ok(p.rows[0].who === 'agent' && p.rows[0].narration === 'v3-voice' && tts.spoken[0] === 'The modal dialog is up.', 'a narration is a row and is voiced');
  tts.finish();
  ok(JSON.stringify(backend.heards) === JSON.stringify([['r7', 'The modal dialog is up.']]), `heard back: ${JSON.stringify(backend.heards)}`);
  p.backend.onFrame({ ev: 'narration', id: 'r8', form: 'R', sentence: 'shown, not voiced' });
  ok(tts.spoken.length === 1 && p.rows.length === 2, 'form R: shown, never voiced');
  p.backend.onFrame({ ev: 'journal', rec: { seq: 1 } });
  ok(frames.length === 1 && frames[0].ev === 'journal', "an application's own frame goes to onFrame");
}

// 4. a barge-in: the reply cut, the backend told what was heard, the row tagged
{
  const { p, backend, tts } = make();
  await p.say('go to the panel');
  tts.progress(5);
  await p.say('stop it, go home now');
  ok(backend.cuts.length === 1 && backend.cuts[0][0] === 't1' && backend.cuts[0][1] === 'I mov', `the cut: ${JSON.stringify(backend.cuts)}`);
  ok(p.rows[2].tags.some(t => t.startsWith('cut · heard "I mov"')), `the row's tags: ${JSON.stringify(p.rows[2].tags)}`);
  ok(backend.turns.length === 2, 'the barge-in is the next turn');
}

// 5. the side channel: flip, the side's words, no cut to the backend
{
  const { p, backend, tts, side, channels } = make();
  ok(p.flip() && p.state().channel === 'side', 'flip: the side channel');
  await p.say('the lamp should dim before it goes dark', { via: 'text' });
  ok(backend.turns.length === 0 && side.sent[0] === 'the lamp should dim before it goes dark', 'a side turn goes to side.send, not the backend');
  ok(JSON.stringify(rows(p)) === JSON.stringify(['person:text:side the lamp should dim before it goes dark', 'agent:side noted: the lamp should dim before it goes dark']),
    `side rows: ${JSON.stringify(rows(p))}`);
  tts.progress(3);
  await p.say('and brighten after');
  ok(backend.cuts.length === 0, "a side reply's cut is not the backend's");
  ok(p.flip() && p.state().channel === 'main' && JSON.stringify(channels) === JSON.stringify([['side', 'flip'], ['main', 'flip']]), `flips: ${JSON.stringify(channels)}`);
}

// 6. the quasimode: the side channel only while held
{
  const { p, channels } = make();
  ok(p.hold() && p.state().channel === 'side' && p.state().held, 'hold: the side channel, held');
  ok(!p.hold(), 'a second hold is nothing');
  ok(p.release() && p.state().channel === 'main' && !p.state().held, 'release: back to main');
  ok(!p.release(), 'a release without a hold is nothing');
  p.flip();
  p.hold();
  p.release();
  ok(p.state().channel === 'side', 'a hold from the side channel releases back to the side');
  ok(JSON.stringify(channels) === JSON.stringify([['side', 'held'], ['main', 'flip'], ['side', 'flip']]), `channels: ${JSON.stringify(channels)}`);
}

// 7. no side channel: flip and hold refuse; the mode and the floor in the state
{
  const { p, states } = make({ side: false });
  ok(!p.flip() && !p.hold() && p.state().channel === 'main', 'no side: flip and hold refuse');
  p.setMode('dictation');
  ok(states.at(-1).mode === 'dictation', 'setMode shows the page’s mode');
  await p.say('go to the panel');
  ok(states.some(s => s.floor === 'SYSTEM'), `the floor in the state: ${[...new Set(states.map(s => s.floor))]}`);
}

// 8. the dialog's own rules still hold: a stop phrase never reaches a turn, the page hears of it
{
  const { p, backend, events } = make();
  await p.say('stop');
  ok(backend.turns.length === 0 && events.includes('keyword_stop'), 'a stop phrase: no turn, keyword_stop to the page');
}

// 9. the source rides with its own final: a dropped utterance shifts no later label (review P-2)
{
  const { p, tts } = make();
  await p.say('stop', { via: 'text' });                 // a stop phrase: dropped by the floor, no turn
  await p.say('go to the panel', { via: 'voice' });
  tts.finish();
  await p.say('go to the note');
  ok(JSON.stringify(p.rows.filter(r => r.who === 'person').map(r => r.via)) === JSON.stringify(['voice', 'say']),
    `the sources after a dropped line: ${JSON.stringify(p.rows.filter(r => r.who === 'person').map(r => r.via))}`);
}

// 10. the core keeps as many rows as it shows (review P-3)
{
  const { p, tts } = make({ maxRows: 5 });
  for (let i = 0; i < 4; i++) { await p.say(`go to w${i}`); tts.finish(); }
  ok(p.rows.length === 5 && p.rows.at(-1).n === 12 && p.turns.size <= 5, `capped: ${p.rows.length} rows, last n ${p.rows.at(-1).n}, ${p.turns.size} turns`);
}

// 11. a held Space is push-to-talk only where Space means nothing else (review P-1)
{
  const E = (tagName, attrs = {}, editable = false) => ({ tagName, isContentEditable: editable,
    getAttribute: k => attrs[k] ?? null, hasAttribute: k => k in attrs });
  ok(holdable(null) && holdable(E('BODY')) && holdable(E('DIV')) && holdable(E('UL')) && holdable(E('MAIN', { role: 'region' })),
    'holdable: the body, a container, a list');
  ok(!holdable(E('BUTTON')) && !holdable(E('SUMMARY')) && !holdable(E('A', { href: '#' })) && !holdable(E('INPUT', { type: 'checkbox' })),
    'not holdable: a button, a summary, a link, a checkbox');
  ok(!holdable(E('DIV', { role: 'button' })) && !holdable(E('SPAN', { role: 'tab' })) && !holdable(E('LI', { role: 'option' })),
    'not holdable: role button, tab, option');
  ok(!holdable(E('TEXTAREA')) && !holdable(E('DIV', {}, true)) && holdable(E('A')), 'not holdable: a text field, an editable; an anchor without href is');
}

// the strip: barge-in live on the dialog, attention where there is a wake word, the reply mode the backend gets
{
  const { p, backend, tts } = make({ modes: [{ value: 'talk', label: 'long' }, { value: 'intent', label: 'short' }],
    attention: new Attention({ wakeWords: ['computer'], startAsleep: true }) });
  ok(BARGE_IN.join() === 'words,energy,none' && p.state().bargeIn === 'words', 'barge-in: words by default');
  ok(p.setBargeIn('energy') && p.dialog.bargeIn === 'energy' && p.state().bargeIn === 'energy', 'setBargeIn: live on the dialog and in the state');
  ok(!p.setBargeIn('loud') && p.dialog.bargeIn === 'energy', 'an unknown policy changes nothing');
  ok(p.bench.events.some(e => e.kind === 'policy' && e.bargeIn === 'energy'), 'the policy change is an event');
  ok(p.state().wakeable && p.state().attention === 'ASLEEP', 'attention: asleep at the start (a wake word)');
  p.setAttention(true);
  ok(p.state().attention === 'AWAKE' && p.bench.events.some(e => e.kind === 'attention' && e.forced === 'switch'), 'setAttention wakes her, an event');
  ok(p.state().reply === 'talk' && p.state().modes.length === 2, 'the reply mode: the first of modes');
  await p.say('go to the panel', { via: 'text' });
  ok(backend.turns[0].mode === 'talk', 'a turn gets the reply mode');
  tts.finish();
  ok(p.setReply('intent') && !p.setReply('poetry') && p.state().reply === 'intent', 'setReply: one of modes only');
  await p.say('go to the note');
  ok(backend.turns[1].mode === 'intent', 'the next turn the new mode');
  tts.finish();
  ok(p.timings.length === 2 && p.timings[0].mode === 'long' && p.timings[0].end === 'spoken' && p.timings[1].mode === 'short', `the turns' timings, by mode label: ${JSON.stringify(p.timings)}`);
  ok(p.bench.events.some(e => e.kind === 'typed') && p.bench.events.filter(e => e.kind === 'llm').length === 2, 'the bench keeps the events (typed, llm)');
  p.setAttention(false);
  await p.say('hello there', { via: 'voice' });
  ok(p.rows.at(-1).who === 'note' && /ignored: asleep — say "computer/.test(p.rows.at(-1).text), 'asleep: a voice line is ignored, said in a note');
  await p.say('hello there', { via: 'text' });
  ok(p.state().attention === 'AWAKE' && backend.turns.at(-1).text === 'hello there', 'typing wakes her: a typed line is a turn');
  tts.finish();
}
// no modes, no wake word: the strip's reply and attention have nothing to show
{
  const { p, backend } = make();
  ok(p.state().modes === null && p.state().reply === 'intent' && !p.state().wakeable && p.state().attention === 'AWAKE', 'no modes: intent; no wake word: always awake');
  await p.say('go to the panel');
  ok(backend.turns[0].mode === 'intent', "a backend without modes gets 'intent'");
  ok(p.state().recognizer === 'off', 'the recognizer off');
  p.event('recognition', { api: true, processLocally: true });
  p.listen({ start() {}, stop() {} }, { stream: { getAudioTracks: () => [{ label: 'x' }], getTracks: () => [] } });
  ok(p.state().recognizer === 'echo-cancelled track · on-device', `the recognizer named: ${p.state().recognizer}`);
  p.unlisten();
}
// the narration rule, the stop note, the echo before a final, the application's frames as events
{
  const { p, tts, frames } = make({ narrate: f => f.kind === 'announce', frames: f => f.ev === 'runtime' });
  p.backend.onFrame({ ev: 'narration', id: 'a1', kind: 'quiescence', form: 'N', sentence: 'All quiet.' });
  ok(tts.spoken.length === 0 && /shown, not voiced/.test(p.rows.at(-1).meta), 'narrate(): a kind it does not voice is shown, not voiced');
  p.backend.onFrame({ ev: 'narration', id: 'a2', kind: 'announce', form: 'N', sentence: 'The door opened.' });
  ok(tts.spoken.at(-1) === 'The door opened.', 'narrate(): a kind it voices is spoken');
  tts.finish();
  p.backend.onFrame({ ev: 'runtime', kind: 'tick', n: 3 });
  ok(frames.at(-1).ev === 'runtime' && p.bench.events.some(e => e.kind === 'frame' && e.ev === 'runtime' && e.of === 'tick' && e.n === 3), "the application's frame: the page's, and an event of kind frame where kept");
  p.backend.onFrame({ ev: 'cut', id: 'x', heard: 'not a barge-in' });
  ok(frames.at(-1).ev === 'cut' && !p.bench.events.some(e => e.ev === 'cut' || (e.kind === 'cut' && e.heard === 'not a barge-in')), "an application's frame named like a dialog kind: not kept, never a cut");
  p.dialog.say(['Mountains are tall and very old, older than the rivers.'], 'announce'); tts.finish();   // her words, heard back on the raw mic
  await p.say('mountains are tall and very old what about the moon', { via: 'voice' });
  const moon = p.rows.find(r => r.who === 'person' && r.text === 'what about the moon');
  ok(moon?.tags[0] === 'her echo before it dropped: "mountains are tall and very old"', `the echo before a final tags its row: ${JSON.stringify(moon)}`);
  tts.finish();
  await p.say('stop');
  ok(p.rows.at(-1).who === 'note' && p.rows.at(-1).text === 'stop: "stop"', 'a stop phrase: a note');
  ok(Object.keys(SECTIONS).join() === 'floor,state,turns,events', 'the sections: floor, state, turns, events');
}

// the host's backchannel: chat as the person and as her, ctl; the rows, events and state back (host: true)
{
  const { p, backend, tts } = make({ host: true, modes: ['talk', 'intent'] });
  const sent = []; backend.send = f => sent.push(f);
  const of = ev => sent.filter(f => f.ev === ev);
  backend.onFrame({ ev: 'chat', who: 'user', text: 'go to the panel' });
  for (let i = 0; i < 5; i++) await tick();
  ok(backend.turns.at(-1)?.text === 'go to the panel' && p.rows.find(r => r.who === 'person')?.via === 'host', 'chat{user}: the one entry, a turn, the row via host');
  const user = of('chat').find(f => f.who === 'user');
  ok(user?.text === 'go to the panel' && user.via === 'host' && user.id === backend.turns.at(-1).id, 'back: chat{user} with its source and turn id', user);
  ok(of('chat').some(f => f.who === 'intent') && of('chat').some(f => f.who === 'system' && f.text === 'I move to panel.' && f.via === 'backend'), 'back: the intent row and her reply');
  ok(of('chat').some(f => f.who === 'system' && f.text === 'I move to panel.' && f.tags.includes('spoken')), 'back: the reply again when tagged spoken');
  tts.finish();
  backend.onFrame({ ev: 'chat', who: 'system', text: 'The door is open.' });
  ok(tts.spoken.at(-1) === 'The door is open.' && of('chat').some(f => f.who === 'system' && f.via === 'host' && f.text === 'The door is open.' && f.kind === 'announce'), 'chat{system}: her words, spoken, back as the host\'s');
  tts.finish();
  backend.onFrame({ ev: 'chat', who: 'system', text: 'Shown only.', voice: false });
  ok(tts.spoken.at(-1) !== 'Shown only.' && p.rows.at(-1).text === 'Shown only.', 'chat{system, voice:false}: shown, not spoken');
  backend.onFrame({ ev: 'ctl', barge_in: 'energy', voice: false, reply: 'intent' });
  ok(p.dialog.bargeIn === 'energy' && !p.voice && p.reply === 'intent', 'ctl: barge-in, voice, reply');
  const st = of('state').at(-1);
  ok(st?.barge_in === 'energy' && st.voice === false && st.reply === 'intent', 'back: the state after it', st);
  const n = of('state').length; p.changed(); p.changed();
  ok(of('state').length === n, 'the state goes back on a change only');
  backend.onFrame({ ev: 'ctl', mode: 'talk' });
  ok(p.reply === 'talk', "ctl{mode}: the reply mode's other name");
  let mic = null; p.onMic = on => { mic = on; };
  backend.onFrame({ ev: 'ctl', mic: true });
  ok(mic === true, 'ctl{mic}: to the view');
  ok(of('event').some(e => e.kind === 'ctl') && of('event').some(e => e.kind === 'fsttm') && of('event').every(e => typeof e.t === 'number'), 'back: every dialog event, timed');
  ok(!p.bench.events.some(e => e.kind === 'chat' || e.kind === 'ctl' && e.of), 'the host frames are not taken for the application\'s own');
}
// a page that does not opt in sends nothing back
{
  const { p, backend } = make();
  const sent = []; backend.send = f => sent.push(f);
  backend.onFrame({ ev: 'chat', who: 'user', text: 'go to the door' });
  for (let i = 0; i < 5; i++) await tick();
  ok(backend.turns.length === 1 && sent.length === 0, 'no host: chat{user} still the one entry, nothing sent back');
}

await tick();
console.log(`${pass}/${pass + fail} panel checks`);
process.exit(fail ? 1 : 0);
