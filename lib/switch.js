// switch.js — one on/off switch with its indicator, for a page's header row (switch.css): a
// button with role switch, a light, its label, and the word of its state. The light: off (dim),
// busy (amber, blinking: opening), on (the accent), error (red); ping() flashes it a moment
// (the mic: a word heard).
//
//   const sw = toggleSwitch({ label: 'mic', onChange: want => … });  header.append(sw.el);
//   sw.set('on' | 'off' | 'busy' | 'error', title?);  sw.ping();  sw.disable(why);
//
// micSwitch(panel) is the dialog panel's mic as one: it follows the panel (subscribe) and
// toggles it; the light flashes on each word the recognizer hears.

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids);
  return e;
};

export function toggleSwitch({ label, title = '', onChange = () => {}, words = { on: 'on', off: 'off', busy: '…', error: 'error' } } = {}) {
  const light = h('span', { class: 'fw-sw-light', 'aria-hidden': 'true' });
  const word = h('span', { class: 'fw-sw-word' });
  const el = h('button', { class: 'fw-switch', type: 'button', role: 'switch', 'aria-checked': 'false', title },
    light, h('span', { class: 'fw-sw-label' }, label), h('span', { class: 'fw-sw-track', 'aria-hidden': 'true' }, h('span', { class: 'fw-sw-knob' })), word);
  let state = 'off', timer = null;
  const sw = {
    el,
    get state() { return state; },
    get on() { return state === 'on'; },
    set(s, why) {
      state = s;
      el.dataset.state = s;
      el.setAttribute('aria-checked', String(s === 'on'));
      word.textContent = words[s] ?? s;
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
