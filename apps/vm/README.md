# VM (Component C)

Fake cloud VM process for the POC. Dials the control plane, registers, heartbeats,
and executes tools against a local workspace.

## Env

| Variable | Default |
|---|---|
| `CONTROL_PLANE_WS_URL` | `ws://localhost:3001/ws/vm` |
| `WORKSPACE_DIR` | `./workspace` (resolved from package dir) |
| `HEARTBEAT_INTERVAL_MS` | `5000` |
| `DEBUG_PORT` | `3002` (set `0` to disable) |

## Debug

With the VM running (default port `3002`):

```bash
# List workspace
curl 'http://localhost:3002/debug/ls?path=.'

# Connection / heartbeat status
curl 'http://localhost:3002/debug/status'

# Simulate unhealthy — pause heartbeats (CP evicts after ~30s)
curl 'http://localhost:3002/debug/unhealthy'

# Simulate unhealthy — pause + close WS immediately (no reconnect)
curl 'http://localhost:3002/debug/unhealthy?disconnect=1'

# Back to healthy — resume heartbeats / reconnect
curl 'http://localhost:3002/debug/healthy'
```

Watch CP logs / `GET http://localhost:3001/debug/state` to confirm pool eviction and re-register.

For a second VM on another port: `DEBUG_PORT=3003 WORKSPACE_DIR=./workspace-2 npm run start:vm`.

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

- Connects and sends `register` with generated UUID `externalId`
- Heartbeats on interval
- Handles `assignment` (stores `threadId`)
- Executes `read_file` / `write_file` / `edit_file` / `shell`
- `edit_file` uniqueness failures return `{ ok: false, error }`
- Path traversal rejected
- Parallel `execute_tool_call` messages each get a matching `tool_call_response`
