#!/usr/bin/env bash
# run.sh — the reference page on a plain llama-server: the example intent turn
# (prompt/, grammar/) and the free dialog, with a Gemma 4 GGUF.
#
#   MODEL=<gguf> ./run.sh            # http://localhost:8393
#   PORT=8394 MODEL=<gguf> ./run.sh  # elsewhere
#   LLAMA=<dir of llama-server>      # else llama-server on PATH
#
# At a terminal, the terminal is the host's backchannel: what you type is the person's line in
# the page (/system … speaks as her, /ctl barge_in=energy …, /quit; python -m fsttm_web.chat), and
# the page's rows print here. It is a Relay on HOST_PORT (PORT+2): the page finds it through
# web/assets/host.json and connects by itself; other hosts at ws://127.0.0.1:HOST_PORT/host.
# It needs a python with aiohttp (PY=…; else the repo's .venv beside this checkout, or python3).
# llama-server's log is then $TMPDIR/fsttm-web-llama-PORT.log. HOST=0, or stdin not a terminal:
# llama-server alone, as before.
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
LLAMA_ARGS=(-m "$MODEL" -ngl 99 -c 4096 -b 512 -np 1 --path web --host 127.0.0.1 --port "$PORT" "$@")

# the host's terminal: a python that has aiohttp and finds fsttm_web (python/)
HOST_PORT=${HOST_PORT:-$((PORT + 2))}
PYBIN=""
if [[ ${HOST:-1} != 0 && -t 0 ]]; then
  for p in "${PY:-}" ../.venv/bin/python python3; do
    if [[ -n $p ]] && PYTHONPATH=python "$p" -c 'import aiohttp, fsttm_web.chat' 2>/dev/null; then PYBIN=$p; break; fi
  done
  [[ -n $PYBIN ]] || echo "run.sh: no python with aiohttp (PY=…): llama-server alone, no host terminal" >&2
fi
if [[ -z $PYBIN ]]; then
  exec "$SERVER" "${LLAMA_ARGS[@]}"
fi

printf '{"url": "ws://127.0.0.1:%s/page"}\n' "$HOST_PORT" > web/assets/host.json
LOG=${TMPDIR:-/tmp}/fsttm-web-llama-$PORT.log
"$SERVER" "${LLAMA_ARGS[@]}" > "$LOG" 2>&1 &
LLAMA_PID=$!
trap 'set +e; kill "$LLAMA_PID" 2>/dev/null; wait "$LLAMA_PID" 2>/dev/null' EXIT   # set +e: wait's 143 must not end the trap early
sleep 1
kill -0 "$LLAMA_PID" 2>/dev/null || { tail -n 20 "$LOG" >&2; exit 1; }
echo "llama-server: http://localhost:$PORT (pid $LLAMA_PID, its log $LOG)" >&2
PYTHONPATH=python "$PYBIN" -m fsttm_web.chat --serve "$HOST_PORT"
