// node test/asr.mjs — web/asr.js's scoring: E2's WER (lower case, no
// punctuation, no number folding) on whisper's own E2 rows, the manifest
// parse, the summary
import { readFile } from 'node:fs/promises';
import { wer, parseManifest, summarize } from '../web/asr.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// metis-agent go/results/e2/whisper.log: the same rows score the same here
for (const [ref, hyp, want] of [
  ['turn left ninety degrees', 'Turn left 90 degrees.', 0.25], ['go to april tag seven', 'Go to Apriltag 7.', 0.6],
  ['walk to april tag three', 'Walk to April tag 3.', 0.2], ['halt', 'Health.', 1], ['do a somersault', 'Do a somersal.', 1 / 3],
  ['stand up', 'Stand up.', 0], ['sit', '', 1]])
  ok(near(wer(ref, hyp), want), `wer("${ref}", "${hyp}") = ${wer(ref, hyp)}, want ${want}`);

const wavs = new URL('../../metis-agent/go/models/corpus-wav/manifest.tsv', import.meta.url);
const rows = parseManifest(await readFile(wavs, 'utf8').catch(() => '01-stand_up.wav\tstand up\tLOCAL_ACTION\tprompt\n'));
ok(rows.length === 54 || rows.length === 1, `manifest rows ${rows.length}`);
ok(rows[0].wav === '01-stand_up.wav' && rows[0].text === 'stand up' && rows[0].want === 'LOCAL_ACTION' && rows[0].split === 'prompt', 'manifest row 1');

const s = summarize([
  { split: 'prompt', final: 'stand up', wer: 0, intent: 'LOCAL_ACTION', want: 'LOCAL_ACTION', firstInterimMs: 300, finalAfterEndMs: 500 },
  { split: 'heldout', final: '', wer: 1, intent: null, want: 'STOP', firstInterimMs: null, finalAfterEndMs: null }]);
ok(s.all.n === 2 && s.all.heard === 1 && s.all.werMean === 0.5 && s.all.exact === 1 && s.all.intentOK === 1, `summary ${JSON.stringify(s.all)}`);
ok(s.prompt.n === 1 && s.heldout.intentOK === 0 && s.all.finalAfterEndP50 === 500, 'summary by split');

console.log(`asr: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
