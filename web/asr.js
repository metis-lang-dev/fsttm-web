// asr.js — E5 (DESIGN.md §6) without the virtual mic: Chrome's Web Speech
// recognizer on the E2 corpus (metis-agent go/models/corpus-wav, 54 rows),
// in this browser, through the real mic.
//
//   ?asr            play: the page plays each WAV on the speakers, the mic
//                   hears it (the room is in the loop; stay quiet)
//   ?asr=read       read: the page shows each line, the user says it
//
// One continuous recognition session for the run (Listener). Times are
// performance.now() ms from the row's start: the WAV's `playing` in play,
// the reader's "next" in read. The transcript
// then goes through pass 1 (the harness grammar) for the intent class
// after ASR — what E2 cares about. WER as E2's: lower case, punctuation
// off, word Levenshtein over the reference length, no number folding
// ("90" for "ninety" costs a word, as it did for whisper).
import { twoPass, intentOf } from './backend/llama.js';

export function parseManifest(tsv) {
  return tsv.split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const [wav, text, want, split] = l.split('\t');
    return { wav, text, want, split };
  });
}

export const words = s => (s ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);

export function wer(ref, hyp) {
  const r = words(ref), h = words(hyp);
  if (!r.length) return h.length ? 1 : 0;
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[h.length] / r.length;
}

const pct = (a, p) => { const s = a.filter(x => x != null).sort((x, y) => x - y); return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(p * s.length))]) : null; };

export function summarize(recs) {
  const by = split => {
    const rs = split ? recs.filter(r => r.split === split) : recs;
    return {
      n: rs.length, heard: rs.filter(r => r.final).length,
      werMean: rs.length ? Math.round(1000 * rs.reduce((a, r) => a + r.wer, 0) / rs.length) / 1000 : null,
      exact: rs.filter(r => r.wer === 0).length,
      intentOK: rs.filter(r => r.intent === r.want).length,
      firstInterimP50: pct(rs.map(r => r.firstInterimMs), 0.5),
      finalAfterEndP50: pct(rs.map(r => r.finalAfterEndMs), 0.5), finalAfterEndP90: pct(rs.map(r => r.finalAfterEndMs), 0.9),
    };
  };
  return { all: by(), prompt: by('prompt'), heldout: by('heldout') };
}

// Listener: ONE continuous recognition session for the whole run, kept
// alive across Chrome's silence ends (as dialog.js's attachRecognizer).
// Opening a fresh session per row stalled Chrome after the first row; here
// a row only routes the results that arrive while it is open. speechstart
// comes once per session, so a row's onset is its first interim, and its
// speech end is its last interim (read) or the WAV's end (play).
export class Listener {
  constructor(SR, { processLocally, onListening, onState }) {
    this.SR = SR; this.processLocally = processLocally; this.onListening = onListening; this.onState = onState;
    this.row = null; this.want = false; this.rec = null; this.open = false;
  }
  // start opens the session once; a second call waits on the same opening
  start() {
    if (this.ready) return this.ready;
    this.want = true;
    return this.ready = new Promise(resolve => {
      const boot = () => {
        const rec = this.rec = new this.SR();
        rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = true;
        if (this.processLocally) rec.processLocally = true;
        rec.onaudiostart = () => { this.open = true; this.onState?.('mic open'); this.row?.ev('audiostart'); resolve(); };
        clearTimeout(this.slow);
        this.slow = setTimeout(() => { if (!this.open && this.want) this.onState?.('the mic has not opened in 5 s: is another tab using the mic or SpeechRecognition? (close it) · Chrome\'s mic permission for localhost?'); }, 5000);
        rec.onresult = e => {
          for (let i = e.resultIndex; i < e.results.length; i++) {
            const r = e.results[i];
            this.row?.result(r[0].transcript, r.isFinal);
          }
        };
        rec.onerror = e => { this.onState?.(`recognizer: ${e.error}`); this.row?.ev('error', { error: e.error }); };
        rec.onend = () => {
          this.open = false; this.row?.ev('session_end');
          if (this.want) setTimeout(() => { if (this.want) try { boot(); } catch (e) { this.onState?.(String(e)); } }, 100);
        };
        rec.start();
      };
      boot();
    });
  }
  stop() { this.want = false; this.ready = null; clearTimeout(this.slow); try { this.rec?.stop(); } catch {} }

  // one row: open it, play the WAV (play) or wait for the reader (read),
  // close it on its final or its timeout
  recognize(row, { mode, audioURL, onInterim }) {
    return new Promise(resolve => {
      const out = { t0: performance.now(), events: [], final: '', firstInterimMs: null, lastInterimMs: null, finalMs: null };
      const now = () => Math.round(performance.now() - out.t0);
      let audio = null, timer = null;
      const finish = why => {
        clearTimeout(timer); this.row = null; this.onListening?.(false);
        out.end = why; audio?.pause(); resolve(out);
      };
      const arm = ms => { clearTimeout(timer); timer = setTimeout(() => finish('timeout'), ms); };
      this.row = {
        ev: (kind, f = {}) => out.events.push({ kind, ms: now(), ...f }),
        result: (text, isFinal) => {
          if (isFinal) {
            if (!text.trim()) return;
            out.final = text.trim(); out.finalMs = now(); this.row.ev('final', { text });
            finish('final');
          } else {
            out.firstInterimMs ??= now(); out.lastInterimMs = now(); this.row.ev('interim', { text }); onInterim?.(text);
            arm(4000); // words are coming: the final follows within the endpointing
          }
        },
      };
      this.onListening?.(true);
      if (mode === 'read') { arm(8000); return; }
      audio = new Audio(audioURL);
      audio.onplaying = () => { out.t0 = performance.now(); this.row?.ev('playing'); };
      audio.onended = () => { out.wavEndMs = now(); this.row?.ev('wav_end'); arm(5000); };
      audio.play().catch(e => { out.error = String(e); finish('play-error'); });
      arm(15000);
    });
  }
}

// listener: an open Listener (the page's mic button), else one is opened here
export async function* runAsr({ SR, rows, mode, processLocally, base, assets, wavBase, next, onPrompt, onInterim, onListening, onState, listener = null }) {
  const L = listener ?? new Listener(SR, { processLocally, onListening, onState });
  await L.start();
  try {
  for (const [i, row] of rows.entries()) {
    onPrompt?.(row, i);
    if (mode === 'read') await next();
    const r = await L.recognize(row, { mode, audioURL: `${wavBase}/${row.wav}`, onInterim });
    // where the speech ended: the WAV's end in play, the last interim in read
    const endMs = mode === 'play' ? r.wavEndMs : r.lastInterimMs;
    let intent = null, json = null;
    if (r.final) { const p = await twoPass(base, { ...assets, user: r.final }); json = p.json; intent = intentOf(p.json); }
    yield {
      i: i + 1, wav: row.wav, text: row.text, want: row.want, split: row.split, mode,
      final: r.final, wer: wer(row.text, r.final), intent, json,
      firstInterimMs: r.firstInterimMs, lastInterimMs: r.lastInterimMs, finalMs: r.finalMs, wavEndMs: r.wavEndMs ?? null,
      finalAfterEndMs: r.finalMs != null && endMs != null ? r.finalMs - endMs : null,
      end: r.end, error: r.error ?? null, events: r.events,
    };
    if (mode === 'play') await new Promise(res => setTimeout(res, 600));
  }
  } finally { if (!listener) L.stop(); }
}
