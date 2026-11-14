#!/usr/bin/env bash
# Start the Anime Study Mac side: the library server (home network + Tailscale) and the OP/ED worker.
# Usage: npm run mac:up            (stop with Ctrl-C; both processes stop together)
# Optional: ANIME_STUDY_TOKEN=<16 hex> ANIME_STUDY_FOLDER=<library folder> npm run mac:up
set -euo pipefail
cd "$(dirname "$0")/.."
# The URL token is kept on this Mac only (never in the repo). Set it once with:
#   echo <16 hex> > "$HOME/Library/Application Support/AnimeStudy/token"
TOKEN_FILE="$HOME/Library/Application Support/AnimeStudy/token"
TOKEN="${ANIME_STUDY_TOKEN:-$(cat "$TOKEN_FILE" 2>/dev/null || true)}"
if [ -z "$TOKEN" ]; then
  mkdir -p "$(dirname "$TOKEN_FILE")"
  TOKEN="$(openssl rand -hex 8)"
  echo "$TOKEN" > "$TOKEN_FILE"
  echo "Created a new server token in $TOKEN_FILE; devices pick up the new address from the server." >&2
fi
PORT="${ANIME_STUDY_PORT:-46158}"
FOLDER="${ANIME_STUDY_FOLDER:-$HOME/Downloads/Arc Anime}"
PY="${ANIME_STUDY_PYTHON:-python3}"
mkdir -p outputs/logs

if ! "$PY" -c "import numpy" 2>/dev/null; then
  echo "Note: $PY has no numpy, so the worker will match endings by picture only." >&2
fi

# Started directly (not through a pipe) so $! is the Python process itself and Ctrl-C stops both.
"$PY" -m native.tv.serve "$FOLDER" --port "$PORT" --token "$TOKEN" > outputs/logs/serve.log 2>&1 &
SERVE=$!
WORKER=
trap 'kill $SERVE $WORKER 2>/dev/null; wait 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 30); do curl -s -o /dev/null "http://127.0.0.1:$PORT/$TOKEN/catalog.json" && break; sleep 1; done
# The worker runs on this Mac, so it uses the loopback address: it never changes with the network.
"$PY" native/tv/worker.py "http://127.0.0.1:$PORT/$TOKEN/" --node-name "$(scutil --get ComputerName 2>/dev/null || hostname)" > outputs/logs/worker.log 2>&1 &
WORKER=$!
grep "Anime Study TV:" outputs/logs/serve.log || true
echo "Running. Logs: outputs/logs/serve.log, outputs/logs/worker.log. Ctrl-C stops both."
wait
