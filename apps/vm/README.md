# VM (Component C)

Fake cloud VM process for the POC. Dials the control plane, registers, heartbeats,
and executes tools against a local workspace.

## Env

| Variable | Default |
|---|---|
| `CONTROL_PLANE_WS_URL` | `ws://localhost:3001/ws/vm` |
| `WORKSPACE_DIR` | `./workspace` (resolved from package dir) |
| `HEARTBEAT_INTERVAL_MS` | `5000` |

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
