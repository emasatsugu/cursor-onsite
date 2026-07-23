#!/usr/bin/env bash
# Spin up N control-plane instances with deterministic ports; merge logs prefixed by id.
#
# Usage (from repo root):
#   ./scripts/start-cps.sh [count]
#   npm run start:cps
#   npm run start:cps -- 2
#
# Id / port scheme (ids start at 1; stays clear of VM 3010+ and single-CP :3001):
#   CP_INSTANCE_ID = N
#   PORT           = (N+3)*1000      → 4000, 5000, 6000, …
#   (+1 reserved)  = PORT+1          → 4001, 5001, … (unused today; mirrors VM DEBUG_PORT)
#   DATABASE_PATH  = shared sqlite at apps/control-plane/data/poc.sqlite
#
# Put the demo proxy in front (:3001) with npm run start:proxy so browser/VMs keep
# talking to localhost:3001.
#
# Ctrl-C stops all children.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CP_DIR="$ROOT/apps/control-plane"
COUNT="${1:-2}"
DB_PATH="${DATABASE_PATH:-$CP_DIR/data/poc.sqlite}"

if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [[ "$COUNT" -lt 1 ]] || [[ "$COUNT" -gt 8 ]]; then
  echo "usage: $0 [count]  (1–8)" >&2
  exit 1
fi

PIDS=()

cleanup() {
  echo "[start-cps] stopping ${#PIDS[@]} CP(s)…"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

prefix_lines() {
  local id="$1"
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '[cp-%s] %s\n' "$id" "$line"
  done
}

echo "[start-cps] launching ${COUNT} CP(s) (ids 1..${COUNT})"
echo "[start-cps] scheme: id=N  PORT=(N+3)*1000  (+1 reserved)  CP_INSTANCE_ID=N"
echo "[start-cps] DATABASE_PATH=${DB_PATH}"

for ((id = 1; id <= COUNT; id++)); do
  port=$(((id + 3) * 1000))
  reserved=$((port + 1))

  echo "[start-cps] id=${id}  PORT=${port}  (reserved ${reserved})  CP_INSTANCE_ID=${id}"

  (
    cd "$CP_DIR"
    CP_INSTANCE_ID="$id" \
    PORT="$port" \
    DATABASE_PATH="$DB_PATH" \
    npm run start --silent 2>&1 | prefix_lines "$id"
  ) &
  PIDS+=($!)
done

echo "[start-cps] all spawned; Ctrl-C to stop"
echo "[start-cps] tip: npm run start:proxy   # front door :3001 → these backends"
wait
