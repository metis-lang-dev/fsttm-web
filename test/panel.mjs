// node test/panel.mjs — the panel's logic (lib/panel.js PanelCore) on a fake backend and
// the event table's fake TTS: one entry for every input, the intent chat's rows, the
// narration, a cut back to the backend, the two channels and the quasimode.
import { readFile } from 'node:fs/promises';
import { PanelCore, holdable } from '../lib/panel.js';
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

await tick();
console.log(`${pass}/${pass + fail} panel checks`);
process.exit(fail ? 1 : 0);
