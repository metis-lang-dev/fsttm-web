#!/usr/bin/env bash
# run.sh — the reference page on a plain llama-server: the example intent turn
# (prompt/, grammar/) and the free dialog, with a Gemma 4 GGUF.
#
#   MODEL=<gguf> ./run.sh            # http://localhost:8393
#   PORT=8394 MODEL=<gguf> ./run.sh  # elsewhere
#   LLAMA=<dir of llama-server>      # else llama-server on PATH
set -euo pipefail
cd "$(dirname "$0")"
MODEL=${MODEL:?a Gemma 4 GGUF: MODEL=<path.gguf> ./run.sh}
SERVER="${LLAMA:+$LLAMA/}llama-server"
PORT=${PORT:-8393}
# llama-server serves nothing outside --path (symlinks get 403): the page's
# assets are copied from prompt/ and grammar/ (the canonical files) into
# web/assets/, and lib/ into web/lib/ (both gitignored), at every start.
rm -rf web/assets web/lib && mkdir -p web/assets
cp prompt/*.txt grammar/*.gbnf web/assets/
# the library (lib/, the framework's exportable part) is served beside the page
cp -r lib web/lib
# one slot = one dialog, so the KV prefix (the system turn) stays cached between turns
exec "$SERVER" -m "$MODEL" -ngl 99 -c 4096 -b 512 -np 1 \
  --path web --host 127.0.0.1 --port "$PORT" "$@"
