// ws.js — the backend adapter over the library's wire (fsttm_web.protocol;
// the README's "The wire"): the same turn(id, text, mode) → sentences and
// cut(id, heard) as backend/llama.js, over one websocket. The backend owns the
// model and the dialog history (talk); it may also send what it would say
// unsolicited (narration{…}). Every frame that is not a turn's answer — an
// application's own extension of the wire — goes to onFrame; send(frame) is the
// hook for the page's own frames the other way.
//
//   → backend  say_text{id,text,mode} · cut{id,heard} · heard{id,text} · (an application's own)
//   ← page     intent{id,intent,voice,…} · talk{id,text,done} · error{id,error}
//              narration{id,path,kind,form,line,sentence} · (an application's own)

import { splitSentences } from 'fsttm-web/tts';

export class WsBackend {
  // url: ws://host/ws; onFrame(frame): every frame that is not a turn's answer
  constructor(url, { onFrame = () => {}, WebSocketImpl = globalThis.WebSocket } = {}) {
    this.url = url;
    this.onFrame = onFrame;
    this.ws = new WebSocketImpl(url);
    this.waiting = new Map(); // wire id → {push(frame)}
    this.info = {};           // page id → {json, firstMs, mode, frame} (the page's panes)
    // turn ids are the page's (t1, t2, …): a session prefix keeps two pages,
    // or a reload, apart on the one agent
    this.sess = Math.random().toString(36).slice(2, 8);
    this.opened = new Promise((res, rej) => {
      this.ws.onopen = () => res(this);
      this.ws.onerror = () => rej(new Error(`ws ${url}: no backend`));
    });
    this.ws.onmessage = e => {
      let f;
      try { f = JSON.parse(e.data); } catch { return; }
      const w = f.id != null && this.waiting.get(f.id);
      if (w && (f.ev === 'intent' || f.ev === 'talk' || f.ev === 'error')) w.push(f);
      else this.onFrame(f);
    };
    this.ws.onclose = () => { for (const w of this.waiting.values()) w.push({ ev: 'error', error: 'ws closed' }); };
  }

  send(m) { this.ws.send(JSON.stringify(m)); }
  wire(id) { return `${this.sess}-${id}`; }

  // frames answers the turn's frames as an async iterator
  frames(wid, signal) {
    const q = [], wake = [];
    const push = f => { q.push(f); wake.splice(0).forEach(r => r()); };
    this.waiting.set(wid, { push });
    const self = this;
    return (async function* () {
      try {
        for (;;) {
          if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
          if (!q.length) await new Promise(r => { wake.push(r); signal?.addEventListener('abort', r, { once: true }); });
          while (q.length) yield q.shift();
        }
      } finally { self.waiting.delete(wid); }
    })();
  }

  async *turn(id, text, mode, { signal } = {}) {
    await this.opened;
    const wid = this.wire(id), t0 = performance.now();
    const frames = this.frames(wid, signal);
    this.send({ ev: 'say_text', id: wid, text, mode: mode === 'talk' ? 'talk' : 'intent' });
    for await (const f of frames) {
      if (f.ev === 'error') throw new Error(f.error);
      if (f.ev === 'intent') {
        const json = typeof f.intent === 'string' ? f.intent : (f.json_text ?? JSON.stringify(f.intent));
        this.info[id] = { json, firstMs: performance.now() - t0, mode, frame: f };
        if (f.voice) yield* splitSentences(f.voice);
        return;
      }
      if (f.ev === 'talk') {
        this.info[id] ??= { json: '', firstMs: performance.now() - t0, mode };
        if (f.text) yield f.text;
        if (f.done) return;
      }
    }
  }

  cut(id, heard) { this.send({ ev: 'cut', id: this.wire(id), heard }); }
  // heard: the page voiced the agent's narration id, this much of it
  heard(id, text) { this.send({ ev: 'heard', id, text }); }
  close() { this.ws.close(); }

  // intent is one intent turn whole: the JSON as the backend's pass 1 wrote it,
  // the voice, the timings
  async intent(id, text) {
    const sentences = [];
    for await (const s of this.turn(id, text, 'intent')) sentences.push(s);
    const i = this.info[id];
    return { json: i.json, voice: i.frame?.voice ?? sentences.join(' '), firstMs: i.firstMs, frame: i.frame };
  }
}

// connect resolves a WsBackend when a backend answers on url within
// timeoutMs, else null (the page then runs on llama-server).
export async function connect(url, { timeoutMs = 1500, ...opts } = {}) {
  let b;
  try { b = new WsBackend(url, opts); } catch { return null; }
  const t = new Promise(res => setTimeout(() => res(null), timeoutMs));
  try { return await Promise.race([b.opened, t]) ?? (b.close(), null); } catch { return null; }
}
