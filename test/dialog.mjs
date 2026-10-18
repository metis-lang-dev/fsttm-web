// node test/dialog.mjs — the dialog's event table (web/eventtable.js), row by row, on dialog.js
import { readFile } from 'node:fs/promises';
import { runEventTable } from '../web/eventtable.js';
const table = JSON.parse(await readFile(new URL('../lib/fsttm.json', import.meta.url), 'utf8'));
const rows = await runEventTable(table);
for (const r of rows) console.log(`${r.pass ? 'ok  ' : 'FAIL'} [${r.policy}] ${r.signal} → ${r.action}\n       got: ${r.got}${r.pass ? '' : `\n      want: ${r.want}`}`);
const f = rows.filter(r => !r.pass).length;
console.log(`${rows.length - f}/${rows.length} rows`);
process.exit(f ? 1 : 0);
