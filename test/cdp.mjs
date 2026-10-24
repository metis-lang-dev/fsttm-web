// cdp.mjs — the browser suite's harness (test/*_e2e.mjs; a copy of metis-worlds' web/tests/cdp.mjs,
// served as the Python mount serves the page: / is web/, /lib/ is lib/, /assets/<name> the prompt
// and the grammar): headless Chrome over the DevTools protocol, real mouse and key events.
// Node >= 22 (its WebSocket); CHROME=… else google-chrome.
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';

if (typeof WebSocket === 'undefined') { console.log('FAIL node >= 22 is needed (its WebSocket)'); process.exit(1); }

const ROOT = resolve(new URL('..', import.meta.url).pathname);
// the URL path → the file: the page's own (web/), the library (lib/), the assets (prompt/, grammar/)
function file(path) {
  if (path === '/' || path === '') path = '/index.html';
  if (path.startsWith('/lib/')) return join(ROOT, path);
  if (path.startsWith('/assets/')) { const n = path.slice(8); return join(ROOT, n.endsWith('.gbnf') ? 'grammar' : 'prompt', n); }
  return join(ROOT, 'web', path);
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.jsonl': 'application/json', '.png': 'image/png' };
export const sleep = ms => new Promise(r => setTimeout(r, ms));
const CODES = { Enter: 13, Escape: 27, Tab: 9, F8: 119, F9: 120, ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40 };

// open(path): the page at path (as the mount serves it: 'index.html?backend=stub'), its ready flag awaited
export async function open(path, { width = 1200, height = 900 } = {}) {
  const server = createServer((req, res) => {
    const p = normalize(file(decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!p.startsWith(ROOT) || !existsSync(p) || !statSync(p).isFile()) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(p)] || 'application/octet-stream' });
    createReadStream(p).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const PORT = 9000 + Math.floor(Math.random() * 900);
  const prof = mkdtempSync(join(tmpdir(), 'fw-chrome-'));
  const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${prof}`, `--window-size=${width},${height}`, '--no-first-run', 'about:blank'], { stdio: 'ignore', detached: true });
  for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(200); } }
  const url = `http://127.0.0.1:${server.address().port}/${path}`;
  // a blank tab, then the page: /json/new?<url> cuts the URL at its first & (?backend=stub&voice=0)
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
  await new Promise(r => ws.addEventListener('open', r));
  const cmd = (method, params = {}) => new Promise(r => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const ev = async expr => {
    const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result?.result?.value;
  };
  const center = sel => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);
  const page = {
    cmd, ev, center,
    async goto(p) { await cmd('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${p}` }); await page.ready(); },
    async ready() { for (let i = 0; i < 150 && (await ev('document.body?.dataset.ready').catch(() => null)) !== '1'; i++) await sleep(100); },
    async mouse(sel, click = true) {
      const [x, y] = await center(sel);
      await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      if (click) for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
      await sleep(150);
    },
    async type(text) { await cmd('Input.insertText', { text }); await sleep(100); },
    async key(k) {
      for (const type of ['keyDown', 'keyUp'])
        await cmd('Input.dispatchKeyEvent', { type, key: k, code: k, windowsVirtualKeyCode: CODES[k], ...(k === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}) });
      await sleep(150);
    },
    async close() {   // Chrome and its helpers (its own process group) first: they write the profile until they exit
      await new Promise(r => {
        if (chrome.exitCode !== null) return r();
        chrome.once('exit', r);
        try { process.kill(-chrome.pid, 'SIGTERM'); } catch { chrome.kill(); }
        setTimeout(r, 5000);
      });
      server.close();
      await sleep(300);
      try { rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
      catch (e) { console.log(`(left ${prof}: ${e.code})`); }   // a temp dir left behind never fails a test
    },
  };
  await cmd('Page.navigate', { url });
  await page.ready();
  return page;
}

// checks: ok(cond, what, got) logs and counts; done() exits 1 on a failure
export function checks() {
  const fails = [];
  return {
    ok(cond, what, got) { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}${cond ? '' : ': ' + JSON.stringify(got)}`); if (!cond) fails.push(what); },
    fail(e) { fails.push(String(e)); console.log('FAIL', e); },
    done() { console.log(fails.length ? `${fails.length} failed` : 'all passed'); process.exit(fails.length ? 1 : 0); },
  };
}
