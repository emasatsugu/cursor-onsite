# CP proxy (local load-balancer stand-in)

Front door for multi-CP demos. Browser + VMs keep talking to `:3001`; this process
routes to CP instances on `4000`, `5000`, … by **looking up ownership in SQLite**,
not consistent hashing.

```text
thread → active assignment → vm → owner_cp_id → CP backend
```

Reassignment updates `assignments` / `owner_cp_id`; the next HTTP/WS hop resolves
the new owner.

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

## Routing notes

- **HTTP follow-up** (`POST /threads/:id/messages`): owner lookup; if none, round-robin (on-demand assign).
- **HTTP create / list**: round-robin (any CP + shared DB).
- **VM WS**: buffer until `register`, then route by `owner_cp_id` for that `externalId` (or pick a backend; CP stamps `owner_cp_id` on register).
- **Browser WS**: buffer until `subscribe` (or `?threadId=`), then owner lookup.
