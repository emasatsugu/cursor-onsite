# Control plane

Node/Express + `ws` + Sequelize/SQLite. Owns `@poc/shared` and the agent loop.

**SQLite (SoT):** threads, transcripts/blobs, `virtual_machines` (+ `owner_cp_id`), `assignments`.  
**In-memory:** live WS handles, connectedness / heartbeats, `vmByThread` cache, browser subs, running loops.

On boot, any leftover `active` assignments are marked `completed` (no sticky across CP restart). VM disconnect / idle reclaim also complete assignments; follow-ups assign any free connected VM on demand and `restore` the workspace.

**Multi-CP local demo:** `npm run start:cps` (ports `(N+3)*1000` → 4000, 5000, …) + `npm run start:proxy` (front door `:3001`). See `apps/cp-proxy/README.md`.

## Run

```bash
# from repo root
npm install
npm run build:shared
cp apps/control-plane/.env.example apps/control-plane/.env   # MOCK_OPENAI=1 by default
npm run db:init          # creates data/poc.sqlite (optional; also runs on boot)
npm run start:cp         # single CP on :3001

# multi-CP:
# npm run start:cps      # CP ids 1..N on :4000, :5000, …
# npm run start:proxy    # :3001 → backends via owner_cp_id lookup
```

DB helpers: `npm run db:init` / `npm run db:reset` (wipe + recreate).

Env: see `.env.example`. Set `OPENAI_API_KEY` and `MOCK_OPENAI=0` for real OpenAI.

## Endpoints

- HTTP `GET/POST /threads`, `GET /threads/:id`, `POST /threads/:id/messages`, `GET /health`
- HTTP `GET /debug` (alias `/debug/state`) — live pool + `db.virtualMachines` / `db.activeAssignments`
- WS `ws://localhost:3001/ws/browser` — subscribe-only streaming
- WS `ws://localhost:3001/ws/vm` — VM register / heartbeat / tool responses

Debug logs use the `[cp:debug]` prefix (assignments, heartbeats, WS traffic both directions).

## Smoke

With CP running:

```bash
npx tsx scripts/smoke.ts
```
