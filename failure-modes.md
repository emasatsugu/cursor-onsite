# Failure modes — VM + Control Plane (+ browser idle)

Companion to `edd.md` / `implementation-edd.md` / `final-writeup.md`.

**Primary spine (die timing):** see **§0** below and the matching section in `final-writeup.md`.  
Rest of this file keeps the detailed ID catalog (capacity, persist, browser, transcripts).

**Audited against:** current tree — DB SoT while CP is up; clear actives on boot; disconnect clears sticky; `IDLE_RECLAIM_MS` default **30s** (code); proxy + multi-CP.

**Legend — Status**

| Status | Meaning |
|---|---|
| **Handled** | Behavior exists in code today |
| **Partial** | Detected or partially mitigated; gaps remain |
| **TODO** | Spec'd or obvious, not implemented (or explicitly deferred) |

---

## 0. Die-timing matrix (VM × CP × loop phase)

| When | Meaning |
|---|---|
| **Between loops** | No `runningLoops` |
| **Mid–OpenAI** | Inside `streamChatCompletion` |
| **Loop gap** | Loop running, not in OpenAI stream or tool waiter (post-assistant / pre-tools, post-tools / pre-next-OpenAI, end persist) |
| **Mid–tool** | Blocked on `waitForToolCallResponse` |

| When | VM dies | Owning CP dies |
|---|---|---|
| **Between loops** | **Sticky cleared** (assignment `completed`, cache dropped; thread+blobs kept); next prompt reassigns + restore | Boot **clears stickies** fleet-wide (shared DB); next prompt via proxy |
| **Mid–OpenAI** | Stream **not** aborted; sticky cleared; then done/persist skip or fail at tools → `agent_loop_error`; possible **T-02** | Process gone; no error event; blob usually `[user]` only (**T-01**) |
| **Loop gap** | Sticky cleared; loop continues until next VM need → usually `agent_loop_error`; **T-02** if tools pending in blob | Silent; blob = last boundary; **T-02** if assistant+`tool_calls` without tools |
| **Mid–tool** | Reject waiters → `agent_loop_error`; sticky cleared; **T-02**; unpersisted edits possible | Silent; **T-02** likely; orphan tool on VM |

**Sticky cleared** = tear down thread→VM binding only (`assignments` → `completed` + drop `vmByThread`). Does **not** delete the thread or transcripts; VM returns to the free pool on reconnect (no auto rebind).

Full narrative cells: `final-writeup.md` → Failure modes.

---

## Changelog since prior matrix

| Was | Now |
|---|---|
| Assignments in-memory only; CP restart lost stickiness (**CP-01/02 TODO**) | DB SoT for assignments while CP is up; **CP boot completes all actives** (no sticky across restart); follow-up on-demand assign + `restore` |
| Keep sticky across VM disconnect; lazy reassign on next prompt | **Complete** assignment on disconnect / reclaim; follow-up **on-demand assigns any free VM** |
| `IDLE_RECLAIM_MS` default 60s, sweeper-only | Default **0** (immediate when last sub leaves); also on `unsubscribe` / exclusive re-subscribe; sweeper as backup |
| — | Browser `unsubscribe`; one socket → one thread (exclusive subscribe) |

---

## 1. Primary matrix (VM + CP + browser idle)

| ID | Failure | Detection | Immediate effect | Handling / recovery | User-visible | Status |
|---|---|---|---|---|---|---|
| **VM-01** | VM process kill / crash | WS `close` on CP | Drop socket; DB VM → `unhealthy`; **complete** sticky assignment(s) | Reject in-flight tool waiters → `agent_loop_error`; `persistClear` frees slot. Reconnect → healthy in pool (no auto rebind; stickies already cleared). Next follow-up: `ensureConnectedVmForThread` → any free VM + `assignment`/`restore` | Mid-run fails; follow-up OK if any VM free | **Handled** |
| **VM-02** | VM WS close (network blip) | WS `close` | Same as VM-01 (sticky cleared) | VM reconnect ~2s as free pool member; **not** re-bound to prior thread unless CP still had active row (normally cleared) | Mid-tool run fails; follow-up may land on different VM | **Handled** |
| **VM-03** | Missed heartbeats | Sweeper: `lastSeenAt` > `VM_HEARTBEAT_TIMEOUT_MS` (30s) | Force-close; same as disconnect | Same as VM-01; `/debug/unhealthy` can pause heartbeats (+ optional persist first) | Same after timeout window | **Handled** |
| **VM-04** | No free VM on **new** thread | `findAvailableVm()` empty | — | `POST /threads` → **503** | “No healthy unassigned VM” | **Handled** |
| **VM-05** | No connected sticky on **follow-up** | `ensureConnectedVmForThread` | Scrub dead sticky if present | Assign any free connected VM + `persistAssign` + `assignment`/`restore`; else **503** | Follow-up on (possibly new) VM, or 503 | **Handled** |
| **VM-06** | Mid-loop live migration | — | — | **Out of scope**: fail loop first; assign on a later prompt | `agent_loop_error`, then retry | **Handled** (by policy) |
| **VM-07** | Tool call: VM not connected at send | `sendExecuteToolCall` false | Throw in loop | `agent_loop_error`; blob at last boundary | WS error event | **Handled** |
| **VM-08** | Tool call hung / no response | `waitForToolCallResponse` 60s | Reject waiter | `agent_loop_error` | Error after ~60s | **Handled** |
| **VM-09** | Tool exec failure (`ok: false`, edit uniqueness, path escape, shell nonzero) | `tool_call_response` | Result → tool message | Loop continues; model sees error | Tool result + model may recover | **Handled** |
| **VM-10** | `restore` fails on `assignment` / tool-call threadId | VM logs | Workspace may be wrong/stale | Tools still run; no CP hard fail | Silent wrong files | **Partial** |
| **VM-11** | `persist` fails after mutating tool | VM logs; no CP waiter | Durability = last good persist | Continue; reclaim/reassign may lose edits | Silent data-loss risk | **Partial** |
| **VM-12** | CP `persist_request` fails / 30s timeout | `waitForPersistResponse` / `ok: false` | `agent_loop_done`: log only. Reclaim: log + still `persistClear` | Loop still done; slot freed even if checkpoint failed | Invisible; next restore may be stale | **Partial** |
| **VM-13** | Hard kill mid-edit (no persist) | — | Unpersisted tree lost | Next `restore` = last checkpoint | Lost agent edits | **Partial** (by design) |
| **VM-14** | Parallel tools + VM dies mid-batch | Disconnect rejects waiters | `Promise.all` fails | `agent_loop_error`; may leave dangling assistant `tool_calls` in blob | Error; follow-up may break OpenAI context | **Partial** (see **T-02**) |
| **CP-01** | CP restart mid-generation | Process gone | In-memory sockets, loops, waiters, browser subs **gone** | Boot: `clearActiveAssignmentsOnBoot` (all stickies `completed`). **Do not** auto-resume loops. Partial blobs remain | Browser WS drops; in-flight run orphaned; follow-up assigns any free VM + `restore` | **Partial** (no mid-gen resume — intentional) |
| **CP-02** | CP restart, then VM re-registers | VM `register` | Upsert DB healthy; attach socket as **free** pool member | No sticky rebind (cleared on boot). Next prompt on-demand assigns + `restore` | Works; may land on a different VM than before the bounce | **Handled** |
| **CP-03** | Concurrent second prompt | `runningLoops.has` | — | **409** | “Generation already running” | **Handled** |
| **CP-04** | OpenAI stream / API failure | Exception in stream | — | `agent_loop_error`; no blob rollback | Error; history at last boundary | **Handled** |
| **CP-05** | Exceed `MAX_STEPS` (25) | Loop counter | — | `agent_loop_error` | Error event | **Handled** |
| **CP-06** | Broadcast with 0 browser subscribers | `broadcastToThread` | Events dropped (no replay) | `GET /threads/:id` boundary-accurate only | Missed live stream | **Handled** (best-effort WS) |
| **CP-07** | Unmatched `tool_call_response` | No waiter | Log only | Ignored | None / earlier timeout | **Handled** |
| **CP-08** | Hydrated sticky after CP restart, no browser | — | — | **N/A** — boot clears actives; no orphan sticky | — | **Handled** (by clear-on-boot) |
| **PX-01** | Dead CP instance behind proxy (process down or `/debug/unhealthy`) | Health probe fail / force flag / upstream connect error | Sticky `owner_cp_id` would black-hole traffic | Scrub: complete stickies for that CP’s VMs, clear `owner_cp_id`, mark VMs unhealthy; skip dead owner; HTTP/WS **one retry** on a live CP | Follow-up/create/VM register land on live CP; mid-gen on dead CP still orphaned (no resume) | **Handled** |
| **BR-01** | Browser tab close / navigate away | WS `close` → `removeBrowserSubFromAll` | Subs → 0; `threadSubsEmptySince` set | Loop keeps running if any. **`maybeReclaimThreads`** (default immediate when idle) | Return: history refresh; live mid-stream may be missing | **Handled** |
| **BR-02** | Browser WS blip / sleep + client reconnect (~1.5s) | Close then re-open + re-`subscribe` | With `IDLE_RECLAIM_MS=0`, reclaim may run on close **before** reconnect | Set grace (e.g. `3000`) to tolerate blips. No event replay either way | Possible missed deltas; assignment may churn to another VM on next prompt | **Partial** |
| **BR-03** | Browser idle reclaim | Last sub gone + no loop; `IDLE_RECLAIM_MS` (default **0**) | Best-effort `persist` → `unassign` → `persistClear` | VM back in pool. Next follow-up on-demand assign + `restore` | Usually invisible if persist OK | **Handled** |
| **BR-04** | Reclaim while loop running | `runningLoops` / sub-count checks | — | Reclaim deferred; `maybeReclaimThread` in loop `finally` | None | **Handled** |
| **BR-05** | User never subscribed (HTTP prompt only) | `threadSubsEmptySince` never set | — | Idle reclaim does **not** fire | VM stays sticky until disconnect or later sub→leave | **Handled** (policy) |
| **BR-06** | Switch thread on same socket (exclusive subscribe) | Prior thread emptied | Reclaim prior thread if idle | New thread subscribed; old freed | Prior thread’s VM may be reclaimed | **Handled** |

---

## 2. Transcript / workspace side effects

| ID | Failure | Why it matters | Desired handling | Status |
|---|---|---|---|---|
| **T-01** | Error after `[user]` only (stream never finished) | Context thin but valid | Leave blob; optional retry UX | **Partial** (leave-as-is) |
| **T-02** | Assistant + `tool_calls` written; not all `tool` results | Next OpenAI call can fail on dangling tool_calls | Truncate/repair on `agent_loop_error` or in `loadAllTurnMessages` | **TODO** |
| **T-03** | Replay / regenerate after `agent_loop_error` | Overwrite vs new Transcript; workspace side effects already applied | Product decision + optional rollback | **TODO** |
| **T-04** | On-demand assign after reclaim / VM death | Correctness = last successful `persist` | Always `restore` on `assignment` | **Handled** (gaps: **VM-11/13**) |

---

## 3. Sequence sketches

### 3a. VM dies mid-tool (current policy)

```
Browser          CP                         VM
  |              |                          |
  |  (loop)      |-- execute_tool_call ---->|
  |              |     X  (VM crash)        X
  |              |-- reject pending waiter -|
  | agent_loop_error                        |
  |<-------------|                          |
  |              | persistClear (slot free) |
  |              | DB VM → unhealthy        |
  |              |                          |-- reconnect + register -->
  |              |<-- register (free pool) -|
  | POST .../messages                       |
  |------------->| ensureConnectedVm        |
  |              | assign any free VM ------>| (maybe same, maybe not)
  |              |-- assignment + restore -->|
```

### 3b. Browser leave → immediate reclaim (default `IDLE_RECLAIM_MS=0`)

```
Browser          CP                         VM-A              VM-B
  | WS close     |                          |                 |
  |------------->| maybeReclaim (idle)      |                 |
  |              |-- persist_request ------>|                 |
  |              |-- unassign ------------->|                 |
  |              | persistClear             |                 |
  | POST follow-up                          |                 |
  |------------->| ensureConnectedVm        |                 |
  |              | free A or B --------------------------->|
  |              |-- assignment + restore → |                 |
```

### 3c. CP restart (clear stickies)

```
  In-flight loop + sockets + waiters gone
  SQLite: threads/blobs survive; active assignments → completed on boot
  VM register → free pool (no sticky rebind)
  User follow-up → ensureConnectedVm → assign any free + restore
```

---

## 4. Priority to harden next

Ordered by demo risk / user pain:

1. **T-02** — repair/truncate inconsistent turn blobs after mid-tool `agent_loop_error` (follow-ups can hard-fail against OpenAI).
2. **VM-10 / VM-11 / VM-12** — surface `restore`/`persist` failures to CP (fail loop or block reclaim/reassign) instead of log-only + free-anyway.
3. **BR-02** — default grace for reclaim (`IDLE_RECLAIM_MS>0`) and/or UI “disconnected; refresh history” on WS reconnect during a run.
4. **T-03** — explicit retry/replay UX after `agent_loop_error`.
5. **Later optimization:** hydrate stickies across CP restart + same-VM rebind (optional; not needed for correctness if `persist`/`restore` work).

---

## 5. Explicit non-goals (still)

- Mid-loop live migration between VMs
- Multi-CP ownership / assign locking
- WS event replay buffer for browsers
- Auto-resume of an in-flight agent loop after CP restart
- Same-VM sticky rebind across CP restart (clear-on-boot; restore on next assign is enough)
- Guaranteed durability across hard kill without a successful `persist`
- Tool-level cancel mid-run (beyond failing the whole loop)
