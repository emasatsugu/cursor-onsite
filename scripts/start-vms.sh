#!/usr/bin/env bash
# Spin up N fake VMs with deterministic ids; merge logs prefixed by id.
#
# Usage (from repo root):
#   ./scripts/start-vms.sh [count]
#   npm run start:vms
#   npm run start:vms -- 3
#
# Id scheme (same as manual) — ids start at 1 (3000/3001 are reserved):
#   WORKSPACE_DIR=./workspace-2 DEBUG_PORT=3021 PORT=3020 VM_EXTERNAL_ID=2 npm run start:vm
#
#   VM_EXTERNAL_ID = N          (N = 1 .. count)
#   PORT           = 3000 + N*10
#   DEBUG_PORT     = PORT + 1
#   WORKSPACE_DIR  = apps/vm/workspace-N
#
# Ctrl-C stops all children. Inherits GITHUB_TOKEN / CONTROL_PLANE_WS_URL / etc.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VM_DIR="$ROOT/apps/vm"
COUNT="${1:-2}"

if ! [[ "$COUNT" =~ ^[0-9]+$ ]] || [[ "$COUNT" -lt 1 ]] || [[ "$COUNT" -gt 32 ]]; then
  echo "usage: $0 [count]  (1–32)" >&2
  exit 1
fi

PIDS=()

cleanup() {
  echo "[start-vms] stopping ${#PIDS[@]} VM(s)…"
  for pid in "${PIDS[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

prefix_lines() {
  local id="$1"
  # Preserve partial lines; prefix each complete line.
  while IFS= read -r line || [[ -n "$line" ]]; do
    printf '[%s] %s\n' "$id" "$line"
  done
}

echo "[start-vms] launching ${COUNT} VM(s) (ids 1..${COUNT})"
echo "[start-vms] scheme: id=N  PORT=3000+N*10  DEBUG_PORT=PORT+1  WORKSPACE_DIR=./workspace-N  VM_EXTERNAL_ID=N"

for ((id = 1; id <= COUNT; id++)); do
  port=$((3000 + id * 10))
  debug_port=$((port + 1))
  workspace="$VM_DIR/workspace-$id"

  echo "[start-vms] id=${id}  PORT=${port}  DEBUG_PORT=${debug_port}  WORKSPACE_DIR=${workspace}"

  (
    cd "$VM_DIR"
    # Merge stdout+stderr, prefix with [id]
    VM_EXTERNAL_ID="$id" \
    PORT="$port" \
    DEBUG_PORT="$debug_port" \
    WORKSPACE_DIR="$workspace" \
    npm run start --silent 2>&1 | prefix_lines "$id"
  ) &
  PIDS+=($!)
done

echo "[start-vms] all spawned; Ctrl-C to stop"
wait
