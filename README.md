# fsttm-web

A dialog framework for the browser: the FSTTM floor machine (N09-1071, the
finite-state turn-taking model) over Chrome's SpeechRecognition and
speechSynthesis, with wake/sleep attention, barge-in, textual echo
rejection and the heard-text cut. ES modules with no dependencies (`lib/`),
the same library as a Python package (`fsttm_web`) for a Python web server,
one page↔backend wire, and a reference page (`web/`) over a plain
llama-server.

Used by: metis-agent's console.

![fsttm-web: a free dialog with three barge-ins](docs/fsttm-web.png)

## The library (lib/)

```
lib/   fsttm.js fsttm.json   the floor machine and its table (the machine as data)
       attention.js          wake / sleep in front of the floor
       dialog.js             browser signals → floor actions: barge-in, echo rejection, the heard-text cut, resume
       tts.js                speechSynthesis with the text actually heard
       ws.js                 the backend adapter over the wire (WsBackend, connect)
       panel.js panel.css    the dialog as a widget panel: the one input, the intent chat, the strip, the sections
       fsmview.js            the floor machine drawn (the panel's floor section)
       bench.js              every dialog event, timed, and the barge-in numbers (the panel's state and events)
       narrator.js (+css)    the page's selected text read aloud on one key, beside the dialog (below)
       fixtures/             the floor machine's and attention's cases as data (canonical)
```

```js
import { FSTTM } from 'fsttm-web/fsttm';                  // the floor machine (table: fsttm-web/fsttm.json)
import { Attention } from 'fsttm-web/attention';          // wake / sleep: new Attention({ wakeWords, sleepPhrases, enabled, startAsleep })
import { Dialog, attachRecognizer } from 'fsttm-web/dialog';
import { BrowserTTS, splitSentences } from 'fsttm-web/tts';
import { WsBackend, connect } from 'fsttm-web/ws';         // the wire's adapter (below)
import { Panel, PanelCore } from 'fsttm-web/panel';        // the panel (below); lib/panel.css
import { Bench } from 'fsttm-web/bench';                  // the events and their numbers
import { FsmView } from 'fsttm-web/fsmview';              // the floor diagram
import { Narrator, attachSelection, attachKey, narratorView } from 'fsttm-web/narrator';   // lib/narrator.css
```

In a browser without a bundler, an import map points the names at `lib/`
(see `web/index.html`, or `fsttm_web.IMPORT_MAP`).

## Design

- **The floor is ownership, not speech.** `fsttm.js` interprets
  `fsttm.json`: six floor states, the 14 transitions keyed by the
  (system, user) action pair, the action remap, and the paper's §3.2 costs.
  Any interpreter of the table runs `fixtures/fsttm-cases.json`.
- **Attention** sits in front of the floor. ASLEEP, only a wake word is
  acted on; AWAKE, utterances are commands. Sleep only when the assistant is
  addressed by name ("computer, go to sleep"), so a misheard bare phrase
  never turns voice off. The wake words are the application's (`wakeWords`);
  `DEFAULT_WAKE` is a neutral one.
- **The dialog** (`dialog.js`) is pure logic over injected parts
  (recognizer, tts, llm, log). The same event table runs scripted in node
  (`test/dialog.mjs`) and in Chrome (`?selftest`). Barge-in is a policy
  (`words` / `energy` / `none`). A transcript that is only the system's own
  speech is dropped as echo, and the echo before the user's words is cut off
  them. The recognizer re-spells what it hears ("countertop 3" → "counter
  top three"), so echo is measured on letters, not tokens: numbers spelled
  out, character trigrams found in a sentence (or two) of what was said in
  the last 12 s (`ECHO`, `echoShare`, `pastEcho`; `test/echo.mjs`). Better
  still, the recognizer never hears her: `cancelledMic()` opens the mic with
  the browser's echo canceller and `attachRecognizer(rec, dialog, { track })`
  has the recognizer listen to it (`start(track)`, newer Chrome; the raw mic
  where refused); the textual echo rejection is then off (`textEcho`), as it
  could only drop the user's words. `web/mic.html` measures both on a machine. A short stop
  phrase cuts at once, and is never echo. "Continue"
  resumes a cut reply from the cut word, with no new LLM call.
- **The heard-text invariant.** On a cut, the dialog history keeps only what
  was heard, up to the cut word, and the unsaid rest stays out of the
  context. `tts.js` knows the heard text from `onboundary`. Voices that fire
  no boundary events (Linux speech-dispatcher) get an estimate from the time
  spoken, marked estimated.

## The panel

`panel.js` is the dialog as a widget a page embeds, the way it embeds a dock. It holds the
**one input**, voice or text: the mic, the text line, the floor and the input's mode. It
also holds the **intent chat**: what was heard or typed, the intent the backend made of it,
and the backend's words, tagged spoken or cut. The panel fills an element the page gives
it and takes the page's colours (`lib/panel.css`: currentColor, `--fw-accent`, `--fw-side`).

```js
const panel = new Panel(document.getElementById('dock'), { backend: await connect(url), table,
  sections: ['floor', 'state', 'turns', 'events'],          // the insides a page shows (none by default)
  modes: [{ value: 'talk', label: 'long' }, 'intent'] });    // the backend's reply modes, if it has some
window.say = text => panel.say(text);
```

- **The strip.** The bar holds the dialog's controls: the **barge-in** policy (words,
  energy, none: `setBargeIn(p)`, live on the dialog), **attention** awake / asleep (shown
  where there is a wake word: `setAttention(awake)`), and the **reply mode** (shown when
  the backend has `modes`: `setReply(v)`; `turn(id, text, mode)` gets it). The mic and the
  voice switch sit by the text line. `controls: false` hides the strip.
- **The sections**, each a `<details>`, closed until opened; the open ones are kept per
  page (`storeKey`, the path by default):
  - **floor**: the floor machine (`fsmview.js`), the dwell, the last states, §3.2's costs;
  - **state**: floor, attention, channel, mode, reply, barge-in, recognizer (the
    echo-cancelled track or the raw mic, on-device or cloud), voice; then the numbers the
    bench computes (`bench.js`): barge-ins, onset→cut, false cuts, echo drops, first token,
    reply time, the FREEu dwell, the seconds spoken;
  - **turns**: each turn's mode, words, first token, reply, dwell and how it ended;
  - **events**: the dialog log, capped, with **save (JSONL)** (every event, timed) and **clear**.
- `meta: true` shows each row's small print: the input's source and the floor, a
  narration's kind and form. `narrate(frame)` says which narrations are voiced (default:
  all but form R). `onDevice: true` asks for on-device recognition; `micWakes` (default)
  has the mic button wake her and its off put her to sleep, where there is a wake word.

- **One entry.** The text line, a recognized utterance and `panel.say(text)` all take
  one path: the floor's `final()`, the echo and attention rules, then a turn on the
  backend. So a script, a test and a backend's text socket type into the same line as
  a person. A row records each input's source: typed, heard or said.
- **Two channels.** The backend is the main one. A page with a second consumer of the
  voice gives `side: { label, send(text, {id}) → words }`. `flip()` moves the input to it
  (the `flipKey`, Ctrl+Space by default). `hold()`/`release()` is the quasimode: the side
  channel only while the `holdKey` is held (Space by default, never while the focus is in
  a text field). `onChannel(channel, how)` tells the page.
- **The page's own.** `setMode(text)` shows the page's word for the input's mode.
  `onFrame` gets every frame the panel doesn't know (narration it voices itself), and
  `log` every dialog event (a stop phrase, `keyword_stop`, never reaches a turn).
- `PanelCore` is the logic without the DOM (`test/panel.mjs` drives it on a fake backend);
  `core.bench` keeps the events, `core.timings` the turns.
  `web/panel.html` is the panel in a dock over `examples/serve.py`'s stub backend; the
  reference page (below) is the panel with all its sections.

## The narrator

A floor-independent narration stream: the page's **selected text** read aloud sentence by
sentence on one page-wide key, while the dialog goes on (the user's xsel-to-speech, in the
page). It never takes the floor and never touches the floor machine, attention or the
dialog; it only wraps the dialog's `BrowserTTS` to know when the dialog speaks.

```js
const narrator = new Narrator({ tts, rate: 1.3 });      // tts: the dialog's BrowserTTS — its voice; rate: the narrator's own (null: the dialog's)
attachSelection(narrator, document);                     // selectionchange: a new non-empty selection RESETS the narrator to it (stopped, at its first sentence)
attachKey(narrator, document, { key: 'F8' });            // press: stopped → reading · reading → paused · paused → reading; hold ≥ 600 ms or a double press: stop
narratorView(document.getElementById('narrator'), narrator);   // the indicator: state · n of N · the sentence (lib/narrator.css)
```

- **States:** `stopped`, `reading`, `paused`, `yielding`. A pause cuts the sentence; a resume
  reads it again from its start. Reading past the last sentence stops; the next press reads
  from the top. `narrator.onchange(snapshot)` reports every change.
- **Yielding:** speechSynthesis is one queue per page, so before the dialog's utterance is
  queued the narrator cuts its own sentence and waits (`yielding`); after the dialog's
  `onend` it resumes at its cursor. A barge-in `cancel()` of the dialog's speech empties the
  synth's whole queue: the narrator's current sentence is re-queued, not lost. A press while
  yielding pauses it; the dialog ending then leaves it paused. A press while the dialog
  speaks waits and reads when the dialog is done.
- The page's selection stays the person's: the sentence is highlighted in the indicator, not
  on the page. In `web/`: select text, F8 (`?narrate_key=`, `?narrate_rate=`).

## The backend adapter and the wire

The dialog needs one thing from the LLM side, a **backend adapter**:
`turn(id, text, mode, {signal})` → an async iterable of sentences (`mode`:
`intent` | `talk`), and `cut(id, heard)`: turn `id` was heard up to `heard`.
The adapter owns the dialog history. The reference page has two:

- `web/backend/llama.js`: a plain llama-server over `/completion` with
  `cache_prompt`. The intent mode is a two-pass turn: pass 1 is the intent
  JSON under a grammar, pass 2 one spoken line. The talk mode is a free
  dialog. Rendering is Gemma 4's chat template.
- `lib/ws.js` (`fsttm-web/ws`; `web/backend/ws.js` re-exports it): any backend that
  speaks **the wire** on `/ws`. A turn on a closed socket fails at once ("ws closed"),
  never waits, and `send` throws on a closed socket (a caller that may run during a drop
  checks `isOpen` first). `reconnect: ms` opens a dropped socket again (a page left idle loses its
  socket to the server's heartbeat), and `onReopen(backend)` is where the page sends its
  own hello again.

**The wire** (`fsttm_web.protocol`) is JSON text frames on one websocket,
each an object with `ev`:

| direction | frames |
|---|---|
| page → backend | `say_text{id, text, mode}` · `cut{id, heard}` · `heard{id, text}` (a narration was voiced, this much of it) |
| backend → page | `intent{id, intent, voice}` · `talk{id, text, done}` · `error{id, error}` · `narration{id, path, kind, form, line, sentence}` (something to say when the floor is free; form `R` is shown, never voiced) |

**An application extends the wire** with frames of its own, either way. Any
other `ev` is the application's: the library neither defines nor needs it.
`WsBackend` hands unknown frames to `onFrame`, and `send(frame)` sends the
page's own. `parse()` accepts any frame with an `ev`. The panel keeps them as
events only where the page asks (`frames: true` or a predicate), as kind `frame`.

### The host's backchannel

A program on the host (a test, a script, a person at a terminal) drives the panel and
reads it as the person sees it, on the same socket:

| direction | frame | what |
|---|---|---|
| host → page | `chat{who: "user", text, id?}` | a line as the person's: the panel's one entry (the floor, attention, a turn) |
| host → page | `chat{who: "system", text, id?, voice?}` | her words: shown, and spoken unless `voice` is false (a narration, kind announce) |
| host → page | `ctl{barge_in?, voice?, attention?, reply?, mic?}` | the strip: words / energy / none, on / off, awake / asleep, one of the page's modes (`mode` is the same), mic on / off |
| page → host | `chat{who, text, row, id, via, tags, kind?, host_id?}` | every row the panel shows, again on each new tag: who `user` / `system` / `intent` / `note`, via `typed` / `heard` / `host` / `say` / `backend` / `panel`, tags `spoken`, `cut · heard "…"` …; `host_id` the id the host gave its own line |
| page → host | `event{kind, t, …}` | every dialog event (an application's own frames never) |
| page → host | `state{floor, attention, channel, mode, reply, barge_in, recognizer, voice, listening}` | on every change |

The page sends back only when it opts in: `new Panel(el, { host: true })` (or `{rows,
events, state}`); the reference page with `?host`. The host's side is `fsttm_web.chat`:

```python
from fsttm_web.chat import Chat, Relay
chat = Chat(sock.send_json)          # in the backend's handler of the page's socket ...
if chat.feed(frame): ...             # ... which hands it every frame (True: the host's)
chat = await Chat.connect("ws://127.0.0.1:8397/host")    # or from another process, through a Relay
await chat.user("hello there")
row = await chat.expect(lambda f: "spoken" in f["tags"], ev="chat", who="system")
await chat.ctl(barge_in="energy")
await chat.expect(lambda f: f["barge_in"] == "energy", ev="state")
await chat.system("The door is open.", voice=False)
m = chat.mark()                      # waits from a mark use nothing up: any order
await chat.user("go on", id="q7")
await chat.expect(ev="chat", who="user", host_id="q7", since=m)
```

`Relay` joins one server's page sockets and host sockets; `fsttm_web.aiohttp.host_route(app,
relay)` serves the hosts at `/host` (`examples/serve.py` has both). At a terminal:
`python -m fsttm_web.chat ws://127.0.0.1:8397/host`: lines are the person's, `/system …`
speaks as her, `/ctl barge_in=energy voice=0` sets the strip, `/events` shows the events.

## Packages: JS and Python, one source

lib/ is packaged twice, from the same files; nothing is copied by hand.

**JS** (`package.json`, exports as above, `files: lib/`):

```
npm install git+https://github.com/metis-lang-dev/fsttm-web.git#<commit>
npm pack                     # fsttm-web-<version>.tgz
```

A page served by any server points its import map at the installed
`node_modules/fsttm-web/lib/`, or the server mounts it at `/lib/`.

**Python** (`pyproject.toml`, package `fsttm_web`): the same lib/, the
reference page (web/) and its assets (prompt/, grammar/), with a mount
helper for aiohttp and the wire in Python terms:

```
pip install -e 'fsttm-web[aiohttp]'      # editable: reads lib/ and web/ from this checkout
python examples/serve.py                 # the reference page + a stub backend: http://localhost:8397/?backend=ws
```

```python
import fsttm_web                     # LIB, WEB, asset(name), routes(), IMPORT_MAP
from fsttm_web.aiohttp import mount  # mount(app): /lib/, /assets/<name>, the page at / (page=False: lib only)
import fsttm_web.protocol as wire    # the frames, parse(), Echo (a stub backend)
```

A wheel (`pip wheel .`) carries its own copies of lib/, web/ and the
assets, made at build time.

## The reference page (web/)

```
MODEL=<gemma4 gguf> ./run.sh     # llama-server serving the page: http://localhost:8393
```

The dialog runs from page load: type, or press **mic** (it wakes the
assistant). **replies: long** (the default) is free conversation, several
sentences to talk over; **short** is the intent turn of the example, a desk
assistant with a lamp (`prompt/example-prompt.txt`, `grammar/example.gbnf`:
LIGHT_ON, LIGHT_OFF, TIME, CHITCHAT, UNKNOWN). An application gives its own
prompt and grammar to `loadAssets`.

The page is one panel (`lib/panel.js`, above) with all four sections, the chat on
the left and the sections on the right; the strip sets barge-in, attention and the
replies. `web/app.js` only chooses the backend, sets the narrator (F8) and runs
`?selftest`.

URL options:
- `?asleep`: start asleep, so the wake word comes first.
- `?wake=a,b`: the wake words.
- `?reply=short`: start in the intent mode.
- `?barge_in=words|energy|none`: the barge-in policy at the start.
- `?voice=0`: the voice off (rows only).
- `?raw_mic`: the recognizer on the raw mic (her voice dropped by text), not the echo-cancelled track.
- `?backend=llama|ws|stub`: force a backend; `stub` is in the page (`web/backend/stub.js`), no server.
- `?narrate=all|none`, `?narrate_rate=1.2`, `?narrate_key=F9`: the narrations voiced, the narrator's rate and key.
- `?selftest`: the event table in this Chrome.

The events section's **save (JSONL)** exports every dialog event, timed.

Styles are Tailwind 3.4.17 with no bundler: `npm run build` turns
`web/src/input.css` into `web/styles.css`, which is committed.
llama-server sends no cache headers, so after an update reload with
Ctrl+Shift+R.

## Tests

```
npm test                         # test/run.mjs (the floor machine and attention on their fixtures) + test/dialog.mjs (the event table) + test/echo.mjs (the echo measure on re-spelled echoes, and a narration backlog) + test/panel.mjs (the panel's logic, the backchannel) + test/bench.mjs (the numbers kept as events come) + test/ws.mjs (the wire's adapter) + test/narrator.mjs (the narrator on a stub synth beside the dialog's TTS)
pytest test/test_python.py       # the package: one source, the stub backend, the mount, Chat and the Relay
node test/page_e2e.mjs           # the browser suite (node >= 22, Chrome): the reference page as one panel on ?backend=stub
pytest test/test_host_e2e.py     # the host's backchannel: examples/serve.py + the page in headless Chrome, driven by fsttm_web.chat
```

## License

Apache License 2.0 (see `LICENSE`, `NOTICE`).
