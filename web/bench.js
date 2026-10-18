// bench.js — every dialog event with performance.now(), exportable as
// JSONL (?bench), and the barge-in metrics computed from them: onset→cut
// latency, false cuts, echo drops, user words lost at the cut, FREEu
// dwell, LLM first-token and first-sentence times.

export class Bench {
  constructor({ now = () => performance.now(), sink = null } = {}) {
    this.now = now;
    this.t0 = now();
    this.events = [];
    this.sink = sink; // (event) => void, e.g. the page's log pane
  }

  log = (kind, fields = {}) => {
    const e = { t: Math.round((this.now() - this.t0) * 10) / 10, kind, ...fields };
    this.events.push(e);
    this.sink?.(e);
  };

  jsonl() { return this.events.map(e => JSON.stringify(e)).join('\n') + '\n'; }

  metrics() {
    const ev = this.events, cuts = ev.filter(e => e.kind === 'cut');
    const words = s => (s ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? [];
    // a cut is false when no final with words follows it within 4 s
    const falseCuts = cuts.filter(c => !ev.some(e => e.kind === 'final' && e.t > c.t && e.t - c.t < 4000 && words(e.text).length));
    const lost = cuts.map(c => {
      const f = ev.find(e => e.kind === 'final' && e.t > c.t);
      if (!f || !c.interim) return null;
      const have = new Set(words(f.text));
      return words(c.interim).filter(w => !have.has(w)).length;
    }).filter(x => x !== null);
    const ttsMs = ev.filter(e => e.kind === 'speak').reduce((acc, s) => {
      const end = ev.find(e => (e.kind === 'tts_end' || e.kind === 'cut') && e.t > s.t);
      return acc + ((end?.t ?? s.t) - s.t);
    }, 0);
    const llm = ev.filter(e => e.kind === 'llm');
    const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
    const onsetToCut = cuts.map(c => c.onsetToCutMs).filter(x => x != null);
    const dwell = ev.filter(e => e.kind === 'speak' && e.freeuDwell != null).map(e => e.freeuDwell);
    return {
      cuts: cuts.length, byPolicy: cuts.reduce((m, c) => (m[c.why] = (m[c.why] ?? 0) + 1, m), {}),
      onsetToCutP50: pct(onsetToCut, 0.5), onsetToCutMax: onsetToCut.length ? Math.max(...onsetToCut) : null,
      falseCuts: falseCuts.length, falseCutsPerTtsMin: ttsMs ? falseCuts.length / (ttsMs / 60000) : null,
      echoDrops: ev.filter(e => e.kind === 'echo').length,
      userWordsLostAtCut: lost.reduce((a, b) => a + b, 0),
      freeuDwellP50: pct(dwell, 0.5),
      llmFirstTokenP50: pct(llm.map(e => e.firstMs).filter(x => x != null), 0.5),
      llmFirstSentenceP50: pct(llm.map(e => e.ms), 0.5),
      ttsSeconds: Math.round(ttsMs / 100) / 10,
    };
  }
}
