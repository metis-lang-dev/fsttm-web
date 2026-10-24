// page_e2e.mjs — the reference page (web/index.html): one dialog panel in the consoles' shell, in
// headless Chrome on the stub backend in the page (?backend=stub, voice off): the chat aligned with
// the band and inside the window; the voice widget in the band (the mic switch, the narrator's); a typed line and its rows; the strip
// (barge-in live on the dialog, the reply mode the backend gets, attention); the DIALOG drawer (the
// floor, barge-in, attention, the sections as cards), drawn only while shown, kept across a reload;
// replies in the chat; a backend's narration;
// ?selftest's event table; a 329 px dock with the sections inline; the dock example (web/panel.html).
//
//   node test/page_e2e.mjs        (node >= 22; exit 1 on a failure)
import { open, checks, sleep } from './cdp.mjs';

const c = checks();
const page = await open('index.html?backend=stub&voice=0');
const ev = page.ev;
const rows = () => ev(`[...document.querySelectorAll('#dialog .fw-log .fw-row')].map(li => li.querySelector('.fw-who').textContent + ': ' + li.querySelector('.fw-text').textContent)`);
const until = async (expr, ms = 4000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
try {
  c.ok(await ev(`document.querySelector('#dialog').classList.contains('fw-panel')`), 'the page is one panel');
  c.ok(await ev(`document.querySelector('#dialogpart .fw-controls [aria-label="barge-in"]').value`) === 'words', 'the drawer: barge-in words');
  c.ok(await ev(`!document.querySelector('#dialogpart .fw-attn').hidden && document.querySelector('#dialogpart .fw-attn').textContent`) === 'awake', 'the drawer: attention awake (a wake word)');
  c.ok(await ev(`document.querySelector('#dialogpart > .fw-bar .fw-floor').textContent`) === 'FREEs', 'the drawer: the floor');
  c.ok(await ev(`document.querySelector('#dialog .fw-controls [aria-label="reply mode"]').value`) === 'talk', 'the chat: replies long');
  c.ok(await ev(`!document.querySelector('#dialog [aria-label="barge-in"], #dialog .fw-attn, #dialog .fw-floor, #dialog details, #dialog .fw-sections')`), 'the chat: no barge-in, attention, floor or sections');
  const dock = () => ev(`(() => { const d = document.getElementById('dock-dialog'); return d.hidden ? 'hidden' : d.classList.contains('open') ? 'open' : 'folded'; })()`);
  const cards = () => ev(`[...document.querySelectorAll('#dialogpart details.fw-sec')].map(d => d.dataset.sec + (d.open ? '+' : '-')).join()`);
  c.ok(await dock() === 'open' && await cards() === 'floor-,state-,events-', 'the DIALOG drawer open, its cards closed', [await dock(), await cards()]);
  c.ok(await ev(`!document.querySelector('#right .fw-turns') && document.querySelectorAll('#strip [data-strip]').length === 1`), 'one tools drawer, no turns card');

  // the chat: its edge is the band's, its input inside the window
  const edge = await ev(`[document.querySelector('#band .brand').getBoundingClientRect().left, document.querySelector('#dialog .fw-bar').getBoundingClientRect().left, document.querySelector('#dialog .fw-input .fw-text').getBoundingClientRect().left]`);
  c.ok(Math.abs(edge[0] - edge[1]) < 1 && Math.abs(edge[0] - edge[2]) < 1, 'the chat aligned with the band', edge);
  c.ok(await ev(`document.querySelector('#dialog .fw-input').getBoundingClientRect().bottom <= innerHeight`), 'the input line inside the window');

  // the mic: a switch in the band (none by the text line); it follows the panel, its light flashes on a word
  const sw = () => ev(`(() => { const b = document.querySelector('#band .fw-switch'); return b && [b.getAttribute('role'), b.dataset.state, b.getAttribute('aria-checked'), !!b.querySelector('.fw-sw-word')].join('|'); })()`);
  c.ok(await sw() === 'switch|off|false|false' && await ev(`!document.querySelector('#dialog .fw-mic')`), 'the mic switch in the band: off, no word (the light and the track say it)', await sw());
  await ev(`(() => { panel.core.listening = true; panel.core.changed(); })()`);
  c.ok(await sw() === 'switch|on|true|false', 'listening: the switch on', await sw());
  await ev(`panel.core.event('interim', { text: 'hel' })`);
  c.ok(await ev(`document.querySelector('#band .fw-switch').classList.contains('fw-sw-ping')`), 'a word heard: the light flashes');
  await ev(`(() => { panel.core.listening = false; panel.core.changed(); })()`);
  c.ok(await sw() === 'switch|off|false|false', 'off again', await sw());
  // F9 is the mic's key: a press toggles it, as a click on the switch would
  await ev(`(() => { window.toggled = 0; panel.toggleMic = () => { window.toggled++; }; })()`);
  await page.mouse('#hint', false);
  await page.key('F9');
  c.ok(await ev(`window.toggled`) === 1 && /\(F9\)/.test(await ev(`document.querySelector('#voice .fw-switch').title`)), 'F9 toggles the mic, its title says so', await ev(`window.toggled`));
  await ev(`delete panel.toggleMic`);

  // the narrator, always on: its name in the voice card after the mic (no switch, no words); a click is its key's press
  const nar = () => ev(`(() => { const b = document.querySelector('#voice .fw-narr'); return b && [b.dataset.state, b.dataset.ready].join('|'); })()`);
  c.ok(await ev(`(() => { const v = document.getElementById('voice'); return v.classList.contains('fw-voicebar') && v.querySelectorAll('.fw-switch').length === 1
    && v.textContent === 'micnarrator' && !document.querySelector('#band .narrator'); })()`), 'one voice card: [● mic ⟦switch⟧ narrator], no on/off words', await ev(`document.getElementById('voice').textContent`));
  c.ok(await nar() === 'stopped|0', 'the narrator: stopped, nothing selected (dim)', await nar());
  await ev(`(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('hint')); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
  c.ok(await until(`document.querySelector('#voice .fw-narr').dataset.ready === '1'`), 'text selected: ready');
  c.ok(/1 of \d+: mic starts the dialog/.test(await ev(`document.querySelector('#voice .fw-narr').title`)), 'its title: n of N and the sentence', await ev(`document.querySelector('#voice .fw-narr').title`));
  await ev(`(() => { window.pressed = 0; fsttmNarrator.press = () => { window.pressed++; }; })()`);
  await page.mouse('#voice .fw-narr');
  c.ok(await ev(`window.pressed`) === 1, 'a click on it: the narrator\'s press');
  await ev(`fsttmNarrator._set('paused')`);
  c.ok(await nar() === 'paused|1' && await ev(`getComputedStyle(document.querySelector('#voice .fw-narr')).color`) !== await ev(`getComputedStyle(document.querySelector('#voice .fw-switch .fw-sw-label')).color`), 'paused: its colour', await nar());
  await ev(`fsttmNarrator._set('reading')`);
  c.ok(await nar() === 'reading|1', 'reading', await nar());
  await ev(`(() => { delete fsttmNarrator.press; fsttmNarrator.stop(); getSelection().removeAllRanges(); })()`);

  // a typed line: the person's row, the reply's (two sentences in talk mode)
  await page.mouse('#dialog .fw-input .fw-text');
  await page.type('hello there');
  await page.key('Enter');
  c.ok(await until(`[...document.querySelectorAll('#dialog .fw-agent .fw-text')].some(t => t.textContent.startsWith('You said: hello there.'))`), 'a typed line: the stub\'s reply', await rows());
  c.ok((await rows()).some(r => r === 'typed: hello there'), 'the person\'s row, typed', await rows());

  // the strip: barge-in live on the dialog; the reply mode the next turn gets
  await ev(`(() => { const s = document.querySelector('#dialogpart [aria-label="barge-in"]'); s.value = 'energy'; s.dispatchEvent(new Event('change')); })()`);
  c.ok(await ev(`fsttmDialog.bargeIn`) === 'energy', 'barge-in energy: live on the dialog');
  await ev(`(() => { const s = document.querySelector('#dialog [aria-label="reply mode"]'); s.value = 'intent'; s.dispatchEvent(new Event('change')); })()`);
  await ev(`say('what time is it')`);
  c.ok(await until(`[...document.querySelectorAll('#dialog .fw-intent .fw-text')].some(t => t.textContent.includes('CHITCHAT'))`), 'replies short: the intent turn, its JSON row', await rows());
  await page.mouse('#dialogpart .fw-attn');
  c.ok(await ev(`fsttmDialog.attention.state`) === 'ASLEEP' && await ev(`document.querySelector('#dialogpart .fw-attn').textContent`) === 'asleep', 'attention: the button puts her to sleep');
  await page.mouse('#dialogpart .fw-attn');

  // the cards: opened by their summary, each drawn once open
  c.ok(await ev(`document.querySelector('#dialogpart .fw-stats').children.length`) === 0, 'state closed: not drawn');
  for (const n of ['floor', 'state', 'events']) {
    await ev(`document.querySelector('#dialogpart details[data-sec="${n}"] > summary').scrollIntoView({ block: 'center' })`);
    await page.mouse(`#dialogpart details[data-sec="${n}"] > summary`);
  }
  await sleep(400);
  c.ok(await cards() === 'floor+,state+,events+', 'the cards open', await cards());
  c.ok(await ev(`document.querySelector('#dialogpart .fw-fsm .fsm-node.cur')?.textContent`) === await ev(`fsttmDialog.fsttm.state`), 'floor: the current state marked', await ev(`fsttmDialog.fsttm.state`));
  c.ok(/s · from|for/.test(await ev(`document.querySelector('#dialogpart .fw-dwell').textContent`)), 'floor: the dwell');
  const stats = await ev(`Object.fromEntries([...document.querySelectorAll('#dialogpart .fw-stats dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]))`);
  c.ok(stats['barge-in'] === 'energy' && stats.reply === 'replies: short' && stats.backend === 'stub (in the page)' && stats.turns === '2', 'state: the controls, the backend, the turns', stats);
  const evs = await ev(`document.querySelector('#dialogpart .fw-events').textContent`);
  c.ok(/ typed \{"text":"hello there"\}/.test(evs) && / policy \{"bargeIn":"energy"\}/.test(evs), 'events: the dialog log (typed, the policy)', evs.slice(0, 300));
  c.ok(await ev(`(() => { const s = document.querySelector('#dialogpart .fw-sections'), d = document.querySelector('#dock-dialog .dbody').getBoundingClientRect(), r = s.getBoundingClientRect(); return r.bottom <= d.bottom + 0.5 && s.scrollHeight > s.clientHeight; })()`), 'the cards scroll inside the drawer');
  // the drawer folded, then hidden: the panel draws nothing, the floor does not tick; the chat takes the width
  await page.mouse('#dock-dialog > header .tt');
  c.ok(await dock() === 'folded' && await ev(`!panel.isOpen('floor') && !panel.tick`), 'the drawer folded: nothing drawn, no tick', await dock());
  await page.mouse('#dock-dialog > header .tt');
  c.ok(await ev(`panel.isOpen('floor') && !!panel.tick`), 'unfolded: drawn again');
  await page.mouse('#strip [data-strip="dialog"]');
  c.ok(await dock() === 'hidden' && await ev(`document.getElementById('right').hidden && !panel.tick`), 'the strip hides it: the chat alone', await dock());
  await page.mouse('#strip [data-strip="dialog"]');

  // a backend's narration: shown with its kind and form (voice off: not spoken)
  await ev(`fsttmBackend.narrate('The door opened.')`);
  c.ok(await until(`[...document.querySelectorAll('#dialog .fw-agent')].some(li => li.textContent.includes('The door opened.') && li.querySelector('.fw-meta')?.textContent.startsWith('announce · N'))`), 'a narration row, its kind and form', await rows());

  // the open sections are the page's: kept across a reload
  await page.goto('index.html?backend=stub&voice=0');
  c.ok(await dock() === 'open' && await cards() === 'floor+,state+,events+' && await ev(`panel.isOpen('events')`), 'the drawer and its cards kept across a reload', [await dock(), await cards()]);

  // ?selftest: the event table in this Chrome
  await page.goto('index.html?backend=stub&voice=0&selftest');
  c.ok(await until(`!!document.body.dataset.selftest`, 8000), '?selftest ran');
  const st = JSON.parse(await ev(`document.body.dataset.selftest`));
  c.ok(st.rows.length > 0 && st.rows.every(r => r.pass), `?selftest: the event table ${st.rows.filter(r => r.pass).length}/${st.rows.length}`, st.rows.filter(r => !r.pass));

  // a dock of fixed height (329 px, the world page's TALK) with all the sections: when the log fills up, it gives
  // way, every summary stays inside the dock
  await ev(`(async () => { const { Panel } = await import('/lib/panel.js'); const { StubBackend } = await import('/backend/stub.js');
    const box = document.createElement('div'); box.id = 'dock329'; box.style.cssText = 'height:329px;width:360px;position:fixed;left:0;top:0;background:#000';
    document.body.append(box);
    window.dock = new Panel(box, { backend: new StubBackend(), table: await (await fetch('lib/fsttm.json')).json(), voice: false,
      sections: ['floor', 'state', 'turns', 'events'], storeKey: 'dock329' });
    for (let i = 0; i < 30; i++) window.dock.note('a row to fill the log ' + i); })()`);
  await sleep(200);
  const fit = await ev(`(() => { const p = document.getElementById('dock329').getBoundingClientRect();
    return [...document.querySelectorAll('#dock329 details.fw-sec > summary')].map(s => { const r = s.getBoundingClientRect(); return r.top >= p.top && r.bottom <= p.bottom + 0.5 && r.height > 0; }); })()`);
  c.ok(fit.length === 4 && fit.every(Boolean), 'a 329 px dock with a full log: every summary inside it', fit);
  c.ok(await ev(`(() => { const l = document.querySelector('#dock329 .fw-log'); return l.scrollHeight > l.clientHeight; })()`), 'the log gives way: it scrolls');
  await ev(`document.getElementById('dock329').remove()`);

  // the dock example: the strip, no sections, no backend said in a note
  await page.goto('panel.html');
  c.ok(await ev(`!!document.querySelector('#dock .fw-controls') && !document.querySelector('#dock .fw-sections')`), 'panel.html: the strip, no sections');
  c.ok(await ev(`document.querySelector('#dock [aria-label="reply mode"]').hidden && document.querySelector('#dock .fw-attn').hidden`), 'panel.html: no modes, no wake word: reply and attention hidden');
} catch (e) { c.fail(e); }
await page.close();
c.done();
