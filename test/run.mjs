// node test/run.mjs — the floor machine and the attention layer against the
// fixtures the Go harness runs (metis-agent go/internal/{fsm,attention}/
// testdata, copied verbatim; when that checkout is present the copies are
// compared byte for byte, so a change on either side fails here).
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { FSTTM } from 'fsttm-web/fsttm';
import { Attention } from 'fsttm-web/attention';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const json = async p => JSON.parse(await readFile(join(root, p), 'utf8'));
let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };

// drift: the copies are the Go side's files
const goDir = process.env.METIS_AGENT ?? join(homedir(), 'repo/perotheia-packages/metis-agent/go/internal');
for (const [mine, theirs] of [['lib/fsttm.json', 'fsm/testdata/fsttm.json'],
  ['lib/fixtures/fsttm-cases.json', 'fsm/testdata/fsttm-cases.json'],
  ['lib/fixtures/attention-cases.json', 'attention/testdata/attention-cases.json']]) {
  let other = null;
  try { other = await readFile(join(goDir, theirs), 'utf8'); } catch { console.log(`skip drift check: ${theirs} not found`); continue; }
  ok(other === await readFile(join(root, mine), 'utf8'), `${mine} differs from metis-agent ${theirs}`);
}

// FSTTM
const table = await json('lib/fsttm.json');
const c = await json('lib/fixtures/fsttm-cases.json');
let clock = 0;
const at = s => {
  const m = new FSTTM(table, { now: () => clock });
  for (const [actor, a] of c.setup[s]) actor === 'system' ? m.systemAction(a) : m.userAction(a);
  if (m.state !== s) throw new Error(`setup landed in ${m.state}, want ${s}`);
  return m;
};
const act = (m, actor, a) => { try { actor === 'system' ? m.systemAction(a) : m.userAction(a); return null; } catch (e) { return e; } };
for (const x of c.transitions) { const m = at(x.at); const e = act(m, x.actor, x.action); ok(!e && m.state === x.want, `${x.name}: ${m.state} ${e ?? ''}`); }
for (const x of c.illegal) { const m = at(x.at); ok(act(m, x.actor, x.action) !== null, `${x.name}: expected an error, landed in ${m.state}`); }
for (const x of c.sequences) {
  const m = at(x.at);
  for (const [i, [actor, a, want]] of x.steps.entries()) {
    const e = act(m, actor, a);
    if (e || m.state !== want) { ok(false, `${x.name} step ${i}: ${m.state} ${e ?? ''}, want ${want}`); break; }
    ok(true);
  }
}
for (const x of c.costs) {
  const got = at(x.at).systemActionsCost();
  for (const a of x.has) ok(a in got, `${x.at}: ${a} must be available`);
  for (const a of x.lacks) ok(!(a in got), `${x.at}: ${a} must be unavailable`);
}
for (const x of c.cost_order) { const g = at(x.at).systemActionsCost(); ok(g[x.greater] > g[x.than], `${x.at}: C(${x.greater}) > C(${x.than}): ${JSON.stringify(g)}`); }
for (const x of c.holds) { const m = at(x.at); ok(m.isSystem() === x.system && m.isUser() === x.user, `${x.at}: holds`); }

// attention
const a = await json('lib/fixtures/attention-cases.json');
const att = new Attention({ wakeWords: a.match.wake_words });
for (const x of a.match.cases) { const [w, r] = att.matchWake(x.text); ok(w === x.wake && r === x.rem, `matchWake(${x.text}) = ${w},${r}`); }
for (const s of a.sessions) {
  const g = new Attention({ enabled: s.enabled, wakeWords: s.wake_words, sleepPhrases: s.sleep_phrases, startAsleep: s.start_asleep });
  for (const [i, st] of s.steps.entries()) {
    const d = g.onUtterance(st.text);
    const state = g.enabled ? g.state : 'AWAKE';
    ok(d.action === st.action && (!st.out || d.text === st.out) && state === st.state,
      `${s.name} step ${i} ${st.text}: ${JSON.stringify(d)} ${state}`);
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
