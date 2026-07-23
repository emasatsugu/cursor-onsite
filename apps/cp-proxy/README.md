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

- **HTTP follow-up** (`POST /threads/:id/messages`): owner lookup; if none, route to a CP that has a **free** healthy VM (not blind RR).
- **HTTP create** (`POST /threads`): same — pick a CP with free capacity from DB.
- **VM WS**: buffer until `register`, then route by `owner_cp_id` for that `externalId` (or pick a backend; CP stamps `owner_cp_id` on register).
- **Browser WS**: wait for `subscribe` (or `?threadId=`), then owner lookup. Re-subscribe can switch upstream if the thread’s owner changed. **Never** pin the socket via early round-robin (that caused the UI to hang on “agent working” while the loop ran on another CP).

## Debug

```bash
curl -s http://localhost:3001/mappings | jq
# alias:
curl -s http://localhost:3001/debug | jq
```

Shows configured backends, `vmToOwner`, and `threadToOwner` (active assignments only) with where the proxy would route.
