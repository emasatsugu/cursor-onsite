# Implementation EDD — Cloud VM File-Editing Agent (POC)

Companion to `edd.md` (product decisions). This doc is the **normative contract** for implementing the three processes in parallel.

## How to use this doc with 3 agents

Spin up one agent per component. Each agent owns only its directory and must treat **§ Shared contracts** as frozen API.

| Agent | Owns | May mock |
|---|---|---|
| **A — Browser** | `apps/web` | Control plane HTTP/WS with a tiny stub server if CP not ready |
| **B — Control plane** | `apps/control-plane` + `packages/shared` | OpenAI client (fixture stream); VM WS peer (test double) |
| **C — VM** | `apps/vm` | Control plane WS with a tiny stub that sends `assignment` / `execute_tool_call` |

**Integration order (after parallel scaffolding):** start CP → start VM (registers) → start web → `POST /threads`.

**Rule:** If a payload shape is ambiguous, extend `packages/shared` and this doc — do not invent one-off types inside an app.

---

## Repo layout

```
/
  edd.md
  implementation-edd.md
  package.json                 # npm workspaces root (optional but preferred)
  packages/shared/             # Agent B creates first; A and C depend on it
    package.json               # name: @poc/shared
    src/protocol.ts            # all WS + HTTP DTOs + tool names
    src/tools.ts               # OpenAI tool JSON schemas (also used by CP)
    src/index.ts
  apps/control-plane/
  apps/web/
  apps/vm/
  apps/vm/workspace/           # seed files the agent can edit (committed fixtures)
```

Ports (fixed for local demo):

| Process | Port | Notes |
|---|---|---|
| Control plane HTTP | `3001` | REST |
| Control plane WS (browser) | `3001` | same server, path `/ws/browser` |
| Control plane WS (VM) | `3001` | same server, path `/ws/vm` |
| Web (Vite) | `5173` | proxies `/api` → `3001` optional |

Env:

```
# apps/control-plane
PORT=3001
DATABASE_PATH=./data/poc.sqlite
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o-mini
DEMO_USER_ID=demo-user

# apps/vm
CONTROL_PLANE_WS_URL=ws://localhost:3001/ws/vm
WORKSPACE_DIR=./workspace
HEARTBEAT_INTERVAL_MS=5000

# apps/web
VITE_CP_HTTP_URL=http://localhost:3001
VITE_CP_WS_URL=ws://localhost:3001/ws/browser
```

---

## Shared contracts (NORMATIVE)

All messages are JSON. Every WS message has top-level `type: string`.

### `packages/shared` — types to implement

```ts
// --- Tools ---
export type ToolName = "read_file" | "write_file" | "edit_file" | "shell";

export type ReadFileArgs = { path: string; start_line?: number; end_line?: number };
export type WriteFileArgs = { path: string; content: string };
export type EditFileArgs = { path: string; old_string: string; new_string: string };
export type ShellArgs = { command: string; cwd?: string };

export type ToolArgs = ReadFileArgs | WriteFileArgs | EditFileArgs | ShellArgs;

export type ShellToolResult = { stdout: string; stderr: string; exit_code: number };
export type ReadFileToolResult = { content: string };
export type WriteFileToolResult = { ok: true };
export type EditFileToolResult = { ok: true } | { ok: false; error: string };
export type ToolResultPayload =
  | ShellToolResult
  | ReadFileToolResult
  | WriteFileToolResult
  | EditFileToolResult
  | { ok: false; error: string };

// --- Transcript blob (one turn) ---
// Stored JSON array of OpenAI-style messages for that turn only (no system/tools).
export type TurnMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: ToolName; arguments: string }; // arguments = JSON string
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string }; // content = JSON.stringify(result)

export type TranscriptBlob = TurnMessage[];

// --- HTTP ---
export type ThreadSummary = {
  id: string;
  userId: string;
  createdAt: string; // ISO
};

export type TranscriptDTO = {
  id: string;
  threadId: string;
  createdAt: string;
  messages: TranscriptBlob; // blob resolved
};

export type ThreadDetail = ThreadSummary & {
  transcripts: TranscriptDTO[];
};

export type CreateThreadRequest = { prompt: string };
export type CreateThreadResponse = { thread: ThreadSummary };
export type PostMessageRequest = { prompt: string };
export type PostMessageResponse = { transcriptId: string };

// --- Browser ↔ CP WS ---
export type BrowserClientMessage = {
  type: "subscribe";
  threadId: string;
};

export type BrowserServerMessage =
  | {
      type: "assistant_message";
      threadId: string;
      transcriptId: string;
      // streaming: cumulative or delta — use delta for POC
      delta: string;
    }
  | {
      type: "tool_call_start";
      threadId: string;
      transcriptId: string;
      toolCallId: string;
      name: ToolName;
      arguments: string; // full JSON args string once buffered/complete
    }
  | {
      type: "tool_call_result";
      threadId: string;
      transcriptId: string;
      toolCallId: string;
      result: string; // JSON string of ToolResultPayload
    }
  | {
      type: "agent_loop_done";
      threadId: string;
      transcriptId: string;
    }
  | {
      type: "agent_loop_error";
      threadId: string;
      transcriptId?: string;
      error: string;
    };

// --- CP ↔ VM WS ---
export type VmClientMessage =
  | { type: "register"; externalId: string }
  | { type: "heartbeat"; externalId: string }
  | {
      type: "tool_call_response";
      toolCallId: string;
      ok: boolean;
      result: ToolResultPayload;
    };

export type VmServerMessage =
  | { type: "assignment"; threadId: string }
  | {
      type: "execute_tool_call";
      toolCallId: string;
      name: ToolName;
      arguments: ToolArgs; // parsed object, not string
    };
```

### HTTP API (Control plane)

Base: `http://localhost:3001`

| Method | Path | Request | Response | Semantics |
|---|---|---|---|---|
| `GET` | `/threads` | — | `{ threads: ThreadSummary[] }` | demo user only |
| `GET` | `/threads/:id` | — | `ThreadDetail` | 404 if missing |
| `POST` | `/threads` | `CreateThreadRequest` | `201 CreateThreadResponse` | assign VM, persist, **start loop async**, return immediately |
| `POST` | `/threads/:id/messages` | `PostMessageRequest` | `200 PostMessageResponse` | sticky VM, **start loop async**, return `transcriptId` |
| `GET` | `/health` | — | `{ ok: true }` | optional |

Errors: JSON `{ error: string }` with 4xx/5xx. Important cases:
- `503` on `POST /threads` if no healthy unassigned VM
- `409` if a generation is already running for that thread (POC: reject concurrent prompts)
- `404` unknown thread
- `503` on follow-up if sticky VM not connected (do not reassign)

CORS: allow `http://localhost:5173`.

### Browser WebSocket — `ws://localhost:3001/ws/browser`

1. Client connects.
2. Client sends `subscribe` with `threadId` (may subscribe before or after `POST`).
3. Server fans out `BrowserServerMessage` for that `threadId` to all subscribers.
4. Multiple tabs may subscribe; best-effort delivery; no replay buffer required for POC (history comes from `GET /threads/:id`).

**Streaming notes for CP:**
- `assistant_message.delta` = text chunk from OpenAI stream (empty string chunks may be omitted).
- Emit `tool_call_start` **once** per tool call when args are fully buffered (before or when dispatching to VM).
- Emit `tool_call_result` when VM responds (parallel tools → multiple results, order not guaranteed).
- Always end a run with exactly one of `agent_loop_done` | `agent_loop_error`.

### VM WebSocket — `ws://localhost:3001/ws/vm`

1. VM connects and immediately sends `register`.
2. CP upserts `VirtualMachine` by `externalId`, marks `healthy`, stores WS handle in memory.
3. VM sends `heartbeat` every `HEARTBEAT_INTERVAL_MS`. CP may mark unhealthy if heartbeat missed twice (optional for POC; disconnect ⇒ unhealthy + available for new assignments only if not assigned — **assigned VM disconnect: leave assignment active, fail in-flight tool calls / loop with `agent_loop_error`**).
4. On thread create, CP sends `assignment` to the chosen VM.
5. During loop, CP sends `execute_tool_call` (parallel allowed). VM replies with matching `tool_call_response`.

### Tool execution semantics (VM)

| Tool | Behavior |
|---|---|
| `read_file` | Resolve `path` under `WORKSPACE_DIR` (reject `..` escape). Optional 1-based line slice. Return `{ content }`. |
| `write_file` | Create/overwrite file under workspace. Return `{ ok: true }`. |
| `edit_file` | If `old_string` absent or appears more than once → `{ ok: false, error }`. Else replace once → `{ ok: true }`. |
| `shell` | `child_process.spawn` with `cwd` defaulting to workspace (if `cwd` provided, still must stay under workspace). Return `{ stdout, stderr, exit_code }`. No timeout required for POC. |

CP converts `ToolResultPayload` to tool message `content` via `JSON.stringify(result)` for OpenAI.

### Data model (Sequelize / SQLite)

Tables:

**virtual_machines**
- `id` UUID PK
- `externalId` STRING UNIQUE
- `status` ENUM `healthy` | `unhealthy`
- timestamps

**threads**
- `id` UUID PK
- `userId` STRING
- timestamps

**assignments**
- `id` UUID PK
- `vmId` FK
- `threadId` FK UNIQUE (one active assignment per thread)
- `status` ENUM `active` | `completed` (POC: always `active` once created)
- timestamps

**transcripts**
- `id` UUID PK
- `threadId` FK
- `key` STRING UNIQUE  // blob key
- timestamps
- Order for context: `createdAt ASC` (or auto-increment id)

**blob_storage**
- `key` STRING PK
- `value` TEXT  // JSON.stringify(TranscriptBlob)

**In-memory (CP only, not DB):**
- `vmSockets: Map<externalId, WebSocket>`
- `browserSubs: Map<threadId, Set<WebSocket>>`
- `runningLoops: Set<threadId>`
- `vmByThread: Map<threadId, externalId>` (denormalized from Assignment for speed)

### Agent loop algorithm (CP — authoritative)

```
onStartTurn(threadId, prompt):
  if threadId in runningLoops: reject 409
  runningLoops.add(threadId)
  create Transcript row + blob with initial messages: [{ role:"user", content: prompt }]
  transcriptId = ...
  try:
    loop:
      messages = [system, ...concat all turn blobs for thread in order...]
      stream chat.completions({ model, messages, tools, stream: true })
      accumulate assistant text + tool_calls from deltas
      on text delta: broadcast assistant_message; periodically persist blob overwrite
      when stream ends:
        append assistant message (with tool_calls if any) to current turn blob; overwrite blob
        if no tool_calls:
          broadcast agent_loop_done; return
        broadcast tool_call_start for each completed tool call
        Promise.all(tool_calls.map(tc => send execute_tool_call to sticky VM and wait for tool_call_response))
        for each result:
          broadcast tool_call_result
          append { role:"tool", tool_call_id, content: JSON.stringify(result) } to blob; overwrite
        // loop again with updated messages
  catch err:
    broadcast agent_loop_error
  finally:
    runningLoops.delete(threadId)
```

System prompt (suggested): short — you are a coding agent with read/write/edit/shell tools; paths are relative to the workspace root; prefer edit_file for surgical changes.

OpenAI tool defs: live in `packages/shared/src/tools.ts` so CP imports one source of truth.

---

## Component A — Browser (`apps/web`)

### Responsibility
- List threads, open a thread, show transcript history, create thread / send follow-up prompt.
- Subscribe to WS for live events while a run is in progress; render streaming assistant text and tool call/result panels.

### Out of scope
- Auth, VM management UI, markdown rendering polish beyond basic readability.

### Stack
- React + Vite + TypeScript
- Depends on `@poc/shared` for DTO types only

### UI surfaces (keep simple)
1. **Sidebar:** thread list (`GET /threads`) + “New thread” entry point
2. **Main:** message history from `GET /threads/:id` (flatten `transcripts[].messages` in order)
3. **Composer:** textarea + send
   - If no thread selected / new thread → `POST /threads` then navigate to new id + `subscribe`
   - If existing thread → `POST /threads/:id/messages` + ensure `subscribe`
4. **Live region:** append WS events into the open thread view (assistant deltas concatenate into the latest assistant bubble; tool calls as collapsible rows)

### Acceptance criteria
- [ ] Can create a thread with a prompt and see streamed assistant/tool events (against real or stub CP)
- [ ] Can refresh and reload history via `GET /threads/:id`
- [ ] Can send a follow-up on the same thread
- [ ] Handles `agent_loop_error` visibly
- [ ] Handles `503` no VM available on create

### Suggested file map
```
apps/web/src/
  main.tsx
  App.tsx
  api/client.ts          # fetch wrappers
  ws/browserSocket.ts    # subscribe helper
  components/ThreadList.tsx
  components/ThreadView.tsx
  components/Composer.tsx
```

---

## Component B — Control plane (`apps/control-plane`)

### Responsibility
- SQLite + Sequelize models/migrations (sync is fine for POC)
- HTTP API + both WS endpoints
- VM registry / assignment / heartbeats
- OpenAI streaming agent loop + transcript persistence + browser fanout
- Owns creation of `packages/shared`

### Out of scope
- Horizontal scaling / sticky load balancer
- Auth
- Reassignment across VMs
- Tool timeouts / max iterations (unless trivial `MAX_STEPS=25` guard — optional nicety)

### Stack
- Node + TypeScript
- `express` (or `fastify`) + `ws`
- `sequelize` + `sqlite3`
- `openai` official SDK

### Boot sequence
1. Init DB (create tables)
2. Listen HTTP/WS on `3001`
3. Ready for VM `register` and browser traffic

### Assignment logic
- **New thread:** pick first VM where `status=healthy` AND no `Assignment` with that `vmId` and `status=active`. If none → 503.
- **Follow-up:** load Assignment for thread; find VM socket by externalId; if missing → 503.

### Acceptance criteria
- [ ] VM can register and heartbeat; appears healthy in DB
- [ ] `POST /threads` assigns VM, sends `assignment`, returns 201, runs loop
- [ ] Tool calls round-trip to VM (parallel) and continue the loop
- [ ] Browser subscriber receives the event sequence for a run
- [ ] `GET /threads/:id` returns persisted transcripts after `agent_loop_done`
- [ ] Follow-up uses same VM
- [ ] Concurrent second prompt on same thread → 409

### Suggested file map
```
apps/control-plane/src/
  index.ts
  db/{models,index}.ts
  http/routes.ts
  ws/browser.ts
  ws/vm.ts
  agent/{loop,openai,tools}.ts
  memory/state.ts
```

### Mock points for solo testing
- Replace OpenAI stream with a canned sequence: text → one `read_file` tool call → text done
- Or run against real API with `OPENAI_API_KEY`

---

## Component C — VM (`apps/vm`)

### Responsibility
- Dial CP, register with generated UUID `externalId`, heartbeat
- Track current `threadId` from `assignment` (informational for POC; tools don't need threadId)
- Execute tools against `WORKSPACE_DIR`
- Respond to every `execute_tool_call` with `tool_call_response`

### Out of scope
- Initiating outbound anything except CP WS
- Git lifecycle / snapshots
- Multi-thread multiplexing on one VM (POC: one assignment for life; ignore overlapping assigns)

### Stack
- Node + TypeScript
- `ws` client
- Depends on `@poc/shared`

### Workspace
Ship 2–3 seed files under `apps/vm/workspace/` e.g.:
- `README.md`
- `src/hello.js`

So demos can say “update hello.js to …” without setup.

### Acceptance criteria
- [ ] On start, connects and sends `register`
- [ ] Heartbeats on interval
- [ ] Handles `assignment` (log + store threadId)
- [ ] Executes all four tools correctly including `edit_file` uniqueness failure
- [ ] Path traversal attempts fail safely
- [ ] Parallel `execute_tool_call` messages each get a response with the correct `toolCallId`

### Suggested file map
```
apps/vm/src/
  index.ts
  cpClient.ts
  tools/execute.ts
  tools/{readFile,writeFile,editFile,shell}.ts
workspace/
  README.md
  src/hello.js
```

### Stub CP for solo testing
Minimal WS server on `/ws/vm` that: accepts register, sends one assignment, sends one `execute_tool_call` for `read_file`, prints response. Not required if integrating early with Agent B.

---

## Sequence diagrams

### New thread happy path

```
Browser          Control plane              OpenAI           VM
   |                   |                      |              |
   | POST /threads     |                      |              |
   |------------------>|                      |              |
   |                   |-- pick healthy VM -->|              |
   |                   |-- assignment ----------------------->|
   | 201 {thread}      |                      |              |
   |<------------------|                      |              |
   | WS subscribe      |                      |              |
   |------------------>|                      |              |
   |                   |-- chat.completions stream ---------->|
   | assistant_message |<------- deltas ------|              |
   |<------------------|                      |              |
   | tool_call_start   |                      |              |
   |<------------------|                      |              |
   |                   |-- execute_tool_call --------------->|
   |                   |<------- tool_call_response ---------|
   | tool_call_result  |                      |              |
   |<------------------|                      |              |
   |                   |-- chat.completions (again) -------->|
   | assistant_message |                      |              |
   |<------------------|                      |              |
   | agent_loop_done   |                      |              |
   |<------------------|                      |              |
```

### Continue thread

Same as above but `POST /threads/:id/messages`, skip VM picker / `assignment` (already assigned), reuse sticky socket.

---

## Parallel work checklist (first hour)

1. **Agent B** scaffolds monorepo + `@poc/shared` exporting protocol types + tool JSON schemas; empty express listen + `/health`.
2. **Agent C** scaffolds VM client against shared types; implements tools offline with unit-style local tests; wires WS when CP `/ws/vm` exists.
3. **Agent A** scaffolds Vite app + API client types from shared; builds UI against MSW/stub or waits for GET/POST.
4. Integrate on the happy path before polishing UI.

## Explicit non-goals (all agents)

- Horizontal scale / load balancer
- Auth / multi-user
- Git clone/commit on VM
- Resume after CP restart
- Exact pixel-perfect UI
- Token-accurate cost accounting

---

## Follow-ups / TODOs (post-POC)

- **Reassign thread to a new VM when the sticky VM dies** — today follow-ups 503 with “Sticky VM not connected”. Needs workspace lifecycle (git clone / sync / snapshot restore) so a new VM can pick up the same files; then CP can clear the old assignment and pick an available VM.
- Persist VM pool + assignments again (DB or Redis) when scaling to multiple control-plane instances + sticky routing.
- Resume / recover in-flight agent loops after CP restart.
- Tool-call timeouts, max iterations UX, and cancel mid-run from the browser.
- Optional: allow the same VM `externalId` to survive process restart (stable id) so sticky assignment can reconnect without full reassignment.
