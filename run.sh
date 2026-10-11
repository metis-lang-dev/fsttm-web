#!/usr/bin/env bash
# run.sh — the whole backend (DESIGN.md §2): llama-server from the pinned
# llama.cpp checkout with gemma4 E2B Q4, serving the page from web/.
#
#   ./run.sh                 # http://localhost:8393
#   PORT=8394 ./run.sh       # elsewhere
#   MODEL=<gguf> ./run.sh    # another model (the parity bar is on E2B Q4)
set -euo pipefail
cd "$(dirname "$0")"
LLAMA=${LLAMA:-$HOME/archive/vox/llama.cpp/build/bin}
MODEL=${MODEL:-$HOME/repo/perotheia-packages/metis-agent/go/models/gemma4/gemma-4-E2B-it-Q4_K_M.gguf}
PORT=${PORT:-8393}
# llama-server serves nothing outside --path (symlinks get 403): the page's
# assets are copied from prompt/ grammar/ test/fixtures/ (the canonical
# files) into web/assets/ (gitignored) at every start.
rm -rf web/assets && mkdir -p web/assets
cp prompt/*.txt grammar/dog.gbnf test/fixtures/dog-corpus.tsv test/fixtures/harness-e2b.jsonl web/assets/
# -c 4096 and -b 512 as the harness (config.ws.yaml); one slot = one dialog,
# so the KV prefix (the system turn) stays cached between turns.
exec "$LLAMA/llama-server" -m "$MODEL" -ngl 99 -c 4096 -b 512 -np 1 \
  --path web --host 127.0.0.1 --port "$PORT" "$@"
