# fsttm-web

The FSTTM floor machine in Chrome over a plain llama-server (design:
[DESIGN.md](DESIGN.md)). Step 1: the skeleton and intent parity with the
metis-agent harness.

```
./run.sh                         # llama-server, gemma4 E2B Q4, page on http://localhost:8393
node test/parity.mjs             # the 54-row corpus through the page's llm.js, vs the harness
open http://localhost:8393/?parity   # the same run in Chrome
```

- `web/llm.js`: the harness's two-pass turn (TemplateGemma4 rendering, pass 1
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
