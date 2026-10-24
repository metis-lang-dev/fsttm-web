// backend/stub.js — a stub backend in the page (?backend=stub): the dialog with no server and
// no model, as fsttm_web.protocol.Echo answers on the wire. An intent turn answers CHITCHAT and
// speaks back what it heard; a talk turn streams two sentences. What the dialog sends back is
// kept (cuts, heards), and narrate() plays a backend's narration frame, for tests and demos.
const wait = (ms, signal) => new Promise((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); });
});

export class StubBackend {
  constructor({ delayMs = 40 } = {}) {
    Object.assign(this, { delayMs });
    this.info = {};      // id → {json, firstMs, mode}, as the other backends keep it
    this.cuts = [];      // [id, heard]
    this.heards = [];    // [narration id, text]
    this.onFrame = null; // the panel's slot
    this.n = 0;
  }

  async *turn(id, text, mode, { signal } = {}) {
    const t0 = performance.now();
    await wait(this.delayMs, signal);
    if (mode === 'talk') {
      this.info[id] = { json: '', firstMs: performance.now() - t0, mode };
      for (const s of [`You said: ${text}.`, 'That is all I can say, I am a stub.']) { yield s; await wait(this.delayMs, signal); }
      return;
    }
    this.info[id] = { json: JSON.stringify({ intent: 'CHITCHAT' }), firstMs: performance.now() - t0, mode };
    yield `You said: ${text}.`;
  }

  cut(id, heard) { this.cuts.push([id, heard]); }
  heard(id, text) { this.heards.push([id, text]); }

  // narrate: a narration frame, as a backend sends one
  narrate(sentence, { kind = 'announce', form = 'N', path = '' } = {}) {
    this.onFrame?.({ ev: 'narration', id: `s${++this.n}`, path, kind, form, line: sentence, sentence });
  }
}
