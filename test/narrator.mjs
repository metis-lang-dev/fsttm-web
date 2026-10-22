// node test/narrator.mjs — the narrator's state machine (lib/narrator.js) on a stub synth,
// beside the dialog's BrowserTTS on the same synth: selection, press, stop, the yield to the
// dialog, the re-queue after a barge-in cancel, the key's press / double / hold.
import { BrowserTTS } from '../lib/tts.js';
import { Narrator, attachKey } from '../lib/narrator.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const tick = () => new Promise(r => setTimeout(r, 0));

// the stub synth: utterances queue; the test ends them; cancel() empties the queue and
// reports the queued ones as interrupted, as Chrome does
globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
class StubSynth {
  constructor() { this.q = []; this.spoken = []; this.cancels = 0; }
  speak(u) { this.q.push(u); this.spoken.push(u.text); u.onstart?.(); }
  cancel() { this.cancels++; const q = this.q; this.q = []; for (const u of q) u.onerror?.({ error: 'interrupted' }); }
  end() { const u = this.q.shift(); u?.onend?.(); return u; }   // the current utterance finishes
}
const TEXT = 'The lamp is on. The plant is dry, water it today. The dog sleeps.';
const S = ['The lamp is on.', 'The plant is dry, water it today.', 'The dog sleeps.'];
function setup() {
  const synth = new StubSynth();
  const tts = new BrowserTTS(synth, { rate: 1 });
  const n = new Narrator({ tts, rate: 1.3 });
  const states = [];
  n.onchange = s => states.push(`${s.state}:${s.i}`);
  return { synth, tts, n, states };
}

// 1. select then press: the first sentence is spoken at the narrator's rate; onend advances; the end stops
{
  const { synth, n, states } = setup();
  ok(n.select(TEXT) && n.state === 'stopped' && n.n === 3, 'a selection resets to its sentences, stopped');
  ok(!n.select(TEXT) && !n.select('  ') && !n.select('The lamp is on.\n\tThe plant is dry, water it today.\nThe dog sleeps.'), 'the same text (whitespace aside) or an empty one changes nothing');
  n.press();
  ok(n.state === 'reading' && synth.q[0]?.text === S[0] && synth.q[0].rate === 1.3, 'press reads sentence 1 at the narrator rate');
  synth.end();
  ok(n.i === 1 && synth.spoken[1] === S[1], 'onend advances to sentence 2');
  synth.end(); synth.end();
  ok(n.state === 'stopped' && n.i === 3 && synth.q.length === 0, 'the end stops it');
  n.press();
  ok(n.state === 'reading' && n.i === 0 && synth.spoken.at(-1) === S[0], 'a press after the end reads from the top');
  ok(states[0] === 'stopped:0' && states.includes('reading:0'), 'onchange saw the states');
}

// 2. pause and resume: the sentence is cut and read again from its start; stop clears
{
  const { synth, n } = setup();
  n.select(TEXT); n.press(); synth.end();                  // reading sentence 2
  n.press();
  ok(n.state === 'paused' && synth.cancels === 1 && synth.q.length === 0 && n.i === 1, 'press while reading pauses: cut, cursor kept');
  n.press();
  ok(n.state === 'reading' && synth.q[0]?.text === S[1], 'press while paused resumes the same sentence from its start');
  n.stop();
  ok(n.state === 'stopped' && n.i === 0 && synth.q.length === 0, 'stop is silent, cursor at the top');
}

// 3. a new selection while reading resets; a press reads the new text
{
  const { synth, n } = setup();
  n.select(TEXT); n.press();
  n.select('Only this word.');
  ok(n.state === 'stopped' && n.n === 1 && synth.q.length === 0, 'a new selection while reading: cut, stopped at the new text');
  n.press();
  ok(synth.spoken.at(-1) === 'Only this word.', 'the press reads the new selection');
}

// 4. the dialog speaks: the narrator yields before the dialog's utterance is queued and
//    resumes at its cursor after the dialog's onend; a chain of two is one yield
{
  const { synth, tts, n } = setup();
  n.select(TEXT); n.press(); synth.end();                  // reading sentence 2
  let dialogEnded = null;
  tts.speak(['I move to the panel.', 'Done.'], { onend: c => { dialogEnded = c; } });
  ok(n.state === 'yielding' && synth.q.length === 1 && synth.q[0].text === 'I move to the panel.', 'the narrator yields; only the dialog is queued');
  synth.end();                                             // the dialog's first sentence
  ok(n.state === 'yielding' && synth.q[0]?.text === 'Done.', 'still yielding through the chain');
  synth.end(); await tick();
  ok(dialogEnded === true && n.state === 'reading' && n.i === 1 && synth.q[0]?.text === S[1], 'after the dialog: reading again at the same sentence');
  n.press();
  ok(n.state === 'paused', 'press while reading after a yield pauses');
}

// 5. a press while yielding pauses: the dialog's end does not resume it
{
  const { synth, tts, n } = setup();
  n.select(TEXT); n.press();
  tts.speak(['Yes.']);
  n.press();
  ok(n.state === 'paused', 'press while yielding → paused');
  synth.end(); await tick();
  ok(n.state === 'paused' && synth.q.length === 0, 'the dialog ending leaves it paused');
}

// 6. a barge-in cancel of the dialog (the synth's whole queue gone) re-queues the narrator's sentence
{
  const { synth, tts, n } = setup();
  n.select(TEXT); n.press(); synth.end();                  // reading sentence 2
  tts.speak(['A long answer.']);                            // yield
  tts.cancel();                                            // the person barged in: the dialog's speech cut
  ok(n.state === 'yielding' && synth.q.length === 0, 'after the cancel the narrator waits');
  await tick();
  ok(n.state === 'reading' && synth.q[0]?.text === S[1] && n.i === 1, 'then re-queues the same sentence');
  // a cancel with no dialog speech (the dialog cuts an idle tts) does not lose the sentence either
  tts.cancel(); await tick();
  ok(n.state === 'reading' && synth.q[0]?.text === S[1], 'an idle cancel re-queues it too');
}

// 7. the dialog starts while the narrator is paused or stopped: nothing changes for it
{
  const { synth, tts, n } = setup();
  n.select(TEXT);
  tts.speak(['Hello.']); synth.end(); await tick();
  ok(n.state === 'stopped', 'stopped stays stopped');
  n.press(); n.press();
  tts.speak(['Hi.']); synth.end(); await tick();
  ok(n.state === 'paused', 'paused stays paused');
}

// 8. a press while the dialog is speaking waits (yielding), then reads
{
  const { synth, tts, n } = setup();
  n.select(TEXT);
  tts.speak(['One moment.']);
  n.press();
  ok(n.state === 'yielding' && synth.q.length === 1, 'press during dialog speech: yielding, nothing queued');
  synth.end(); await tick();
  ok(n.state === 'reading' && synth.q[0]?.text === S[0], 'reads once the dialog is done');
}

// 9. the key: press, double press, hold
{
  const { n } = setup();
  n.select(TEXT);
  const handlers = {};
  const target = { addEventListener: (k, h) => { handlers[k] = h; }, removeEventListener: () => {} };
  const off = attachKey(n, target, { key: 'F8', long: 40, double: 30 });
  const ev = key => ({ key, repeat: false, preventDefault() {} });
  handlers.keydown(ev('F8')); handlers.keyup(ev('F8'));
  ok(n.state === 'reading', 'a press starts');
  await new Promise(r => setTimeout(r, 35));
  handlers.keydown(ev('F8')); handlers.keyup(ev('F8'));
  ok(n.state === 'paused', 'a press after the double window pauses');
  handlers.keydown(ev('F8')); handlers.keyup(ev('F8'));     // within 30 ms of the last: a double → stop
  ok(n.state === 'stopped', 'a double press stops');
  await new Promise(r => setTimeout(r, 35));
  handlers.keydown(ev('F8'));
  await new Promise(r => setTimeout(r, 50));                // held past `long`
  ok(n.state === 'stopped', 'a hold stops (here: stays stopped)');
  handlers.keyup(ev('F8'));
  ok(n.state === 'stopped', 'the release after a hold does not press');
  handlers.keydown(ev('Enter')); handlers.keyup(ev('Enter'));
  ok(n.state === 'stopped', 'other keys are not the narrator\'s');
  off();
}

console.log(`${pass}/${pass + fail} narrator checks`);
process.exit(fail ? 1 : 0);
