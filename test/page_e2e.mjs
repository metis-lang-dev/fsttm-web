// page_e2e.mjs — the reference page (web/index.html) as one dialog panel, in headless Chrome on the
// stub backend in the page (?backend=stub, voice off): a typed line and its rows; the strip (barge-in
// live on the dialog, the reply mode the backend gets, attention); the four sections, closed until
// opened and kept open across a reload; a backend's narration; ?selftest's event table; the dock
// example (web/panel.html) with the strip and no sections.
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
  const secs = await ev(`[...document.querySelectorAll('#dialog details.fw-sec')].map(d => d.dataset.sec + (d.open ? '+' : '-')).join()`);
  c.ok(secs === 'floor-,state-,turns-,events-', 'the sections: floor, state, turns, events, closed', secs);

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

  // the sections: opened by their summary, each with its contents
  for (const n of ['floor', 'state', 'turns', 'events']) {   // the sections' column scrolls: a summary below it is scrolled to, as a reader would
    await ev(`document.querySelector('#dialog details[data-sec="${n}"] > summary').scrollIntoView({ block: 'center' })`);
    await page.mouse(`#dialog details[data-sec="${n}"] > summary`);
  }
  await sleep(400);
  c.ok(await ev(`document.querySelector('#dialog .fw-fsm .fsm-node.cur')?.textContent`) === await ev(`fsttmDialog.fsttm.state`), 'floor: the current state marked', await ev(`fsttmDialog.fsttm.state`));
  c.ok(/s · from|for/.test(await ev(`document.querySelector('#dialog .fw-dwell').textContent`)), 'floor: the dwell');
  const stats = await ev(`Object.fromEntries([...document.querySelectorAll('#dialog .fw-stats dt')].map(dt => [dt.textContent, dt.nextElementSibling.textContent]))`);
  c.ok(stats['barge-in'] === 'energy' && stats.reply === 'replies: short' && stats.backend === 'stub (in the page)' && stats.turns === '2', 'state: the controls, the backend, the turns', stats);
  const turns = await ev(`[...document.querySelectorAll('#dialog .fw-turns tbody tr')].map(tr => [...tr.cells].map(td => td.textContent).join('|'))`);
  c.ok(turns.length === 2 && turns[0].startsWith('1|replies: long|hello there') && turns[1].startsWith('2|replies: short|what time is it'), 'turns: one row a turn, by mode', turns);
  const evs = await ev(`document.querySelector('#dialog .fw-events').textContent`);
  c.ok(/ typed \{"text":"hello there"\}/.test(evs) && / policy \{"bargeIn":"energy"\}/.test(evs), 'events: the dialog log (typed, the policy)', evs.slice(0, 300));

  // a backend's narration: shown with its kind and form (voice off: not spoken)
  await ev(`fsttmBackend.narrate('The door opened.')`);
  c.ok(await until(`[...document.querySelectorAll('#dialog .fw-agent')].some(li => li.textContent.includes('The door opened.') && li.querySelector('.fw-meta')?.textContent.startsWith('announce · N'))`), 'a narration row, its kind and form', await rows());

  // the open sections are the page's: kept across a reload
  await page.goto('index.html?backend=stub&voice=0');
  const kept = await ev(`[...document.querySelectorAll('#dialog details.fw-sec')].map(d => d.dataset.sec + (d.open ? '+' : '-')).join()`);
  c.ok(kept === 'floor+,state+,turns+,events+', 'the open sections kept across a reload', kept);

  // ?selftest: the event table in this Chrome
  await page.goto('index.html?backend=stub&voice=0&selftest');
  c.ok(await until(`!!document.body.dataset.selftest`, 8000), '?selftest ran');
  const st = JSON.parse(await ev(`document.body.dataset.selftest`));
  c.ok(st.rows.length > 0 && st.rows.every(r => r.pass), `?selftest: the event table ${st.rows.filter(r => r.pass).length}/${st.rows.length}`, st.rows.filter(r => !r.pass));

  // the dock example: the strip, no sections, no backend said in a note
  await page.goto('panel.html');
  c.ok(await ev(`!!document.querySelector('#dock .fw-controls') && !document.querySelector('#dock .fw-sections')`), 'panel.html: the strip, no sections');
  c.ok(await ev(`document.querySelector('#dock [aria-label="reply mode"]').hidden && document.querySelector('#dock .fw-attn').hidden`), 'panel.html: no modes, no wake word: reply and attention hidden');
} catch (e) { c.fail(e); }
await page.close();
c.done();
