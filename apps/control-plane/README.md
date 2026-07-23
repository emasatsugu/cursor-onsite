# Control plane

Node/Express + `ws` + Sequelize/SQLite. Owns `@poc/shared` and the agent loop.

## Run

```bash
# from repo root
npm install
npm run build:shared
cd apps/control-plane
cp .env.example .env   # MOCK_OPENAI=1 by default
npm run start          # :3001
```

Env: see `.env.example`. Set `OPENAI_API_KEY` and `MOCK_OPENAI=0` for real OpenAI.

## Endpoints

- HTTP `GET/POST /threads`, `GET /threads/:id`, `POST /threads/:id/messages`, `GET /health`
- WS `ws://localhost:3001/ws/browser` — subscribe-only streaming
- WS `ws://localhost:3001/ws/vm` — VM register / heartbeat / tool responses

## Smoke

With CP running:

```bash
npx tsx scripts/smoke.ts
```
