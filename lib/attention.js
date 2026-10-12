// attention.js — the wake/sleep layer above the floor (metis-agent
// go/internal/attention). ASLEEP: only the wake word is acted on. AWAKE:
// utterances are commands. Sleep only when the robot is addressed by name
// ("nina, go to sleep") — a bare, possibly misheard phrase never disables
// voice control. Runs test/fixtures/attention-cases.json like the Go one.

export const DEFAULT_WAKE = ['nina', 'hey nina', 'hi nina', 'hello nina'];
export const DEFAULT_SLEEP = ['go to sleep', 'voice off', 'stop listening', 'that s all', 'goodbye'];

export function norm(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean).join(' ');
}

const quote = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class Attention {
  constructor({ enabled = true, wakeWords, sleepPhrases, startAsleep = true } = {}) {
    this.enabled = enabled;
    this.state = enabled && startAsleep ? 'ASLEEP' : 'AWAKE';
    this.wake = (wakeWords?.length ? wakeWords : DEFAULT_WAKE).map(norm)
      .sort((a, b) => b.length - a.length); // longest first: "hello nina" before "nina"
    this.sleep = (sleepPhrases?.length ? sleepPhrases : DEFAULT_SLEEP).map(norm);
  }

  awake() { return !this.enabled || this.state === 'AWAKE'; }

  // force is the UI switch / mic possession: true when the state changed.
  force(awake) {
    const want = awake ? 'AWAKE' : 'ASLEEP';
    if (!this.enabled || this.state === want) return false;
    this.state = want;
    return true;
  }

  // matchWake → [matched, remainder minus the wake word]
  matchWake(text) {
    const t = norm(text);
    for (const w of this.wake) {
      const m = new RegExp(`\\b${quote(w)}\\b`).exec(t);
      if (m) return [true, (t.slice(0, m.index) + ' ' + t.slice(m.index + w.length)).trim()];
    }
    return [false, ''];
  }

  // onUtterance is the one gate per transcript: {action: wake|command|sleep|ignore, text, wakePrefixed}
  onUtterance(text) {
    if (!this.enabled) return { action: 'command', text, wakePrefixed: false };
    const [matched, rem] = this.matchWake(text);
    if (this.state === 'ASLEEP') {
      if (matched) { this.state = 'AWAKE'; return { action: 'wake', text: rem, wakePrefixed: true }; }
      return { action: 'ignore', text: '', wakePrefixed: false };
    }
    if (matched && this.sleep.some(p => norm(text).includes(p))) {
      this.state = 'ASLEEP';
      return { action: 'sleep', text: '', wakePrefixed: true };
    }
    return { action: 'command', text, wakePrefixed: matched };
  }
}
