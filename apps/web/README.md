# Component A — Browser (`apps/web`)

React + Vite UI for the cloud VM file-editing agent POC.

## Run against the stub control plane

```bash
# from repo root
npm install
npm run stub        # terminal 1 — mocks CP on :3001
npm run dev:web     # terminal 2 — Vite on :5173
```

## Acceptance checks (stub)

| Action | Expected |
|---|---|
| New thread + prompt | Creates thread, streams assistant text + tool call/result, then `agent_loop_done` |
| Refresh | Reloads history from `GET /threads/:id` |
| Follow-up on same thread | `POST /threads/:id/messages` + more streamed events |
| Prompt containing `[no-vm]` | Visible 503 / no-VM error |
| Prompt containing `[error]` | Visible `agent_loop_error` |

## Talk to the real control plane

Point env at Agent B's CP (same ports by default) and skip the stub:

```bash
cp apps/web/.env.example apps/web/.env
npm run dev:web
```
