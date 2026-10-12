# fsttm-web

The FSTTM floor machine in Chrome over a plain llama-server (design:
[DESIGN.md](DESIGN.md)). Step 1: the skeleton and intent parity with the
metis-agent harness.

![fsttm-web: a free dialog with three barge-ins](docs/fsttm-web.png)

A live session: the chat (left) shows three replies cut by talking over
her, each with what was heard and the unsaid rest kept out of the context;
the turns table times each one (first token ~40 ms, reply ~0.3-0.6 s,
onset→cut 130-470 ms). On the right, the floor machine as the Python TUI
draws it (current state green, previous blue, the trail of states with
their dwell), the state and perf numbers, and the event log.

```
./run.sh                         # llama-server, gemma4 E2B Q4, page on http://localhost:8393
node test/run.mjs                # the floor machine and attention on their fixtures (83)
node test/dialog.mjs             # the §3 event table (22 rows)
node test/parity.mjs             # the 54-row corpus through the page's backend, vs the harness
open http://localhost:8393/?parity   # the same run in Chrome
```

## The framework (lib/) and the reference page (web/)

```
lib/   fsttm.js fsttm.json attention.js dialog.js tts.js  fixtures/   ES modules, no deps
web/   index.html app.js fsmview.js eventtable.js bench.js parity.js  the reference page
       backend/llama.js   the backend adapter over llama-server
```

Another application imports the library by its package exports:

```js
import { FSTTM } from 'fsttm-web/fsttm';           // the floor machine (table: fsttm-web/fsttm.json)
import { Attention } from 'fsttm-web/attention';   // wake / sleep
import { Dialog, attachRecognizer } from 'fsttm-web/dialog'; // barge-in, echo rejection, the heard-text cut, resume
import { BrowserTTS } from 'fsttm-web/tts';        // speechSynthesis with the heard text
```

In a browser without a bundler, an import map points the names at `lib/`
(see `web/index.html`; `run.sh` serves `lib/` beside the page).

The dialog needs one thing from an LLM side, the **backend adapter**:
`turn(id, text, mode, {signal})` → an async iterable of sentences
(`mode`: `intent` | `talk`), and `cut(id, heard)`: turn `id` was heard up
to `heard` (called on a cut and when a resumed turn finishes). The adapter
owns the dialog history. `web/backend/llama.js` is the llama-server one;
the page wires it as `llm` and `onHeard` of `Dialog`.

`web/backend/ws.js` is the other adapter: metis-agent's wire (metis-agent
`docs/FRAMEWORK.md` §5). Served by metis-agent
(`metis-agent -config config.agent.yaml -ui-dir <fsttm-web>/web`), the page
finds `/ws` and uses it; served by llama-server it falls back to
`backend/llama.js` (`?backend=llama|ws` forces one). Over ws the agent also
sends its narrations (`narration{path,kind,form,line,sentence}`): the page
voices surprises, results, notices, quiescence, task outcomes and
announcements floor permitting (parked while you hold the floor or she
sleeps) and shows the clause events without voicing them
(`?narrate=all|none`); runtime, rack, command, pending and domains rows go
to the event log. `node --experimental-websocket test/parity.mjs
ws://localhost:8395/ws` runs the corpus through the agent.

- `web/backend/llama.js`: the harness's two-pass turn (TemplateGemma4 rendering, pass 1
  greedy under `dog.gbnf`, pass 2 the bare `Spoken response:` continuation)
  over `/completion` with `cache_prompt`.
- `web/parity.js`: corpus, harness reference and comparison; used by the page
  and by `test/parity.mjs`.
- `prompt/`, `grammar/`: copied verbatim from metis-agent `go/grammar/`
  (a8c862a). `run.sh` copies them into `web/assets/` because llama-server
  serves nothing outside `--path`.
- `test/fixtures/harness-e2b.jsonl`: the harness's answers on E2B Q4,
  `llmbench -template gemma4 -prompt <dog-prompt + pass2-examples-gemma4>
  -corpus grammar/dog-corpus.tsv` (metis-agent internal/llm, 54/54).

## The page (step 2)

The dialog runs from page load: type to her, or press **mic** (it wakes her).
**replies: long** (the default) is free conversation, several sentences to
talk over; **short** is the harness's intent turn. Panels follow the Python
FSTTM TUI: chat over turn timings on the left; the floor diagram (the TUI's,
current state green, the one just left blue),
the numbers and the event log on the right. Each panel scrolls on its own.

Styles are Tailwind 3.4.17, built like metis-loop's nina-web (no bundler):
`npm run build` turns `web/src/input.css` into `web/styles.css` (committed).
llama-server sends no cache headers: after an update, reload with Ctrl+Shift+R.
