# CP proxy (local load-balancer stand-in)

Front door for multi-CP demos. Browser + VMs keep talking to `:3001`; this process
routes to CP instances on `4000`, `5000`, … by **looking up ownership in SQLite**,
not consistent hashing.

```text
thread → active assignment → vm → owner_cp_id → CP backend
```

Reassignment updates `assignments` / `owner_cp_id`; the next HTTP/WS hop resolves
the new owner. **Dead CPs** are skipped (health probe + optional debug override);
ownership is scrubbed so sticky traffic is not black-holed.

## Run

```bash
# terminal 1 — two CPs on :4000 and :5000 (shared sqlite)
npm run start:cps

# terminal 2 — proxy on :3001
npm run start:proxy

# terminal 3 — VMs (CONTROL_PLANE_WS_URL defaults to ws://localhost:3001/ws/vm)
npm run start:vms
```

Env:

| Variable | Default |
|---|---|
| `PROXY_PORT` / `PORT` | `3001` |
| `DATABASE_PATH` | `apps/control-plane/data/poc.sqlite` |
| `CP_COUNT` | `2` (used when `CP_BACKENDS` unset) |
| `CP_BACKENDS` | `1=127.0.0.1:4000,2=127.0.0.1:5000` derived from `CP_COUNT` |
| `CP_HEALTH_INTERVAL_MS` | `3000` |
| `CP_HEALTH_TIMEOUT_MS` | `1500` |

## Routing notes

- **HTTP follow-up** (`POST /threads/:id/messages`): live sticky owner if assigned; else on-demand assign on a **live** CP with free capacity.
- **HTTP create** (`POST /threads`): same — pick a live CP with free capacity from DB.
- **VM WS**: buffer until `register`, then route by live `owner_cp_id` (or pick a live backend; CP stamps ownership on register). One retry on upstream failure.
- **Browser WS**: wait for `subscribe` (or `?threadId=`), then owner lookup among live backends. Re-subscribe can switch upstream if the thread’s owner changed.
- **Dead owner**: health probe fail or `/debug/unhealthy` → complete stickies for that CP’s VMs, clear `owner_cp_id`, mark VMs `unhealthy`, **evacuate** proxied VM/browser sockets so VMs reconnect on a live CP, route elsewhere.

## Debug

```bash
curl -s http://localhost:3001/mappings | jq
# alias:
curl -s http://localhost:3001/debug | jq

# Simulate dead CP-1 (no kill) — scrub ownership, stop routing, kick VMs to reconnect elsewhere
curl -s 'http://localhost:3001/debug/unhealthy?cp=1' | jq
# wait ~2s for VMs to re-register on the live CP, then retry the prompt

# Bring CP-1 back into the live pool (re-probes /health)
curl -s 'http://localhost:3001/debug/healthy?cp=1' | jq

# Proxy + backend liveness
curl -s http://localhost:3001/health | jq
```

`/mappings` includes per-backend `live` / `probeOk` / `forceUnhealthy` and `ownerLive` on thread/VM rows.
