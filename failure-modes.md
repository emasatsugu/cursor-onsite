# Failure modes — VM + Control Plane (+ browser idle)

Companion to `edd.md` / `implementation-edd.md`. Focus: what breaks between **control plane ↔ VM**, what we do about it, and **browser going idle** (subscriber drop → reclaim). OpenAI / tool-arg / path-traversal errors are listed only where they interact with that surface.

**Legend — Status**

| Status | Meaning |
|---|---|
| **Handled** | Behavior exists in code today |
| **Partial** | Detected or partially mitigated; gaps remain |
| **TODO** | Spec'd or obvious, not implemented (or explicitly deferred) |

---

## 1. Primary matrix (VM + CP + browser idle)

| ID | Failure | Detection | Immediate effect | Handling / recovery | User-visible | Status |
|---|---|---|---|---|---|---|
| **VM-01** | VM process kill / crash | WS `close` on CP | Socket dropped from `vmSockets` / `vmPool`; sticky `vmByThread` **kept** | Reject in-flight tool waiters → loop `agent_loop_error`; clear `runningLoops`. Same `VM_EXTERNAL_ID` reconnect → `register` → mark connected → **re-send `assignment`** + VM `restore` | Run fails mid-turn if any; follow-up works after reconnect (or lazy reassign) | **Handled** |
| **VM-02** | VM WS close (network blip) | WS `close` | Same as VM-01 | VM auto-reconnect (~2s); CP re-sends sticky `assignment` on `register` | Brief tool/loop failure if mid-tool; otherwise silent | **Handled** |
| **VM-03** | Missed heartbeats (hung / unhealthy sim) | CP sweeper: `lastSeenAt` > `VM_HEARTBEAT_TIMEOUT_MS` (default 30s) | Force-close socket; same as disconnect | Same as VM-01; `/debug/unhealthy` can pause heartbeats (+ optional persist first) | Same as VM-01 after timeout window | **Handled** |
| **VM-04** | Sticky VM down on **new** thread | `findAvailableVm()` empty | — | `POST /threads` → **503** | “No healthy unassigned VM” | **Handled** |
| **VM-05** | Sticky VM down on **follow-up** | `ensureConnectedVmForThread` | — | Prefer sticky if connected; else **lazy reassign** to free healthy VM + `assignment`/`restore`; else **503** | Follow-up succeeds on new VM if free; else 503 | **Handled** (in-memory SoT; DB SoT still TODO) |
| **VM-06** | Mid-loop live migration | — | — | **Out of scope**: always fail the loop first; reassign only on a later prompt | `agent_loop_error`, then retry prompt | **Handled** (by policy) |
| **VM-07** | Tool call: VM not connected at send | `sendExecuteToolCall` returns false | Throw in loop | `agent_loop_error`; blob left at last boundary | Error event on WS | **Handled** |
| **VM-08** | Tool call: no response / hung tool | `waitForToolCallResponse` 60s timeout | Reject waiter | `agent_loop_error` | Error after ~60s | **Handled** |
| **VM-09** | Tool execution failure (`ok: false`, edit uniqueness, path escape, shell nonzero) | VM returns `tool_call_response` | Result stringified into tool message | Loop continues; model sees error payload | Tool result row + model may retry/explain | **Handled** |
| **VM-10** | `restore` fails on `assignment` / tool-call threadId | VM logs error | Workspace may be wrong/stale | Tools still run against current tree; no CP hard fail | Silent wrong files until noticed | **Partial** |
| **VM-11** | `persist` fails after mutating tool | VM logs; no CP waiter | Durability window = last good persist | Continue; later reclaim/reassign may lose edits | Silent data loss risk | **Partial** |
| **VM-12** | CP `persist_request` fails / times out (30s) | `waitForPersistResponse` / `ok: false` | At `agent_loop_done`: log only. On reclaim: log + continue release | Loop still `agent_loop_done`; reclaim still frees VM | Usually invisible; workspace may be stale on next restore | **Partial** |
| **VM-13** | Hard kill mid-edit (no persist) | — | Unpersisted working-tree edits lost | Next `restore` = last checkpoint | Lost agent edits | **Partial** (by design; durability = last persist) |
| **VM-14** | Parallel tools + VM dies mid-batch | Disconnect rejects pending waiters | `Promise.all` fails | `agent_loop_error`; may have dangling assistant `tool_calls` in blob | Error; follow-up context may be invalid | **Partial** (see T-02) |
| **CP-01** | Control plane restart mid-generation | Process gone | In-memory sockets, `runningLoops`, waiters, browser subs **gone** | Boot: loops not resumed. Assignments today are **in-memory** → lost on restart unless re-wired from DB (spec wants DB SoT). Partial turn blobs remain in SQLite | Browser WS drops; in-flight run orphaned; sticky routing may break until reassign/new thread | **Partial** |
| **CP-02** | CP restart, then VM re-registers | VM `register` | — | Spec: reload active assignments, re-send `assignment`. **Code today:** assignments not DB-backed → no sticky rebind after CP restart | Threads may need new create / manual recovery | **TODO** (DB SoT) |
| **CP-03** | Concurrent second prompt on same thread | `runningLoops.has(threadId)` | — | **409** | “Generation already running” | **Handled** |
| **CP-04** | OpenAI stream / API failure mid-loop | Exception in `streamChatCompletion` | — | Catch → `agent_loop_error`; no blob rollback | Error event; history at last boundary | **Handled** |
| **CP-05** | Exceed `MAX_STEPS` (25) | Loop counter | — | `agent_loop_error` with max-steps message | Error event | **Handled** |
| **CP-06** | Broadcast with **0** browser subscribers | `broadcastToThread` | Events dropped (no replay buffer) | History via `GET /threads/:id` is boundary-accurate only | Missed live stream; refresh shows last persisted boundary | **Handled** (best-effort WS) |
| **CP-07** | Invalid / unmatched `tool_call_response` | No waiter for `toolCallId` | Log only | Orphan response ignored | None (or earlier timeout) | **Handled** |
| **BR-01** | Browser tab close / navigate away | Browser WS `close` → `removeBrowserSubFromAll` | Sub count → 0; `threadSubsEmptySince` set | Agent loop **keeps running**; events may go to no one (CP-06). Idle reclaim clock starts | On return: history refresh; live mid-stream text may be missing | **Handled** |
| **BR-02** | Browser WS idle disconnect / sleep | WS `close` + client reconnect (~1.5s) | Temporarily 0 subs | Re-`subscribe` on open; **no event replay** | Possible gap in live UI; reload history | **Partial** |
| **BR-03** | Browser idle long enough to reclaim VM | Idle monitor: no subs for `IDLE_RECLAIM_MS` (default 60s), no running loop, had prior subs | Best-effort `persist_request` → `unassign` → `clearThreadAssignment` | VM returned to pool. Next follow-up: `ensureConnectedVmForThread` (may reassign different VM + `restore`) | Usually invisible if persist succeeded; else possible lost uncheckpointed edits | **Handled** |
| **BR-04** | Idle reclaim while loop running | `runningLoops` check | — | Reclaim **skipped** | None | **Handled** |
| **BR-05** | User never subscribed (prompt only) | `threadSubsEmptySince` never set | — | Idle reclaim **does not** fire (by design: only after had-subs → empty) | VM stays sticky indefinitely until subs appear then leave | **Handled** (policy) |

---

## 2. Transcript / workspace side effects (coupled to VM+CP failures)

These are the main **follow-up correctness** risks when the modes above fire mid-turn. Spec TODOs live in `implementation-edd.md` Follow-ups.

| ID | Failure | Why it matters | Desired handling | Status |
|---|---|---|---|---|
| **T-01** | Crash / error after `[user]` only (stream never finished) | Follow-up context is fine but thin | Leave blob; allow new turn or explicit retry UX | **Partial** (leave-as-is) |
| **T-02** | Assistant + `tool_calls` persisted, tools not all written | Next OpenAI call gets dangling `tool_calls` → API error | On `agent_loop_error`: truncate to consistent prefix, or repair in `loadAllTurnMessages` | **TODO** |
| **T-03** | Replay / regenerate after `agent_loop_error` | Unclear overwrite vs new Transcript; workspace side effects already applied | Product decision + optional workspace rollback | **TODO** |
| **T-04** | Lazy reassign after idle reclaim / VM death | Correctness depends on last successful `persist` | Always `restore` on new `assignment`; document durability window | **Handled** (with VM-11/13 gaps) |

---

## 3. Sequence sketches (failure paths)

### 3a. VM dies mid-tool

```
Browser          CP                         VM
  |              |                          |
  |  (loop)      |-- execute_tool_call ---->|
  |              |     X  (VM crash)        X
  |              |-- reject pending waiter -|
  | agent_loop_error                        |
  |<-------------|                          |
  |              | keep sticky assignment   |
  |              |                          |-- reconnect + register -->
  |              |<-- register --------------|
  |              |-- assignment (re-send) -->|
  |              |                          |-- restore(threadId)
  | POST .../messages (later)               |
  |------------->| sticky socket OK → loop  |
```

### 3b. Browser idle → reclaim → follow-up on (possibly) new VM

```
Browser          CP                         VM-A              VM-B
  | WS close     |                          |                 |
  |------------->| subs=0, emptySince=now   |                 |
  |              | … IDLE_RECLAIM_MS …      |                 |
  |              |-- persist_request ------>|                 |
  |              |<-- persist_response -----|                 |
  |              |-- unassign ------------->|                 |
  |              | clear assignment (A free)|                 |
  | POST follow-up                          |                 |
  |------------->| ensureConnectedVm        |                 |
  |              | (A or B free) ---------->| or ------------>|
  |              |-- assignment + restore → |                 |
  |              | run loop                 |                 |
```

### 3c. CP restart mid-generation (current gap)

```
  In-flight loop + sockets + vmByThread lost
  SQLite transcripts/blobs survive (last boundary)
  VM still connected to dead CP → reconnects to new CP as fresh register
  Without DB-backed assignments: sticky mapping not restored → treat as pool VM
```

---

## 4. Priority to harden next

Ordered by demo risk / user pain:

1. **T-02** — repair or truncate inconsistent turn blobs after mid-tool `agent_loop_error` (otherwise follow-ups can hard-fail against OpenAI).
2. **CP-01 / CP-02** — persist `virtual_machines` + `assignments` in DB; reload + re-bind on boot / VM `register` (closes the “CP restart kills stickiness” hole).
3. **VM-10 / VM-11** — surface `restore`/`persist` failures to CP (and optionally fail the loop or block reassign) instead of log-only.
4. **BR-02** — optional: mark UI “disconnected / may have missed stream” and auto-refresh history on WS reconnect when a run was in progress.
5. **T-03** — explicit retry/replay UX after `agent_loop_error`.

---

## 5. Explicit non-goals (still)

- Mid-loop live migration of a thread between VMs
- Multi-CP ownership / assign locking
- WS event replay buffer for browsers
- Guaranteed durability across hard kill without a successful `persist`
- Tool-level cancel mid-run (beyond failing the whole loop)
