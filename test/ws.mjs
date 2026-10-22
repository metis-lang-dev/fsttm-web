// node test/ws.mjs — the wire's adapter (lib/ws.js) on a fake WebSocket: a turn's answer, a
// close that fails the waiting turn, a turn on a closed socket that fails at once (it does not
// wait), the reconnect and its onReopen hook, no reconnect after close().
import { WsBackend } from '../lib/ws.js';

let pass = 0, fail = 0;
const ok = (cond, what) => { if (cond) pass++; else { fail++; console.log('FAIL', what); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const sockets = [];
class FakeWS {
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); setTimeout(() => this.up(), 1); }
  up() { this.readyState = 1; this.onopen?.(); }
  send(d) { if (this.readyState !== 1) throw new Error('InvalidStateError'); this.sent.push(JSON.parse(d)); }
  close() { this.readyState = 3; this.onclose?.(); }
  drop() { this.readyState = 3; this.onclose?.(); }          // the server's heartbeat closed it
  answer(f) { this.onmessage?.({ data: JSON.stringify(f) }); }
}

async function turn(b, id, text) {
  const out = [];
  for await (const s of b.turn(id, text, 'intent')) out.push(s);
  return out;
}

// 1. a turn answered
{
  const b = new WsBackend('ws://x/ws', { WebSocketImpl: FakeWS });
  await b.opened;
  const t = turn(b, 't1', 'go to the panel');
  await sleep(2);
  const s = sockets.at(-1);
  ok(s.sent[0]?.ev === 'say_text' && s.sent[0].text === 'go to the panel', 'say_text sent');
  s.answer({ ev: 'intent', id: s.sent[0].id, intent: { intent: 'GO' }, voice: 'I move to panel.' });
  ok(JSON.stringify(await t) === JSON.stringify(['I move to panel.']), 'the turn yields the voice');
}

// 2. the socket drops while a turn waits: the turn fails; a turn after it fails at once
{
  const b = new WsBackend('ws://x/ws', { WebSocketImpl: FakeWS });
  await b.opened;
  const t = turn(b, 't1', 'exit').then(() => 'answered', e => e.message);
  await sleep(2);
  sockets.at(-1).drop();
  ok(await t === 'ws closed', 'a waiting turn fails when the socket drops');
  const t0 = Date.now();
  const r = await turn(b, 't2', 'home').then(() => 'answered', e => e.message);
  ok(r === 'ws closed' && Date.now() - t0 < 50, `a turn on a closed socket fails at once: ${r}`);
  let threw = null;
  try { b.send({ ev: 'world' }); } catch (e) { threw = e.message; }
  ok(threw === 'ws closed', 'send on a closed socket throws');
  b.cut('t1', 'I mov');                                       // a cut or heard after the drop: dropped quietly
  b.heard('n1', 'x');
  ok(true, 'cut and heard on a closed socket do not throw');
}

// 3. reconnect: a new socket after the delay, onReopen called, turns work again
{
  let reopened = 0;
  const b = new WsBackend('ws://x/ws', { WebSocketImpl: FakeWS, reconnect: 5, onReopen: () => { reopened++; } });
  await b.opened;
  const first = sockets.at(-1);
  first.drop();
  await sleep(20);
  ok(sockets.at(-1) !== first && b.isOpen && reopened === 1, `reconnected (${reopened})`);
  const t = turn(b, 't3', 'back');
  await sleep(2);
  const s = sockets.at(-1);
  s.answer({ ev: 'intent', id: s.sent.at(-1).id, intent: { intent: 'BACK' }, voice: 'Back.' });
  ok(JSON.stringify(await t) === JSON.stringify(['Back.']), 'a turn on the new socket is answered');
  first.onclose?.();                                          // a late close of the old socket changes nothing
  await sleep(20);
  ok(sockets.at(-1) === s && b.isOpen, 'an old socket closing again does not reconnect');
  b.close();
  await sleep(20);
  ok(sockets.at(-1) === s && !b.isOpen, 'no reconnect after close()');
}

console.log(`${pass}/${pass + fail} ws checks`);
process.exit(fail ? 1 : 0);
