// asr.js — E5 (DESIGN.md §6) without the virtual mic: Chrome's Web Speech
// recognizer on the E2 corpus (metis-agent go/models/corpus-wav, 54 rows),
// in this browser, through the real mic.
//
//   ?asr            play: the page plays each WAV on the speakers, the mic
//                   hears it (the room is in the loop; stay quiet)
//   ?asr=read       read: the page shows each line, the user says it
//
// One recognition session per row (Chrome sends speechstart once per
// session). Times are performance.now() ms: in play from the WAV's
// `playing`, in read from the recognizer's `audiostart`. The transcript
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

// one row: a fresh session; play the WAV once the mic is open (play mode),
// wait for the final (or the timeout), close the session
function recognizeOne(SR, row, { mode, processLocally, audioURL, onInterim, onListening }) {
  return new Promise(resolve => {
    const rec = new SR();
    rec.lang = 'en-US'; rec.continuous = false; rec.interimResults = true;
    if (processLocally) rec.processLocally = true;
    const out = { t0: null, events: [], final: '', firstInterimMs: null, speechStartMs: null, speechEndMs: null, finalMs: null };
    const now = () => out.t0 == null ? null : Math.round(performance.now() - out.t0);
    const ev = (kind, f = {}) => out.events.push({ kind, ms: now(), ...f });
    let audio = null, done = false, timer = null;
    const finish = why => {
      if (done) return;
      done = true; clearTimeout(timer);
      onListening?.(false);
      out.end = why;
      try { rec.abort(); } catch {}
      audio?.pause();
      resolve(out);
    };
    const arm = ms => { clearTimeout(timer); timer = setTimeout(() => finish('timeout'), ms); };
    rec.onaudiostart = () => {
      ev('audiostart');
      onListening?.(true);
      if (mode === 'read') { out.t0 = performance.now(); arm(8000); return; }
      audio = new Audio(audioURL);
      audio.onplaying = () => { out.t0 = performance.now(); ev('playing'); };
      audio.onended = () => { out.wavEndMs = now(); ev('wav_end'); arm(5000); };
      audio.play().catch(e => { out.error = String(e); finish('play-error'); });
      arm(15000);
    };
    rec.onspeechstart = () => { out.speechStartMs ??= now(); ev('speechstart'); };
    rec.onspeechend = () => { out.speechEndMs ??= now(); ev('speechend'); };
    rec.onresult = e => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i], text = r[0].transcript;
        if (r.isFinal) { out.final += (out.final ? ' ' : '') + text.trim(); out.finalMs = now(); ev('final', { text }); }
        else { out.firstInterimMs ??= now(); ev('interim', { text }); onInterim?.(text); }
      }
      if (out.final) finish('final');
    };
    rec.onerror = e => { ev('error', { error: e.error }); if (e.error !== 'no-speech') out.error = e.error; };
    rec.onend = () => finish(out.final ? 'final' : 'ended');
    // the mic never opened (another recognizer holds it, permission): the row
    // ends instead of waiting forever
    arm(6000);
    try { rec.start(); } catch (e) { out.error = String(e); finish('start-error'); }
  });
}

// runAsr yields one record per row as it lands. Read mode waits for the
// page's `next()` between rows (the reader's pace); play mode leaves a gap.
export async function* runAsr({ SR, rows, mode, processLocally, base, assets, wavBase, next, onPrompt, onInterim, onListening }) {
  for (const [i, row] of rows.entries()) {
    onPrompt?.(row, i);
    if (mode === 'read') await next();
    const r = await recognizeOne(SR, row, { mode, processLocally, audioURL: `${wavBase}/${row.wav}`, onInterim, onListening });
    // where the speech ended: the WAV's end in play (the recognizer's
    // speechend lags it by its own endpointing), speechend in read
    const endMs = mode === 'play' ? r.wavEndMs : r.speechEndMs;
    let intent = null, json = null;
    if (r.final) { const p = await twoPass(base, { ...assets, user: r.final }); json = p.json; intent = intentOf(p.json); }
    yield {
      i: i + 1, wav: row.wav, text: row.text, want: row.want, split: row.split, mode,
      final: r.final, wer: wer(row.text, r.final), intent, json,
      speechStartMs: r.speechStartMs, firstInterimMs: r.firstInterimMs, finalMs: r.finalMs, wavEndMs: r.wavEndMs ?? null,
      finalAfterEndMs: r.finalMs != null && endMs != null ? r.finalMs - endMs : null,
      end: r.end, error: r.error ?? null, events: r.events,
    };
    if (mode === 'play') await new Promise(res => setTimeout(res, 600));
  }
}
