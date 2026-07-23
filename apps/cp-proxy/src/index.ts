/**
 * Local stand-in for a prod load balancer in front of multiple control-plane
 * instances.
 *
 * Routing (not consistent hashing):
 *   thread → active assignment → vm → owner_cp_id → backend
 *   VM WS  → peek `register.externalId` → owner_cp_id (or pick a backend + CP claims on register)
 *   no owner / new thread → round-robin across backends
 *
 * Default front door :3001 so existing web/VM env keeps working.
 * Backends default to CP ids 1..N on ports (N+3)*1000 (4000, 5000, …).
 */

import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import sqlite3 from "sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../../..");

const PROXY_PORT = Number(process.env.PROXY_PORT ?? process.env.PORT ?? 3001);
const DB_PATH =
  process.env.DATABASE_PATH ??
  path.join(ROOT, "apps/control-plane/data/poc.sqlite");

type Backend = { id: string; host: string; port: number };

function defaultBackends(count: number): Backend[] {
  const out: Backend[] = [];
  for (let id = 1; id <= count; id++) {
    out.push({
      id: String(id),
      host: "127.0.0.1",
      port: (id + 3) * 1000,
    });
  }
  return out;
}

/** CP_BACKENDS=1=127.0.0.1:4000,2=127.0.0.1:5000 */
function parseBackends(): Backend[] {
  const raw = process.env.CP_BACKENDS?.trim();
  if (!raw) {
    return defaultBackends(Number(process.env.CP_COUNT ?? 2));
  }
  return raw.split(",").map((part) => {
    const [id, addr] = part.split("=").map((s) => s.trim());
    const [host, portStr] = (addr ?? "").split(":");
    if (!id || !host || !portStr) {
      throw new Error(`Bad CP_BACKENDS entry: ${part}`);
    }
    return { id, host, port: Number(portStr) };
  });
}

const backends = parseBackends();
const byId = new Map(backends.map((b) => [b.id, b]));
let rr = 0;

function log(...args: unknown[]): void {
  console.log("[cp-proxy]", ...args);
}

function nextBackend(): Backend {
  const b = backends[rr % backends.length]!;
  rr += 1;
  return b;
}

function openDb(): sqlite3.Database {
  return new sqlite3.Database(DB_PATH);
}

function dbGet<T>(
  db: sqlite3.Database,
  sql: string,
  params: unknown[]
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row as T | undefined);
    });
  });
}

function dbAll<T>(
  db: sqlite3.Database,
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve((rows ?? []) as T[]);
    });
  });
}

async function ownerForThread(threadId: string): Promise<string | null> {
  const db = openDb();
  try {
    const row = await dbGet<{ owner_cp_id: string | null }>(
      db,
      `SELECT vm.owner_cp_id AS owner_cp_id
       FROM assignments a
       JOIN virtual_machines vm ON vm.id = a.vm_id
       WHERE a.thread_id = ? AND a.status = 'active'
       LIMIT 1`,
      [threadId]
    );
    return row?.owner_cp_id ?? null;
  } finally {
    db.close();
  }
}

async function ownerForVm(externalId: string): Promise<string | null> {
  const db = openDb();
  try {
    const row = await dbGet<{ owner_cp_id: string | null }>(
      db,
      `SELECT owner_cp_id FROM virtual_machines WHERE external_id = ? LIMIT 1`,
      [externalId]
    );
    return row?.owner_cp_id ?? null;
  } finally {
    db.close();
  }
}

type VmRow = {
  external_id: string;
  status: string;
  owner_cp_id: string | null;
  updated_at: string;
};

type AssignmentRow = {
  thread_id: string;
  status: string;
  vm_external_id: string;
  vm_status: string;
  owner_cp_id: string | null;
  updated_at: string;
};

/** Snapshot of routing tables the proxy uses (DB + configured backends). */
async function buildMappingsSnapshot() {
  const db = openDb();
  try {
    const vms = await dbAll<VmRow>(
      db,
      `SELECT external_id, status, owner_cp_id, updated_at
       FROM virtual_machines
       ORDER BY external_id ASC`
    );
    const assignments = await dbAll<AssignmentRow>(
      db,
      `SELECT a.thread_id AS thread_id,
              a.status AS status,
              vm.external_id AS vm_external_id,
              vm.status AS vm_status,
              vm.owner_cp_id AS owner_cp_id,
              a.updated_at AS updated_at
       FROM assignments a
       JOIN virtual_machines vm ON vm.id = a.vm_id
       WHERE a.status = 'active'
       ORDER BY a.updated_at DESC`
    );

    return {
      now: new Date().toISOString(),
      proxyPort: PROXY_PORT,
      databasePath: DB_PATH,
      backends: backends.map((b) => ({
        id: b.id,
        url: `http://${b.host}:${b.port}`,
        known: true,
      })),
      /** VM → which CP owns the live socket (null = disconnected / unknown). */
      vmToOwner: vms.map((vm) => {
        const backend = vm.owner_cp_id ? byId.get(vm.owner_cp_id) : undefined;
        return {
          externalId: vm.external_id,
          status: vm.status,
          ownerCpId: vm.owner_cp_id,
          backendUrl: backend
            ? `http://${backend.host}:${backend.port}`
            : null,
          updatedAt: vm.updated_at,
        };
      }),
      /** Thread → VM → owner CP (active stickies only). */
      threadToOwner: assignments.map((a) => {
        const backend = a.owner_cp_id ? byId.get(a.owner_cp_id) : undefined;
        return {
          threadId: a.thread_id,
          vmExternalId: a.vm_external_id,
          vmStatus: a.vm_status,
          ownerCpId: a.owner_cp_id,
          backendUrl: backend
            ? `http://${backend.host}:${backend.port}`
            : null,
          wouldRoute:
            a.owner_cp_id && byId.has(a.owner_cp_id)
              ? `cp-${a.owner_cp_id}`
              : "round-robin (no/unknown owner)",
          updatedAt: a.updated_at,
        };
      }),
      note: "Routing is DB lookup thread→assignment→vm→owner_cp_id, not consistent hashing.",
    };
  } finally {
    db.close();
  }
}

function backendForOwner(ownerCpId: string | null | undefined): Backend {
  if (ownerCpId && byId.has(ownerCpId)) return byId.get(ownerCpId)!;
  return nextBackend();
}

/**
 * CPs that currently own at least one healthy VM with no active assignment.
 * Used so create / on-demand follow-up don't RR onto a saturated CP and 503
 * while another CP still has a free VM.
 */
async function backendsWithFreeVm(): Promise<Backend[]> {
  const db = openDb();
  try {
    const rows = await dbAll<{ owner_cp_id: string }>(
      db,
      `SELECT DISTINCT vm.owner_cp_id AS owner_cp_id
       FROM virtual_machines vm
       WHERE vm.status = 'healthy'
         AND vm.owner_cp_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM assignments a
           WHERE a.vm_id = vm.id AND a.status = 'active'
         )`
    );
    const out: Backend[] = [];
    for (const row of rows) {
      const b = byId.get(row.owner_cp_id);
      if (b) out.push(b);
    }
    return out;
  } finally {
    db.close();
  }
}

async function pickBackendForAssign(): Promise<Backend> {
  const free = await backendsWithFreeVm();
  if (free.length === 0) {
    log("no CP with free VM in DB — falling back to RR");
    return nextBackend();
  }
  // Rotate among CPs that have capacity.
  const b = free[rr % free.length]!;
  rr += 1;
  log(
    `assign-route → cp-${b.id} (free owners: ${free.map((x) => x.id).join(",")})`
  );
  return b;
}

function threadIdFromPath(urlPath: string): string | null {
  // /threads/:id or /threads/:id/messages
  const m = urlPath.match(/^\/threads\/([^/]+)/);
  if (!m) return null;
  if (m[1] === undefined) return null;
  return m[1];
}

async function pickHttpBackend(req: IncomingMessage): Promise<Backend> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const threadId = threadIdFromPath(url.pathname);

  // New thread: must land on a CP that has a free local VM.
  if (req.method === "POST" && url.pathname === "/threads") {
    return pickBackendForAssign();
  }

  if (threadId && req.method === "POST") {
    // Follow-up: sticky owner if assigned; else on-demand assign on a CP with capacity.
    const owner = await ownerForThread(threadId);
    if (owner && byId.has(owner)) return byId.get(owner)!;
    return pickBackendForAssign();
  }

  if (threadId) {
    // GET /threads/:id — any CP (shared DB); prefer owner if known
    const owner = await ownerForThread(threadId);
    return backendForOwner(owner);
  }

  // GET /threads list, etc.
  return nextBackend();
}

function proxyHttp(req: IncomingMessage, res: ServerResponse, backend: Backend): void {
  const headers = { ...req.headers, host: `${backend.host}:${backend.port}` };
  const preq = http.request(
    {
      hostname: backend.host,
      port: backend.port,
      path: req.url,
      method: req.method,
      headers,
    },
    (pres) => {
      res.writeHead(pres.statusCode ?? 502, pres.headers);
      pres.pipe(res);
    }
  );
  preq.on("error", (err) => {
    log(`HTTP → cp-${backend.id} error:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: `proxy: backend cp-${backend.id} unavailable` }));
  });
  req.pipe(preq);
}

/**
 * `ws` rejects reserved/synthetic close codes (1005 No Status, 1006 Abnormal, …).
 * Forwarding them verbatim crashes the process.
 */
function safeClose(
  socket: WebSocket,
  code?: number,
  reason?: Buffer | string,
): void {
  if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) {
    return;
  }
  try {
    if (
      typeof code === "number" &&
      Number.isInteger(code) &&
      code >= 1000 &&
      code <= 4999 &&
      code !== 1004 &&
      code !== 1005 &&
      code !== 1006 &&
      code !== 1015 &&
      !(code > 1014 && code < 3000)
    ) {
      socket.close(code, reason);
    } else {
      socket.close();
    }
  } catch (err) {
    log("safeClose ignored:", err instanceof Error ? err.message : err);
  }
}

function pipeWs(client: WebSocket, upstream: WebSocket, label: string): void {
  const forward = (from: WebSocket, to: WebSocket, dir: string) => {
    from.on("message", (data, isBinary) => {
      if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
    });
    from.on("close", (code, reason) => {
      log(`${label} ${dir} close code=${code}`);
      safeClose(to, code, reason);
    });
    from.on("error", (err) => {
      log(`${label} ${dir} error:`, err.message);
      safeClose(to);
    });
  };
  forward(client, upstream, "client→up");
  forward(upstream, client, "up→client");
}

function connectUpstream(
  backend: Backend,
  req: IncomingMessage
): WebSocket {
  const url = new URL(req.url ?? "/", `http://${backend.host}:${backend.port}`);
  url.protocol = "ws:";
  url.hostname = backend.host;
  url.port = String(backend.port);
  const protocols = req.headers["sec-websocket-protocol"];
  const opts =
    typeof protocols === "string"
      ? { headers: { "sec-websocket-protocol": protocols } }
      : undefined;
  return new WebSocket(url.toString(), opts);
}

async function handleVmUpgrade(
  client: WebSocket,
  req: IncomingMessage
): Promise<void> {
  // Buffer until register so we can route by externalId → owner_cp_id.
  const buffered: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];
  let routed = false;

  const onMsg = async (data: WebSocket.RawData, isBinary: boolean) => {
    if (routed) return;
    buffered.push({ data, isBinary });
    if (isBinary) return;
    let msg: { type?: string; externalId?: string };
    try {
      msg = JSON.parse(String(data)) as { type?: string; externalId?: string };
    } catch {
      return;
    }
    if (msg.type !== "register" || !msg.externalId) return;

    routed = true;
    client.off("message", onMsg);

    const owner = await ownerForVm(msg.externalId);
    const backend = backendForOwner(owner);
    log(
      `VM register ${msg.externalId} → cp-${backend.id} (${backend.host}:${backend.port})` +
        (owner ? ` owner=${owner}` : " (no owner, RR/pick)")
    );

    const upstream = connectUpstream(backend, req);
    upstream.on("open", () => {
      for (const b of buffered) {
        upstream.send(b.data, { binary: b.isBinary });
      }
      pipeWs(client, upstream, `vm/${msg.externalId}`);
    });
    upstream.on("error", (err) => {
      log(`VM upstream error:`, err.message);
      client.close(1011, "upstream error");
    });
  };

  client.on("message", (data, isBinary) => {
    void onMsg(data, isBinary);
  });
  client.on("close", () => {
    routed = true;
  });
}

async function handleBrowserUpgrade(
  client: WebSocket,
  req: IncomingMessage
): Promise<void> {
  // Do NOT round-robin until we know the thread — otherwise the UI connects on
  // page load, gets pinned to the wrong CP, and misses agent_loop_* events
  // (hangs on "agent working").
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const qThread = url.searchParams.get("threadId");

  let upstream: WebSocket | null = null;
  let upstreamOwnerKey: string | null = null; // backend id we are attached to
  let attachChain: Promise<void> = Promise.resolve();

  const attachUpstream = async (
    threadId: string | null,
    buffered: Array<{ data: WebSocket.RawData; isBinary: boolean }>
  ): Promise<void> => {
    const owner = threadId ? await ownerForThread(threadId) : null;
    // Prefer known owner; if none yet, stay on current upstream when possible
    // so a pre-assign subscribe does not bounce across CPs.
    let backend: Backend;
    if (owner && byId.has(owner)) {
      backend = byId.get(owner)!;
    } else if (upstream && upstream.readyState === WebSocket.OPEN && upstreamOwnerKey) {
      backend = byId.get(upstreamOwnerKey) ?? nextBackend();
    } else {
      backend = nextBackend();
    }
    const ownerKey = backend.id;

    const flushAndAck = () => {
      for (const b of buffered) {
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(b.data, { binary: b.isBinary });
        }
      }
      // Local ack so the browser unblocks even if the CP `subscribed` frame is
      // lost in a reattach race. Harmless duplicate if CP also acks.
      if (threadId && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "subscribed", threadId }));
      }
    };

    // Already on the right backend — just flush any buffered frames.
    if (upstream && upstream.readyState === WebSocket.OPEN && upstreamOwnerKey === ownerKey) {
      flushAndAck();
      log(
        `browser WS keep cp-${backend.id}` +
          (threadId ? ` thread=${threadId}` : "") +
          (owner ? ` owner=${owner}` : " (sticky-up)")
      );
      return;
    }

    // Tear down previous upstream if switching owners (thread change / reassign).
    if (upstream) {
      try {
        upstream.removeAllListeners();
        upstream.close();
      } catch {
        /* ignore */
      }
      upstream = null;
    }

    log(
      `browser WS → cp-${backend.id}` +
        (threadId ? ` thread=${threadId}` : "") +
        (owner ? ` owner=${owner}` : " (RR)")
    );

    const ws = connectUpstream(backend, req);
    upstream = ws;
    upstreamOwnerKey = ownerKey;

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`upstream open timeout cp-${backend.id}`)),
        5_000
      );
      ws.once("open", () => {
        clearTimeout(t);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });

    // Attach handlers BEFORE flushing subscribe — otherwise a fast `subscribed`
    // / agent event can arrive and be dropped.
    ws.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    ws.on("close", (code, reason) => {
      log(`browser up→client close code=${code}`);
      if (upstream === ws) upstream = null;
      // Do not close the browser client — allow re-subscribe to another CP.
    });
    ws.on("error", (err) => {
      log(`browser upstream error:`, err.message);
    });

    flushAndAck();
  };

  const enqueueAttach = (
    threadId: string | null,
    buffered: Array<{ data: WebSocket.RawData; isBinary: boolean }>
  ) => {
    attachChain = attachChain
      .catch(() => undefined)
      .then(() => attachUpstream(threadId, buffered))
      .catch((err) => {
        log(`browser attach failed:`, err);
        if (client.readyState === WebSocket.OPEN) {
          client.send(
            JSON.stringify({
              type: "agent_loop_error",
              threadId: threadId ?? "",
              error: `proxy attach failed: ${err instanceof Error ? err.message : String(err)}`,
            })
          );
        }
      });
    return attachChain;
  };

  client.on("message", (data, isBinary) => {
    void (async () => {
      // Parse subscribe/unsubscribe to (re)route before forwarding.
      if (!isBinary) {
        try {
          const msg = JSON.parse(String(data)) as {
            type?: string;
            threadId?: string;
          };
          if (msg.type === "subscribe" && msg.threadId) {
            await enqueueAttach(msg.threadId, [{ data, isBinary }]);
            return; // forwarded + local subscribed ack in attach
          }
          if (msg.type === "unsubscribe") {
            // Stay on current upstream; just forward unsubscribe.
          }
        } catch {
          /* forward as-is */
        }
      }

      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }

      // Not routed yet and not a subscribe — ignore (wait for subscribe).
      log("browser WS dropped frame (waiting for subscribe)");
    })();
  });

  client.on("close", (code, reason) => {
    if (upstream) safeClose(upstream, code, reason);
  });
  client.on("error", () => {
    if (upstream) safeClose(upstream);
  });

  if (qThread) {
    try {
      await enqueueAttach(qThread, []);
    } catch (err) {
      log(`browser WS initial attach failed:`, err);
      client.close(1011, "upstream error");
    }
  }
}

function main(): void {
  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (req.url === "/health" || req.url?.startsWith("/health?")) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              role: "cp-proxy",
              backends: backends.map((b) => ({
                id: b.id,
                url: `http://${b.host}:${b.port}`,
              })),
              databasePath: DB_PATH,
            })
          );
          return;
        }
        if (
          req.url === "/debug" ||
          req.url === "/mappings" ||
          req.url?.startsWith("/debug?") ||
          req.url?.startsWith("/mappings?")
        ) {
          const snap = await buildMappingsSnapshot();
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(snap, null, 2));
          return;
        }
        const backend = await pickHttpBackend(req);
        log(`HTTP ${req.method} ${req.url} → cp-${backend.id}`);
        proxyHttp(req, res, backend);
      } catch (err) {
        log("HTTP routing error", err);
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "proxy routing failed" }));
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      if (url.pathname === "/ws/vm") {
        void handleVmUpgrade(ws, req);
        return;
      }
      if (url.pathname === "/ws/browser") {
        void handleBrowserUpgrade(ws, req);
        return;
      }
      ws.close();
    });
  });

  server.listen(PROXY_PORT, () => {
    log(`listening on :${PROXY_PORT}`);
    log(`DATABASE_PATH=${DB_PATH}`);
    for (const b of backends) {
      log(`backend cp-${b.id} → http://${b.host}:${b.port}`);
    }
    log("routing: thread→assignment→vm→owner_cp_id (not consistent hash)");
  });
}

main();
