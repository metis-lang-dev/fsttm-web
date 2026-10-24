// switch.js — one on/off switch with its indicator, for a page's header row (switch.css): a
// button with role switch, a light, its label and the track; the light and the track say the
// state (no word: words {on, off, …} adds one). The light: off (dim), busy (amber, blinking:
// opening), on (the accent), error (red); ping() flashes it a moment (the mic: a word heard).
//
//   const sw = toggleSwitch({ label: 'mic', onChange: want => … });  header.append(sw.el);
//   sw.set('on' | 'off' | 'busy' | 'error', title?);  sw.ping();  sw.disable(why);
//
// micSwitch(panel) is the dialog panel's mic as one: it follows the panel (subscribe) and
// toggles it; the light flashes on each word the recognizer hears. narratorLabel(narrator) is
// the narrator (lib/narrator.js), always on: its name, coloured while it reads (green),
// paused (amber) or held for the dialog (cyan); a click is its key's press; the sentence and n
// of N in its title. voiceWidget(panel, {narrator}) is the header's one card for the voice:
// [● mic ⟦switch⟧ narrator].

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

export function toggleSwitch({ label, title = '', onChange = () => {}, words = null } = {}) {
  const light = h('span', { class: 'fw-sw-light', 'aria-hidden': 'true' });
  const word = words ? h('span', { class: 'fw-sw-word' }) : null;
  const el = h('button', { class: 'fw-switch', type: 'button', role: 'switch', 'aria-checked': 'false', title, 'aria-label': label },
    light, h('span', { class: 'fw-sw-label' }, label), h('span', { class: 'fw-sw-track', 'aria-hidden': 'true' }, h('span', { class: 'fw-sw-knob' })), ...(word ? [word] : []));
  let state = 'off', timer = null;
  const sw = {
    el,
    get state() { return state; },
    get on() { return state === 'on'; },
    set(s, why) {
      state = s;
      el.dataset.state = s;
      el.setAttribute('aria-checked', String(s === 'on'));
      if (word) word.textContent = words[s] ?? s;
      if (why != null) el.title = why;
    },
    ping(ms = 220) {
      el.classList.add('fw-sw-ping');
      clearTimeout(timer);
      timer = setTimeout(() => el.classList.remove('fw-sw-ping'), ms);
    },
    disable(why) { el.disabled = true; sw.set('off', why); },
  };
  el.onclick = () => onChange(state !== 'on');
  sw.set('off');
  return sw;
}

// the narrator, always on: its name, coloured by its state (reading, paused, yielding; stopped plain, dim until
// text is selected); the light-less label flashes as it moves to the next sentence; a click is the key's press
export function narratorLabel(narrator, { label = 'narrator', key = 'F8' } = {}) {
  const help = `the narrator: select text, then ${key} (or a click) reads it · again pauses · again resumes; hold or double ${key}: stop`;
  const el = h('button', { class: 'fw-narr', type: 'button', title: help }, label);
  el.onclick = () => narrator.press();
  const prev = narrator.onchange;
  let at = null, timer = null;
  narrator.onchange = s => {
    prev?.(s);
    el.dataset.state = s.state;
    el.dataset.ready = s.n ? '1' : '0';
    el.title = help + (s.n ? ` · ${s.state} · ${Math.min(s.i + 1, s.n)} of ${s.n}: ${s.sentence}` : ' · nothing selected');
    el.setAttribute('aria-label', `narrator, ${s.state}`);
    if (s.state === 'reading' && at !== null && s.i !== at) {
      el.classList.add('fw-sw-ping'); clearTimeout(timer); timer = setTimeout(() => el.classList.remove('fw-sw-ping'), 220);
    }
    at = s.i;
  };
  narrator.onchange(narrator.snapshot());
  return { el };
}

// the voice in a header, one card: [● mic ⟦switch⟧ narrator] (the narrator with a narrator only)
export function voiceWidget(panel, { narrator = null, key = 'F8', ...mic } = {}) {
  const m = micSwitch(panel, mic), n = narrator ? narratorLabel(narrator, { key }) : null;
  const el = h('span', { class: 'fw-voicebar', role: 'group', 'aria-label': 'the voice' }, m.el, ...(n ? [n.el] : []));
  return { el, mic: m, narrator: n };
}

// the panel's mic: on / off / opening, the light flashing on what the recognizer hears
const HEARD = new Set(['onset', 'interim', 'final']);
export function micSwitch(panel, { label = 'mic', title = 'the microphone: the dialog listens while on' } = {}) {
  const sw = toggleSwitch({ label, title, onChange: () => panel.toggleMic() });
  if (!panel.Recognizer) { sw.disable('no SpeechRecognition in this browser'); return sw; }
  panel.subscribe(({ state, event }) => {
    if (state) sw.set(panel.opening ? 'busy' : state.listening ? 'on' : 'off', `${title} · recognizer: ${state.recognizer}`);
    else if (event?.kind === 'rec_error') sw.set(panel.core.listening ? 'on' : 'error', `microphone: ${event.error ?? 'error'}`);
    else if (HEARD.has(event?.kind) && sw.on) sw.ping();
  });
  return sw;
}
