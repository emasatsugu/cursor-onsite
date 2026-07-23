/**
 * Local stand-in for a prod load balancer in front of multiple control-plane
 * instances.
 *
 * Routing (not consistent hashing):
 *   thread → active assignment → vm → owner_cp_id → backend
 *   VM WS  → peek `register.externalId` → owner_cp_id (or pick a backend + CP claims on register)
 *   no owner / new thread → prefer CPs with free healthy VMs (among live backends)
 *
 * Dead-CP handling:
 *   - periodic /health probes + optional /debug/unhealthy override
 *   - skip dead owners; scrub owner_cp_id + complete stickies; retry once on another live CP
 *   - evacuate proxied VM (and browser) sockets so VMs reconnect onto a live CP
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
const HEALTH_INTERVAL_MS = Number(process.env.CP_HEALTH_INTERVAL_MS ?? 3_000);
const HEALTH_TIMEOUT_MS = Number(process.env.CP_HEALTH_TIMEOUT_MS ?? 1_500);

type Backend = { id: string; host: string; port: number };

type BackendHealth = {
  /** Last successful probe (ignored while forceUnhealthy). */
  probeOk: boolean;
  /** Manual override via /debug/unhealthy — like VM simulateUnhealthy. */
  forceUnhealthy: boolean;
  lastCheckAt: number | null;
  lastError: string | null;
};

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
const health = new Map<string, BackendHealth>(
  backends.map((b) => [
    b.id,
    {
      probeOk: true, // optimistic until first probe fails
      forceUnhealthy: false,
      lastCheckAt: null,
      lastError: null,
    },
  ])
);
let rr = 0;

/** Live VM tunnels through this proxy (so we can kick them off a dead CP). */
type VmSession = {
  backendId: string;
  externalId: string;
  client: WebSocket;
  upstream: WebSocket;
};
const vmSessions = new Set<VmSession>();

/** Browser tunnels — closed on evacuate so the UI re-subscribes on a live CP. */
type BrowserSession = {
  backendId: string;
  client: WebSocket;
  upstream: WebSocket | null;
};
const browserSessions = new Set<BrowserSession>();

function log(...args: unknown[]): void {
  console.log("[cp-proxy]", ...args);
}

function isLive(id: string): boolean {
  const h = health.get(id);
  if (!h) return false;
  if (h.forceUnhealthy) return false;
  return h.probeOk;
}

function liveBackends(): Backend[] {
  return backends.filter((b) => isLive(b.id));
}

function nextLiveBackend(excludeId?: string): Backend | null {
  const live = liveBackends().filter((b) => b.id !== excludeId);
  if (live.length === 0) return null;
  const b = live[rr % live.length]!;
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

function dbRun(
  db: sqlite3.Database,
  sql: string,
  params: unknown[] = []
): Promise<number> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes ?? 0);
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

/**
 * Clear ownership for a dead CP so routing stops black-holing sticky traffic.
 * Completes active assignments on VMs owned by that CP.
 */
async function scrubDeadOwner(cpId: string): Promise<{
  assignmentsCompleted: number;
  vmsCleared: number;
}> {
  const db = openDb();
  try {
    const assignmentsCompleted = await dbRun(
      db,
      `UPDATE assignments
       SET status = 'completed', updated_at = CURRENT_TIMESTAMP
       WHERE status = 'active'
         AND vm_id IN (
           SELECT id FROM virtual_machines WHERE owner_cp_id = ?
         )`,
      [cpId]
    );
    const vmsCleared = await dbRun(
      db,
      `UPDATE virtual_machines
       SET owner_cp_id = NULL,
           status = 'unhealthy',
           updated_at = CURRENT_TIMESTAMP
       WHERE owner_cp_id = ?`,
      [cpId]
    );
    log(
      `scrub dead owner cp-${cpId}: assignmentsCompleted=${assignmentsCompleted} vmsCleared=${vmsCleared}`
    );
    return { assignmentsCompleted, vmsCleared };
  } finally {
    db.close();
  }
}

/**
 * Drop proxied sockets attached to a dead CP.
 * Closing the VM *client* side makes the VM reconnect through the proxy and
 * register on a live CP — otherwise capacity stays trapped on the unhealthy
 * process and follow-ups 503 with "no free VM".
 */
function evacuateBackend(cpId: string): {
  vmsEvacuated: number;
  browsersEvacuated: number;
} {
  let vmsEvacuated = 0;
  let browsersEvacuated = 0;

  for (const session of [...vmSessions]) {
    if (session.backendId !== cpId) continue;
    log(`evacuate VM ${session.externalId} off cp-${cpId}`);
    vmSessions.delete(session);
    try {
      session.upstream.removeAllListeners();
    } catch {
      /* ignore */
    }
    safeClose(session.upstream);
    safeClose(session.client);
    vmsEvacuated += 1;
  }

  for (const session of [...browserSessions]) {
    if (session.backendId !== cpId) continue;
    log(`evacuate browser off cp-${cpId}`);
    browserSessions.delete(session);
    if (session.upstream) {
      try {
        session.upstream.removeAllListeners();
      } catch {
        /* ignore */
      }
      safeClose(session.upstream);
    }
    safeClose(session.client);
    browsersEvacuated += 1;
  }

  return { vmsEvacuated, browsersEvacuated };
}

async function declareBackendDead(
  cpId: string,
  reason: string
): Promise<{
  assignmentsCompleted: number;
  vmsCleared: number;
  vmsEvacuated: number;
  browsersEvacuated: number;
}> {
  const h = health.get(cpId);
  if (h) {
    h.probeOk = false;
    h.lastError = reason;
    h.lastCheckAt = Date.now();
  }
  log(`backend cp-${cpId} dead: ${reason}`);
  const scrub = await scrubDeadOwner(cpId);
  const evacuated = evacuateBackend(cpId);
  return { ...scrub, ...evacuated };
}

async function markUnreachable(
  cpId: string,
  reason: string,
  opts?: { scrub?: boolean }
): Promise<void> {
  const h = health.get(cpId);
  if (!h) return;
  const wasLive = isLive(cpId);
  if (wasLive || opts?.scrub) {
    await declareBackendDead(cpId, reason);
  } else {
    h.probeOk = false;
    h.lastError = reason;
    h.lastCheckAt = Date.now();
  }
}

function probeBackend(backend: Backend): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: backend.host,
        port: backend.port,
        path: "/health",
        method: "GET",
        timeout: HEALTH_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 300);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
    req.end();
  });
}

async function runHealthSweep(): Promise<void> {
  for (const backend of backends) {
    const h = health.get(backend.id)!;
    if (h.forceUnhealthy) {
      h.lastCheckAt = Date.now();
      continue;
    }
    const ok = await probeBackend(backend);
    const wasOk = h.probeOk;
    h.probeOk = ok;
    h.lastCheckAt = Date.now();
    h.lastError = ok ? null : "health probe failed";
    if (wasOk && !ok) {
      log(`health probe FAILED cp-${backend.id}`);
      await declareBackendDead(backend.id, "health probe failed");
    } else if (!wasOk && ok) {
      log(`health probe OK cp-${backend.id} (recovered)`);
    }
  }
}

function startHealthMonitor(): void {
  void runHealthSweep();
  setInterval(() => {
    void runHealthSweep();
  }, HEALTH_INTERVAL_MS);
  log(
    `health monitor started intervalMs=${HEALTH_INTERVAL_MS} timeoutMs=${HEALTH_TIMEOUT_MS}`
  );
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

function backendHealthSnapshot() {
  return backends.map((b) => {
    const h = health.get(b.id)!;
    return {
      id: b.id,
      url: `http://${b.host}:${b.port}`,
      live: isLive(b.id),
      probeOk: h.probeOk,
      forceUnhealthy: h.forceUnhealthy,
      lastCheckAt: h.lastCheckAt
        ? new Date(h.lastCheckAt).toISOString()
        : null,
      lastError: h.lastError,
    };
  });
}

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
      backends: backendHealthSnapshot(),
      /** VM → which CP owns the live socket (null = disconnected / unknown). */
      vmToOwner: vms.map((vm) => {
        const backend = vm.owner_cp_id ? byId.get(vm.owner_cp_id) : undefined;
        const ownerLive = vm.owner_cp_id ? isLive(vm.owner_cp_id) : false;
        return {
          externalId: vm.external_id,
          status: vm.status,
          ownerCpId: vm.owner_cp_id,
          ownerLive,
          backendUrl: backend
            ? `http://${backend.host}:${backend.port}`
            : null,
          updatedAt: vm.updated_at,
        };
      }),
      /** Thread → VM → owner CP (active stickies only). */
      threadToOwner: assignments.map((a) => {
        const backend = a.owner_cp_id ? byId.get(a.owner_cp_id) : undefined;
        const ownerLive = a.owner_cp_id ? isLive(a.owner_cp_id) : false;
        let wouldRoute: string;
        if (a.owner_cp_id && byId.has(a.owner_cp_id) && ownerLive) {
          wouldRoute = `cp-${a.owner_cp_id}`;
        } else if (a.owner_cp_id && !ownerLive) {
          wouldRoute = `dead owner cp-${a.owner_cp_id} → reassign among live`;
        } else {
          wouldRoute = "pick live CP with free VM (or RR)";
        }
        return {
          threadId: a.thread_id,
          vmExternalId: a.vm_external_id,
          vmStatus: a.vm_status,
          ownerCpId: a.owner_cp_id,
          ownerLive,
          backendUrl: backend
            ? `http://${backend.host}:${backend.port}`
            : null,
          wouldRoute,
          updatedAt: a.updated_at,
        };
      }),
      note: "Routing is DB lookup thread→assignment→vm→owner_cp_id; dead owners are skipped + scrubbed.",
    };
  } finally {
    db.close();
  }
}

/**
 * Prefer a live sticky owner; otherwise any live backend (RR).
 */
function backendForOwner(ownerCpId: string | null | undefined): Backend | null {
  if (ownerCpId && byId.has(ownerCpId) && isLive(ownerCpId)) {
    return byId.get(ownerCpId)!;
  }
  return nextLiveBackend();
}

/**
 * CPs that currently own at least one healthy VM with no active assignment,
 * filtered to backends the proxy considers live.
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
      if (b && isLive(b.id)) out.push(b);
    }
    return out;
  } finally {
    db.close();
  }
}

async function pickBackendForAssign(excludeId?: string): Promise<Backend | null> {
  const free = (await backendsWithFreeVm()).filter((b) => b.id !== excludeId);
  if (free.length > 0) {
    const b = free[rr % free.length]!;
    rr += 1;
    log(
      `assign-route → cp-${b.id} (free live owners: ${free.map((x) => x.id).join(",")})`
    );
    return b;
  }
  log("no live CP with free VM in DB — falling back to live RR");
  return nextLiveBackend(excludeId);
}

function threadIdFromPath(urlPath: string): string | null {
  const m = urlPath.match(/^\/threads\/([^/]+)/);
  if (!m) return null;
  if (m[1] === undefined) return null;
  return m[1];
}

async function pickHttpBackend(req: IncomingMessage): Promise<Backend | null> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const threadId = threadIdFromPath(url.pathname);

  if (req.method === "POST" && url.pathname === "/threads") {
    return pickBackendForAssign();
  }

  if (threadId && req.method === "POST") {
    const owner = await ownerForThread(threadId);
    if (owner && byId.has(owner) && isLive(owner)) {
      return byId.get(owner)!;
    }
    if (owner && !isLive(owner)) {
      log(
        `follow-up thread=${threadId} sticky owner cp-${owner} dead — reassign-route`
      );
    }
    return pickBackendForAssign();
  }

  if (threadId) {
    const owner = await ownerForThread(threadId);
    return backendForOwner(owner);
  }

  return nextLiveBackend();
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => {
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Proxy one HTTP hop. Resolves `ok` after response headers are forwarded,
 * or `error` if the backend connection fails before that.
 */
function proxyHttpOnce(
  req: IncomingMessage,
  res: ServerResponse,
  backend: Backend,
  body: Buffer
): Promise<"ok" | "error"> {
  return new Promise((resolve) => {
    const headers = {
      ...req.headers,
      host: `${backend.host}:${backend.port}`,
      "content-length": String(body.length),
    };
    delete headers["transfer-encoding"];

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
        resolve("ok");
      }
    );
    preq.on("error", (err) => {
      log(`HTTP → cp-${backend.id} error:`, err.message);
      resolve("error");
    });
    preq.end(body);
  });
}

async function proxyHttpWithRetry(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const body = await readBody(req);
  const first = await pickHttpBackend(req);
  if (!first) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "proxy: no live control-plane backends" }));
    return;
  }

  log(`HTTP ${req.method} ${req.url} → cp-${first.id}`);
  const firstResult = await proxyHttpOnce(req, res, first, body);
  if (firstResult === "ok") return;

  await markUnreachable(first.id, "http connect failed", { scrub: true });
  const second =
    (await pickBackendForAssign(first.id)) ?? nextLiveBackend(first.id);
  if (!second || second.id === first.id) {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(
      JSON.stringify({
        error: `proxy: backend cp-${first.id} unavailable (no live alternate)`,
      })
    );
    return;
  }

  log(`HTTP retry ${req.method} ${req.url} → cp-${second.id}`);
  const secondResult = await proxyHttpOnce(req, res, second, body);
  if (secondResult === "ok") return;

  await markUnreachable(second.id, "http connect failed on retry", {
    scrub: true,
  });
  if (!res.headersSent) {
    res.writeHead(502, { "content-type": "application/json" });
  }
  res.end(
    JSON.stringify({
      error: `proxy: backends cp-${first.id} and cp-${second.id} unavailable`,
    })
  );
}

/**
 * `ws` rejects reserved/synthetic close codes (1005 No Status, 1006 Abnormal, …).
 * Forwarding them verbatim crashes the process.
 */
function safeClose(
  socket: WebSocket,
  code?: number,
  reason?: Buffer | string
): void {
  if (
    socket.readyState !== WebSocket.OPEN &&
    socket.readyState !== WebSocket.CONNECTING
  ) {
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

function connectUpstream(backend: Backend, req: IncomingMessage): WebSocket {
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

function openUpstream(
  backend: Backend,
  req: IncomingMessage,
  timeoutMs = 5_000
): Promise<WebSocket> {
  const ws = connectUpstream(backend, req);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error(`upstream open timeout cp-${backend.id}`));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(t);
      resolve(ws);
    });
    ws.once("error", (err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

async function handleVmUpgrade(
  client: WebSocket,
  req: IncomingMessage
): Promise<void> {
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
    let backend = backendForOwner(owner);
    if (!backend) {
      log(`VM register ${msg.externalId} — no live backends`);
      client.close(1011, "no live backends");
      return;
    }
    if (owner && !isLive(owner)) {
      log(
        `VM register ${msg.externalId} stale owner cp-${owner} dead → cp-${backend.id}`
      );
    } else {
      log(
        `VM register ${msg.externalId} → cp-${backend.id} (${backend.host}:${backend.port})` +
          (owner ? ` owner=${owner}` : " (no owner, pick)")
      );
    }

    const tryAttach = async (b: Backend): Promise<boolean> => {
      try {
        const upstream = await openUpstream(b, req);
        for (const frame of buffered) {
          upstream.send(frame.data, { binary: frame.isBinary });
        }
        const session: VmSession = {
          backendId: b.id,
          externalId: msg.externalId!,
          client,
          upstream,
        };
        vmSessions.add(session);
        const forget = () => {
          vmSessions.delete(session);
        };
        client.once("close", forget);
        upstream.once("close", forget);
        pipeWs(client, upstream, `vm/${msg.externalId}`);
        return true;
      } catch (err) {
        log(
          `VM upstream cp-${b.id} failed:`,
          err instanceof Error ? err.message : err
        );
        await markUnreachable(
          b.id,
          err instanceof Error ? err.message : String(err),
          { scrub: true }
        );
        return false;
      }
    };

    if (await tryAttach(backend)) return;

    const alt = nextLiveBackend(backend.id);
    if (!alt) {
      client.close(1011, "upstream error");
      return;
    }
    log(`VM register retry ${msg.externalId} → cp-${alt.id}`);
    if (!(await tryAttach(alt))) {
      client.close(1011, "upstream error");
    }
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
  // page load, gets pinned to the wrong CP, and misses agent_loop_* events.
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`
  );
  const qThread = url.searchParams.get("threadId");

  let upstream: WebSocket | null = null;
  let upstreamOwnerKey: string | null = null;
  let attachChain: Promise<void> = Promise.resolve();
  const browserSession: BrowserSession = {
    backendId: "",
    client,
    upstream: null,
  };
  browserSessions.add(browserSession);
  client.once("close", () => {
    browserSessions.delete(browserSession);
  });

  const attachUpstream = async (
    threadId: string | null,
    buffered: Array<{ data: WebSocket.RawData; isBinary: boolean }>
  ): Promise<void> => {
    const owner = threadId ? await ownerForThread(threadId) : null;
    let backend: Backend | null;
    if (owner && byId.has(owner) && isLive(owner)) {
      backend = byId.get(owner)!;
    } else if (
      upstream &&
      upstream.readyState === WebSocket.OPEN &&
      upstreamOwnerKey &&
      isLive(upstreamOwnerKey)
    ) {
      backend = byId.get(upstreamOwnerKey) ?? null;
    } else {
      backend = nextLiveBackend();
    }
    if (!backend) {
      throw new Error("no live control-plane backends");
    }
    if (owner && !isLive(owner)) {
      log(
        `browser WS thread=${threadId} sticky owner cp-${owner} dead → cp-${backend.id}`
      );
    }

    const flushAndAck = () => {
      for (const b of buffered) {
        if (upstream && upstream.readyState === WebSocket.OPEN) {
          upstream.send(b.data, { binary: b.isBinary });
        }
      }
      if (threadId && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({ type: "subscribed", threadId }));
      }
    };

    if (
      upstream &&
      upstream.readyState === WebSocket.OPEN &&
      upstreamOwnerKey === backend.id
    ) {
      flushAndAck();
      log(
        `browser WS keep cp-${backend.id}` +
          (threadId ? ` thread=${threadId}` : "") +
          (owner && isLive(owner) ? ` owner=${owner}` : " (sticky-up)")
      );
      return;
    }

    if (upstream) {
      try {
        upstream.removeAllListeners();
        upstream.close();
      } catch {
        /* ignore */
      }
      upstream = null;
    }

    const tryOpen = async (b: Backend): Promise<WebSocket> => {
      log(
        `browser WS → cp-${b.id}` +
          (threadId ? ` thread=${threadId}` : "") +
          (owner && isLive(owner) ? ` owner=${owner}` : " (pick)")
      );
      return openUpstream(b, req);
    };

    let ws: WebSocket;
    try {
      ws = await tryOpen(backend);
    } catch (err) {
      await markUnreachable(
        backend.id,
        err instanceof Error ? err.message : String(err),
        { scrub: true }
      );
      const alt = nextLiveBackend(backend.id);
      if (!alt) throw err;
      log(`browser WS retry → cp-${alt.id}`);
      ws = await tryOpen(alt);
      backend = alt;
    }

    upstream = ws;
    upstreamOwnerKey = backend.id;
    browserSession.backendId = backend.id;
    browserSession.upstream = ws;

    ws.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data, { binary: isBinary });
      }
    });
    ws.on("close", (code) => {
      log(`browser up→client close code=${code}`);
      if (upstream === ws) {
        upstream = null;
        browserSession.upstream = null;
      }
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
      if (!isBinary) {
        try {
          const msg = JSON.parse(String(data)) as {
            type?: string;
            threadId?: string;
          };
          if (msg.type === "subscribe" && msg.threadId) {
            await enqueueAttach(msg.threadId, [{ data, isBinary }]);
            return;
          }
        } catch {
          /* forward as-is */
        }
      }

      if (upstream && upstream.readyState === WebSocket.OPEN) {
        upstream.send(data, { binary: isBinary });
        return;
      }

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

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

function parseCpId(url: URL): string | null {
  const raw =
    url.searchParams.get("cp") ??
    url.searchParams.get("id") ??
    url.searchParams.get("cpId");
  if (!raw?.trim()) return null;
  return raw.trim();
}

async function handleDebugUnhealthy(url: URL, res: ServerResponse): Promise<void> {
  const cpId = parseCpId(url);
  if (!cpId || !byId.has(cpId)) {
    json(res, 400, {
      error: "cp query param required (e.g. ?cp=1)",
      backends: backends.map((b) => b.id),
    });
    return;
  }
  const h = health.get(cpId)!;
  h.forceUnhealthy = true;
  h.lastCheckAt = Date.now();
  const result = await declareBackendDead(
    cpId,
    "forced unhealthy via /debug/unhealthy"
  );
  log(`/debug/unhealthy cp-${cpId}`, result);
  json(res, 200, {
    ok: true,
    action: "unhealthy",
    cpId,
    ...result,
    backends: backendHealthSnapshot(),
    note:
      "Proxy will not route to this CP until /debug/healthy?cp=N. DB ownership scrubbed; VM/browser sockets evacuated so VMs re-register on a live CP (~2s). Then retry the prompt.",
  });
}

async function handleDebugHealthy(url: URL, res: ServerResponse): Promise<void> {
  const cpId = parseCpId(url);
  if (!cpId || !byId.has(cpId)) {
    json(res, 400, {
      error: "cp query param required (e.g. ?cp=1)",
      backends: backends.map((b) => b.id),
    });
    return;
  }
  const h = health.get(cpId)!;
  h.forceUnhealthy = false;
  h.lastError = null;
  // Re-probe immediately so we don't route before the process is actually up.
  const backend = byId.get(cpId)!;
  const ok = await probeBackend(backend);
  h.probeOk = ok;
  h.lastCheckAt = Date.now();
  h.lastError = ok ? null : "health probe failed after /debug/healthy";
  log(`/debug/healthy cp-${cpId} probeOk=${ok}`);
  json(res, 200, {
    ok: true,
    action: "healthy",
    cpId,
    probeOk: ok,
    live: isLive(cpId),
    backends: backendHealthSnapshot(),
    note: ok
      ? "Force cleared; probe OK — eligible for routing"
      : "Force cleared but probe still failing — not live yet",
  });
}

function main(): void {
  startHealthMonitor();

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(
          req.url ?? "/",
          `http://${req.headers.host ?? "localhost"}`
        );

        if (url.pathname === "/health") {
          const live = liveBackends();
          json(res, live.length > 0 ? 200 : 503, {
            ok: live.length > 0,
            role: "cp-proxy",
            liveBackendIds: live.map((b) => b.id),
            backends: backendHealthSnapshot(),
            databasePath: DB_PATH,
          });
          return;
        }

        if (
          (req.method === "GET" || req.method === "POST") &&
          url.pathname === "/debug/unhealthy"
        ) {
          await handleDebugUnhealthy(url, res);
          return;
        }

        if (
          (req.method === "GET" || req.method === "POST") &&
          url.pathname === "/debug/healthy"
        ) {
          await handleDebugHealthy(url, res);
          return;
        }

        if (url.pathname === "/debug" || url.pathname === "/mappings") {
          const snap = await buildMappingsSnapshot();
          json(res, 200, snap);
          return;
        }

        await proxyHttpWithRetry(req, res);
      } catch (err) {
        log("HTTP routing error", err);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
        }
        res.end(JSON.stringify({ error: "proxy routing failed" }));
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(
      req.url ?? "/",
      `http://${req.headers.host ?? "localhost"}`
    );
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
    log("routing: thread→assignment→vm→owner_cp_id (skip dead owners)");
    log(
      "debug: GET|POST /debug/unhealthy?cp=1  /debug/healthy?cp=1  /mappings"
    );
  });
}

main();
