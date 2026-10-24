// page_e2e.mjs — the reference page (web/index.html): one dialog panel in the consoles' shell, in
// headless Chrome on the stub backend in the page (?backend=stub, voice off): the chat aligned with
// the band and inside the window; the mic switch in the band; a typed line and its rows; the strip
// (barge-in live on the dialog, the reply mode the backend gets, attention); the sections in the
// docks (floor, state, events), drawn while open, kept across a reload; a backend's narration;
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
  c.ok(await ev(`document.querySelector('#dialog .fw-controls [aria-label="barge-in"]').value`) === 'words', 'the strip: barge-in words');
  c.ok(await ev(`document.querySelector('#dialog .fw-controls [aria-label="reply mode"]').value`) === 'talk', 'the strip: replies long');
  c.ok(await ev(`!document.querySelector('#dialog .fw-attn').hidden && document.querySelector('#dialog .fw-attn').textContent`) === 'awake', 'the strip: attention awake (a wake word)');
  const docks = () => ev(`['floor', 'state', 'events'].map(n => { const d = document.getElementById('dock-' + n); return n + (d.hidden ? '_' : d.classList.contains('open') ? '+' : '-'); }).join()`);
  c.ok(await docks() === 'floor+,state-,events_', 'the docks: floor open, state folded, events hidden', await docks());
  c.ok(await ev(`!document.querySelector('#dialog details, #dialog .fw-sections') && ['floor', 'state', 'events'].every(n => document.querySelector('#sec-' + n + ' > .fw-part-' + n))`), 'the sections are in the docks, none in the chat');
  c.ok(await ev(`!document.querySelector('#dialog .fw-turns, #right .fw-turns')`), 'no turns section');

  // the chat: its edge is the band's, its input inside the window
  const edge = await ev(`[document.querySelector('#band .brand').getBoundingClientRect().left, document.querySelector('#dialog .fw-bar').getBoundingClientRect().left, document.querySelector('#dialog .fw-input .fw-text').getBoundingClientRect().left]`);
  c.ok(Math.abs(edge[0] - edge[1]) < 1 && Math.abs(edge[0] - edge[2]) < 1, 'the chat aligned with the band', edge);
  c.ok(await ev(`document.querySelector('#dialog .fw-input').getBoundingClientRect().bottom <= innerHeight`), 'the input line inside the window');

  // the mic: a switch in the band (none by the text line); it follows the panel, its light flashes on a word
  const sw = () => ev(`(() => { const b = document.querySelector('#band .fw-switch'); return b && [b.getAttribute('role'), b.dataset.state, b.getAttribute('aria-checked'), b.querySelector('.fw-sw-word').textContent].join('|'); })()`);
  c.ok(await sw() === 'switch|off|false|off' && await ev(`!document.querySelector('#dialog .fw-mic')`), 'the mic switch in the band: off', await sw());
  await ev(`(() => { panel.core.listening = true; panel.core.changed(); })()`);
  c.ok(await sw() === 'switch|on|true|on', 'listening: the switch on', await sw());
  await ev(`panel.core.event('interim', { text: 'hel' })`);
  c.ok(await ev(`document.querySelector('#band .fw-switch').classList.contains('fw-sw-ping')`), 'a word heard: the light flashes');
  await ev(`(() => { panel.core.listening = false; panel.core.changed(); })()`);
  c.ok(await sw() === 'switch|off|false|off', 'off again', await sw());

  // a typed line: the person's row, the reply's (two sentences in talk mode)
  await page.mouse('#dialog .fw-input .fw-text');
  await page.type('hello there');
  await page.key('Enter');
  c.ok(await until(`[...document.querySelectorAll('#dialog .fw-agent .fw-text')].some(t => t.textContent.startsWith('You said: hello there.'))`), 'a typed line: the stub\'s reply', await rows());
  c.ok((await rows()).some(r => r === 'typed: hello there'), 'the person\'s row, typed', await rows());

  // the strip: barge-in live on the dialog; the reply mode the next turn gets
  await ev(`(() => { const s = document.querySelector('#dialog [aria-label="barge-in"]'); s.value = 'energy'; s.dispatchEvent(new Event('change')); })()`);
  c.ok(await ev(`fsttmDialog.bargeIn`) === 'energy', 'barge-in energy: live on the dialog');
  await ev(`(() => { const s = document.querySelector('#dialog [aria-label="reply mode"]'); s.value = 'intent'; s.dispatchEvent(new Event('change')); })()`);
  await ev(`say('what time is it')`);
  c.ok(await until(`[...document.querySelectorAll('#dialog .fw-intent .fw-text')].some(t => t.textContent.includes('CHITCHAT'))`), 'replies short: the intent turn, its JSON row', await rows());
  await page.mouse('#dialog .fw-attn');
  c.ok(await ev(`fsttmDialog.attention.state`) === 'ASLEEP' && await ev(`document.querySelector('#dialog .fw-attn').textContent`) === 'asleep', 'attention: the button puts her to sleep');
  await page.mouse('#dialog .fw-attn');

  // the docks: the strip opens state and events; each drawn once open
  c.ok(await ev(`document.querySelector('#sec-state .fw-stats').children.length`) === 0, 'state folded: not drawn');
  await page.mouse('#strip [data-strip="state"]');
  await page.mouse('#strip [data-strip="events"]');
  await sleep(400);
  c.ok(await docks() === 'floor+,state+,events+', 'the strip: state and events open', await docks());
  c.ok(await ev(`document.querySelector('#right .fw-fsm .fsm-node.cur')?.textContent`) === await ev(`fsttmDialog.fsttm.state`), 'floor: the current state marked', await ev(`fsttmDialog.fsttm.state`));
  c.ok(/s · from|for/.test(await ev(`document.querySelector('#right .fw-dwell').textContent`)), 'floor: the dwell');
  const stats = await ev(`Object.fromEntries([...document.querySelectorAll('#right .fw-stats dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]))`);
  c.ok(stats['barge-in'] === 'energy' && stats.reply === 'replies: short' && stats.backend === 'stub (in the page)' && stats.turns === '2', 'state: the controls, the backend, the turns', stats);
  const evs = await ev(`document.querySelector('#right .fw-events').textContent`);
  c.ok(/ typed \{"text":"hello there"\}/.test(evs) && / policy \{"bargeIn":"energy"\}/.test(evs), 'events: the dialog log (typed, the policy)', evs.slice(0, 300));
  c.ok(await ev(`(() => { const e = document.querySelector('#right .fw-events'), d = document.getElementById('dock-events').getBoundingClientRect(), r = e.getBoundingClientRect(); return r.bottom <= d.bottom + 0.5 && r.height > 40; })()`), 'events: the log fills its dock, inside it');
  // a dock's header folds it: the panel stops drawing it
  await page.mouse('#dock-floor > header .tt');
  c.ok(await docks() === 'floor-,state+,events+' && await ev(`!panel.isOpen('floor') && !panel.tick`), 'floor folded: not drawn, no tick', await docks());
  await page.mouse('#dock-floor > header .tt');

  // a backend's narration: shown with its kind and form (voice off: not spoken)
  await ev(`fsttmBackend.narrate('The door opened.')`);
  c.ok(await until(`[...document.querySelectorAll('#dialog .fw-agent')].some(li => li.textContent.includes('The door opened.') && li.querySelector('.fw-meta')?.textContent.startsWith('announce · N'))`), 'a narration row, its kind and form', await rows());

  // the open sections are the page's: kept across a reload
  await page.goto('index.html?backend=stub&voice=0');
  c.ok(await docks() === 'floor+,state+,events+' && await ev(`panel.isOpen('events') && panel.isOpen('state')`), 'the docks kept across a reload', await docks());

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
      sections: ['floor', 'state', 'turns', 'events'], storeKey: 'dock329', flipKey: null, holdKey: null });
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
