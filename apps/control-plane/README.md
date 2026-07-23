# Control plane

Node/Express + `ws` + Sequelize/SQLite. Owns `@poc/shared` and the agent loop.

**In-memory (not DB):** VM pool, sticky assignments, availability, WS handles.  
**SQLite:** threads + transcripts/blobs only (history). `virtual_machines` / `assignments` tables may still exist from earlier schema but are unused at runtime.

## Run

```bash
# from repo root
npm install
npm run build:shared
cp apps/control-plane/.env.example apps/control-plane/.env   # MOCK_OPENAI=1 by default
npm run db:init          # creates data/poc.sqlite (optional; also runs on boot)
npm run start:cp         # :3001
```

DB helpers: `npm run db:init` / `npm run db:reset` (wipe + recreate).

Env: see `.env.example`. Set `OPENAI_API_KEY` and `MOCK_OPENAI=0` for real OpenAI.

## Endpoints

- HTTP `GET/POST /threads`, `GET /threads/:id`, `POST /threads/:id/messages`, `GET /health`
- HTTP `GET /debug` (alias `/debug/state`) — `vmPool`, `assignments`, `browserWs` (+ idle reclaim timers)
- WS `ws://localhost:3001/ws/browser` — subscribe-only streaming
- WS `ws://localhost:3001/ws/vm` — VM register / heartbeat / tool responses

Debug logs use the `[cp:debug]` prefix (assignments, heartbeats, WS traffic both directions).

## Smoke

With CP running:

```bash
npx tsx scripts/smoke.ts
```
