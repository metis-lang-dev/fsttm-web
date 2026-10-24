// node test/bench.mjs — Bench's numbers kept as the events come (no pass over the events on a redraw)
// against metricsOf, the same numbers from the whole list in one go, on random dialog streams.
import { Bench, metricsOf } from '../lib/bench.js';

let pass = 0, fail = 0, seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = a => a[Math.floor(rnd() * a.length)];
const SAY = ['', 'stop', 'what about the moon', 'no wait', 'go on then'];
for (let run = 0; run < 200; run++) {
  let clock = 0;
  const b = new Bench({ now: () => clock });
  for (let i = 0; i < 60; i++) {
    clock += rnd() < .15 ? 0 : Math.floor(rnd() * 1500);   // equal times now and then
    const k = pick(['speak', 'tts_end', 'cut', 'final', 'echo', 'llm', 'fsttm', 'interim']);
    const f = k === 'cut' ? { why: pick(['words', 'energy', 'final']), onsetToCutMs: rnd() < .8 ? Math.floor(rnd() * 900) : null, interim: rnd() < .6 ? pick(SAY) : null }
      : k === 'speak' ? { freeuDwell: rnd() < .7 ? Math.floor(rnd() * 400) : null }
      : k === 'final' ? { text: pick(SAY) } : k === 'llm' ? { firstMs: rnd() < .9 ? Math.floor(rnd() * 300) : null, ms: Math.floor(rnd() * 900) } : {};
    b.log(k, f);
  }
  const a = JSON.stringify(b.metrics()), want = JSON.stringify(metricsOf(b.events));
  if (a === want) pass++; else { fail++; if (fail < 4) console.log(`FAIL run ${run}\n  got:  ${a}\n  want: ${want}`); }
}
console.log(`${pass}/${pass + fail} bench checks`);
process.exit(fail ? 1 : 0);
