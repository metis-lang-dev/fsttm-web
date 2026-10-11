# fsttm-web — the floor machine in the browser

Status: design, 2026-10-11 (architect). Decisions by the user are marked
**(user)**. Implementer: nina; opus runs the ASR bench (E5). Origin of the
dialog model: the user's FSTTM (N09-1071 finite-state turn-taking), as ported
in metis-agent `go/internal/fsm` + `go/internal/pipeline`.

## 1. What it is **(user)**

A separate experiment: a web front end that owns the dialog — the FSTTM
floor, attention, and above all **barge-in**, which is what the floor machine
exists for — and a *simple* LLM backend. Chrome only. The thesis: until LLMs
handle natural turn-taking natively, the floor machine is the alternative to
instruct-style request/response, and it can live entirely on the client
(Chrome has had speech synthesis since 33, and streaming recognition), which
decouples the dialog from the LLM harness for deployment.

Not in scope: speaker id (owner gate), the metis kernel port, robot commands
and task feedback (that stays the harness's job), RHVoice, any server-side
audio. If a thing can be a browser API, it is.

## 2. Shape

```
Chrome tab                                   llama-server (pinned llama.cpp)
┌──────────────────────────────────┐          ┌──────────────────────────┐
│ SpeechRecognition (interim+final)│  HTTP    │ gemma4 E2B Q4, GBNF,     │
│ speechSynthesis (onboundary/onend)│ ◄──────► │ cache_prompt (KV prefix) │
│ fsttm.js  attention.js dialog.js │  SSE     │ --path web/ (serves it)  │
│ bench.js (?bench → JSONL)        │          └──────────────────────────┘
└──────────────────────────────────┘
```

- **Backend = llama-server, no code.** The pinned checkout
  (`~/archive/vox/llama.cpp`, 8ad8aef44) already builds `llama-server`. It
  gives `/completion` with `grammar` (the same `dog.gbnf`, token-exact),
  `cache_prompt: true` (the KV-prefix reuse the harness does by hand),
  streaming SSE, and `--path` to serve the page — one process, one run
  script: `run.sh` = `llama-server -m <E2B Q4> -ngl 99 -c 4096 --path web
  --port 8393`. Ollama is NOT the first choice: no GBNF (JSON schema only),
  and the whole experiment stands on the harness's prompt + grammar being
  reused byte for byte **(user: reuse the prompt)**.
- **Fallback backend (user's hacks):** if gemma4 through plain HTTP is not
  enough for natural dialog, the harness's Go adapter (`internal/llm`:
  TwoPass, KV rollback between passes, the phi3 floor hacks) is exposed in
  service mode over the existing ws — same page, `backend: harness`. That
  is a step-4 decision, not a step-1 build.
- **Prompt:** `metis-agent/go/grammar/dog-prompt.txt` +
  `pass2-examples-gemma4.txt` copied in (`prompt/`), with the gemma4
  template rendered by the page (system turn = the stable prefix, thinking
  off). Two modes:
  - `intent` — pass 1 JSON under `dog.gbnf`, pass 2 the bare voice cue; the
    parity mode against the harness (§6).
  - `dialog` — the same persona, no grammar, streaming; the natural-dialog
    mode this experiment is for. Extra instruction block (§5).

## 3. The floor machine, ported, not reinvented

`fsttm.json` holds the six states, the 14 transitions and the §3.2 cost
constants exactly as `fsm.go` has them; `fsttm.js` is the 150-line
interpreter (trigger / SystemAction / UserAction / SystemActionsCost),
`attention.js` the wake/sleep layer with the same wake words and sleep
phrases as `config.ws.gemma4.yaml`. The Go tests become JSON fixtures that
both implementations run, so the two FSTTMs cannot drift: the Go harness
keeps the embedded (local-mic) deployment, the browser keeps this one.

Event mapping (the whole port is this table):

| browser signal | FSTTM action | note |
|---|---|---|
| `onspeechstart` (recognition) | user **G** → USER / BOTHs | energy onset, tentative |
| first non-empty interim that is not echo (§4) | confirms the grab | the "Partial" seam of HARNESS.md §5.1 |
| final result | user **R** → FREEu, utterance to the LLM | |
| first sentence of the reply ready | system **G** → SYSTEM, `speechSynthesis.speak` | FREEu dwell logged (cost model stays observational, as in the harness) |
| `onend` of the last chunk | system **R** → FREEs | the floor is honest: release on audio end, never on text end |
| user onset while SYSTEM | user G → BOTHs; policy §4 decides K or R | **barge-in** |
| announcement while USER | system G → BOTHu only for STOP-class; else W (park) | never talk over the user |
| "stop" / "halt" / "quiet" in an interim | system **R** at once, abort stream | the F12 keyword path, on partials |
| wake word while ASLEEP | AWAKE, then as above | ASLEEP drops everything else |

## 4. Barge-in — the thing to preserve **(user)**

Three policies, config `barge_in`:
- `words` (default): on user onset during system speech the FSM enters
  BOTHs with system **K**; on the first non-echo interim the system **R**s:
  `speechSynthesis.cancel()`, `AbortController.abort()` on the SSE stream,
  state → USER. Keys on words, not energy, so coughs and the TV do not cut
  the robot off.
- `energy`: R at `onspeechstart` (the harness's old behaviour; fastest, noisiest).
- `none`: K until the user's final; interim text is buffered.

Echo rejection without AEC on the recognizer's capture: the page knows the
text it is speaking. An interim whose token overlap with the current TTS
sentence is ≥ 0.6 is echo — logged `[echo] dropped`, never a grab. (The
harness's echo tail is a timing heuristic; this one is textual and cheaper.)

What the model is told after a cut (the heard-text invariant): the context
sent on the next turn records the system turn **as spoken, not as
generated** — `onboundary` gives the char index of the word being uttered
when `cancel()` fired, so the turn is truncated there and marked
`[interrupted]`. The LLM then knows what the user actually heard. This is
the one place the browser beats the harness.

Metrics (bench.js logs every one): onset→cut latency (ms), false cuts per
minute of TTS, echo drops, user words lost at the cut (the final's text vs
the interim at the cut), FREEu dwell, LLM first-token and first-sentence ms.

## 5. Natural dialog mode

Instruction block appended to the persona for `dialog` mode (draft, nina
tunes on the 10 scripted dialogs, step 3):
- answer in one or two short sentences; one question at a time;
- you can be interrupted; a turn marked `[interrupted]` is what you managed
  to say — continue from there only if asked;
- when the user speaks over you, stop; do not restate what was cut;
- never narrate the floor ("I'll stop talking now").

Streaming → `speechSynthesis` per sentence (split on `.?!` + 40 chars
minimum), so the first word plays ~1 sentence after the first token.
`utterance.onend` chains the next chunk; the floor stays SYSTEM across chunks.

If gemma4 cannot hold this with the prompt alone, the fallback is the
harness adapter (§2) with the user's phi3 floor hacks — that decision is
step 4's, with numbers.

## 6. What the experiment measures (and the one bench page for E5)

- **Parity:** the step-4 chat corpus (metis-agent regression) typed into the
  page in `intent` mode → the same intents as the harness (54/54 on E2B is
  the bar). Any diff is a rendering bug, since prompt, grammar and model are
  the same.
- **Barge-in:** §4 metrics on 10 scripted interruptions (the user).
- **E5 (opus, with nina's page):** `?bench` mode logs `onspeechstart`,
  first interim, final, each with `performance.now()` since playback start,
  plus the transcript; opus feeds the corpus WAVs through a virtual mic
  (PipeWire/Pulse null sink + loopback as Chrome's input) and computes WER
  against `models/corpus-wav/manifest.tsv`. The row says whether recognition
  ran **on-device or in the cloud**: the page calls
  `SpeechRecognition.available({langs:["en-US"], processLocally:true})`
  and `install()` and sets `processLocally` when available; the result is
  logged. Chrome here is 154, so the API exists; what it does on Linux is
  the finding. Same table as E2 (whisper, Nemotron) + the heard path.
- **Dialog:** 10 scripted multi-turn dialogs with interruptions, judged by
  the user; the transcript with `[interrupted]` marks is the artefact.

## 7. Known limits (state them in the report, do not fix them here)

- Desktop Chrome recognizes in the cloud unless on-device is installed and
  available for the language: no offline; partial latency is RTT-bound.
- Linux `speechSynthesis` voices come from speech-dispatcher (espeak-class).
  Android/ChromeOS voices are fine. No RHVoice in this experiment.
- Background tabs throttle timers to 1 Hz: the dialog tab stays foreground,
  or the clock moves to a Worker (step 2 decides by measuring).
- One tab = one dialog; no hub, no master role.
- No speaker verification: anyone may barge in.

## 8. Layout and steps (one subject, nina implements, architect reviews)

```
fsttm-web/
  DESIGN.md  run.sh  README.md
  web/index.html  web/fsttm.json  web/fsttm.js  web/attention.js
  web/dialog.js  web/llm.js  web/tts.js  web/bench.js  web/app.css
  prompt/dog-prompt.txt  prompt/pass2-examples-gemma4.txt  prompt/dialog-extra.txt
  grammar/dog.gbnf
  test/fixtures/*.json  test/run.mjs   (node, no framework)
```

1. **Skeleton + parity.** `run.sh` (llama-server, gemma4 E2B Q4, `--path
   web`), the page with a chat box doing pass 1 (grammar) + pass 2 over
   `/completion` with `cache_prompt`; the 54-row corpus typed → intents
   compared with the harness's. Report: parity table, first-token ms,
   `cache_prompt` hit evidence.
2. **The floor.** `fsttm.json` + `fsttm.js` + `attention.js` with the Go
   fixtures passing in node; `dialog.js` on SpeechRecognition +
   `speechSynthesis`; barge-in `words` with echo rejection; `bench.js`.
   Report: the §3 table verified event by event in Chrome, barge-in metrics
   on 10 cuts, the timer-throttling measurement.
3. **Natural dialog.** `dialog` mode: streaming, sentence chunking, the
   heard-text context, the instruction block; the user's session on 10
   scripted dialogs. Report: transcripts, where gemma4 breaks turn-taking.
4. **E5 + decision.** opus's ASR row through the `?bench` page; the
   decision gemma4-over-HTTP vs harness-adapter fallback, with numbers; the
   consolidated page. The user gates the subject.

GPU: gemma4 E2B is ~2.1 GB resident; it fits beside the harness (3.8 GB
today, 2.6 after the switch) — no window juggling, but note nvidia-smi in
every report.
