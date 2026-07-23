# VM (Component C)

Fake cloud VM process for the POC. Dials the control plane, registers, heartbeats,
and executes tools against a local workspace.

## Env

| Variable | Default |
|---|---|
| `CONTROL_PLANE_WS_URL` | `ws://localhost:3001/ws/vm` |
| `WORKSPACE_DIR` | `./workspace` (resolved from package dir) |
| `HEARTBEAT_INTERVAL_MS` | `5000` |
| `PORT` | `0` (disabled) — main HTTP `GET /health` when set |
| `DEBUG_PORT` | `3002` (set `0` to disable) |
| `VM_EXTERNAL_ID` | **required** — stable id used to register with the CP (e.g. `2`) |
| `GITHUB_TOKEN` | **required for push** — PAT with `contents:write` on the workspace repo |

### Fleet launcher

From repo root (CP should already be running):

```bash
export GITHUB_TOKEN=ghp_...
npm run start:vms        # 2 VMs: ids 1, 2
npm run start:vms -- 3   # ids 1 .. 3
# or: ./scripts/start-vms.sh 3
```

Same derivation as a manual start for id `2`:

```bash
WORKSPACE_DIR=./workspace-2 DEBUG_PORT=3021 PORT=3020 VM_EXTERNAL_ID=2 npm run start:vm
```

| id | `VM_EXTERNAL_ID` | `PORT` | `DEBUG_PORT` | `WORKSPACE_DIR` |
|---|---|---|---|---|
| N (≥1) | `N` | `3000 + N*10` | `PORT + 1` | `./workspace-N` |

Child logs merge on stdout prefixed `[N]`.

### Workspace store (shared GitHub repo)

Hard-coded remote (all VMs): see `src/gitRemote.ts` → `https://github.com/emasatsugu/cursor-onsite-test.git`

Create that public repo with a `main` branch first. Policy:

- **threadId === branch name** (1:1)
- `restore(threadId)` / `persist(threadId)` — no merge to `main` in this product
- After each successful **mutating** tool (`write_file`, `edit_file`, `shell`), VM commits + pushes that thread’s branch
- On `assignment`, VM auto-`restore`s

```bash
export GITHUB_TOKEN=ghp_...
WORKSPACE_DIR=./workspace-1 DEBUG_PORT=3011 PORT=3010 VM_EXTERNAL_ID=1 npm run start:vm

curl 'http://localhost:3011/debug/persist'
curl 'http://localhost:3011/debug/restore?threadId=<uuid>'
```

## Debug

With the VM running (default port `3002`):

```bash
# List workspace
curl 'http://localhost:3002/debug/ls?path=.'

# Connection / heartbeat status
curl 'http://localhost:3002/debug/status'

# Simulate unhealthy — pause heartbeats (CP evicts after ~30s); auto-persists first
curl 'http://localhost:3002/debug/unhealthy'

# Simulate unhealthy — pause + close WS immediately (no reconnect)
curl 'http://localhost:3002/debug/unhealthy?disconnect=1'

# Back to healthy — resume heartbeats / reconnect
curl 'http://localhost:3002/debug/healthy'

# Workspace checkpoint / restore (GitHub remote, threadId === branch)
curl 'http://localhost:3002/debug/persist'
curl 'http://localhost:3002/debug/restore?threadId=<uuid>'
```
Watch CP logs / `GET http://localhost:3001/debug` to confirm pool eviction and re-register.

`VM_EXTERNAL_ID` is required. Prefer the id-derived scheme (or `npm run start:vms`):

```bash
WORKSPACE_DIR=./workspace-1 DEBUG_PORT=3011 PORT=3010 VM_EXTERNAL_ID=1 npm run start:vm
WORKSPACE_DIR=./workspace-2 DEBUG_PORT=3021 PORT=3020 VM_EXTERNAL_ID=2 npm run start:vm
```
## Scripts

```bash
# From repo root
npm install
npm run build:shared

# Solo test against stub CP
npm run stub:cp          # terminal 1
npm run start -w @poc/vm # terminal 2

# Unit tests (tools, path safety)
npm run test:vm
```

## Acceptance

- Connects and sends `register` with required `VM_EXTERNAL_ID`
- Heartbeats on interval
- Handles `assignment` (stores `threadId`)
- Executes `read_file` / `write_file` / `edit_file` / `shell`
- `edit_file` uniqueness failures return `{ ok: false, error }`
- Path traversal rejected
- Parallel `execute_tool_call` messages each get a matching `tool_call_response`
