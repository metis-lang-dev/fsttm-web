// node test/parity.mjs [base]  — the parity run from the shell, through the
// page's own llm.js/parity.js against a running ./run.sh. Writes
// test/out/parity.jsonl and prints the table; exit 1 below 54/54.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAssets } from '../web/llm.js';
import { parseCorpus, parseRef, runParity, summarize } from '../web/parity.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const base = process.argv[2] ?? 'http://127.0.0.1:8393';
const where = { 'dog-prompt.txt': 'prompt', 'pass2-examples-gemma4.txt': 'prompt', 'dog.gbnf': 'grammar' };
const assets = await loadAssets(f => readFile(join(root, where[f], f), 'utf8'));
const rows = parseCorpus(await readFile(join(root, 'test/fixtures/dog-corpus.tsv'), 'utf8'));
const ref = parseRef(await readFile(join(root, 'test/fixtures/harness-e2b.jsonl'), 'utf8'));

const recs = [];
for await (const r of runParity(base, assets, rows, ref)) {
  recs.push(r);
  const mark = r.class ? (r.same ? 'same' : 'DIFF') : 'MISS';
  console.log(`${mark.padEnd(4)} ${r.utt.padEnd(40)} ${r.got.padEnd(13)} first=${String(r.firstMs).padStart(4)}ms ` +
    `p1 eval=${r.p1PromptN} cached=${r.p1Cached}  ${r.json}${r.same === false ? `  harness=${r.harnessJson}` : ''}`);
  console.log(`${' '.repeat(5)}voice → ${JSON.stringify(r.voice)}   (harness ${JSON.stringify(r.harnessVoice)})`);
}
const s = summarize(recs);
await mkdir(join(root, 'test/out'), { recursive: true });
await writeFile(join(root, 'test/out/parity.jsonl'), recs.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`\n== intent class ${s.classOK}/${s.n}, pass-1 JSON identical to the harness ${s.same}/${s.n}; ` +
  `first token p50=${s.firstP50}ms p90=${s.firstP90}ms; prompt tokens evaluated: row 1 ${s.p1PromptNFirst}, later rows max ${s.p1PromptNMax}`);
process.exit(s.classOK === s.n ? 0 : 1);
