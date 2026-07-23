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

function backendForOwner(ownerCpId: string | null | undefined): Backend {
  if (ownerCpId && byId.has(ownerCpId)) return byId.get(ownerCpId)!;
  return nextBackend();
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
  if (threadId && req.method !== "POST") {
    // GET /threads/:id — any CP (shared DB); still prefer owner if known
    const owner = await ownerForThread(threadId);
    return backendForOwner(owner);
  }
  if (threadId && req.method === "POST") {
    // Follow-up: must hit current owner when assigned; else RR (on-demand assign)
    const owner = await ownerForThread(threadId);
    return backendForOwner(owner);
  }
  // POST /threads (create) or GET /threads — round-robin
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

function pipeWs(client: WebSocket, upstream: WebSocket, label: string): void {
  const forward = (from: WebSocket, to: WebSocket, dir: string) => {
    from.on("message", (data, isBinary) => {
      if (to.readyState === WebSocket.OPEN) to.send(data, { binary: isBinary });
    });
    from.on("close", (code, reason) => {
      log(`${label} ${dir} close code=${code}`);
      if (to.readyState === WebSocket.OPEN) to.close(code, reason);
    });
    from.on("error", (err) => {
      log(`${label} ${dir} error:`, err.message);
      try {
        to.close();
      } catch {
        /* ignore */
      }
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
  // Prefer ?threadId=; else wait for subscribe message (same as app protocol).
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const qThread = url.searchParams.get("threadId");

  const routeTo = async (threadId: string | null, buffered: typeof buf) => {
    const owner = threadId ? await ownerForThread(threadId) : null;
    const backend = backendForOwner(owner);
    log(
      `browser WS → cp-${backend.id}` +
        (threadId ? ` thread=${threadId}` : "") +
        (owner ? ` owner=${owner}` : " (RR)")
    );
    const upstream = connectUpstream(backend, req);
    upstream.on("open", () => {
      for (const b of buffered) {
        upstream.send(b.data, { binary: b.isBinary });
      }
      pipeWs(client, upstream, "browser");
    });
    upstream.on("error", (err) => {
      log(`browser upstream error:`, err.message);
      client.close(1011, "upstream error");
    });
  };

  const buf: Array<{ data: WebSocket.RawData; isBinary: boolean }> = [];

  if (qThread) {
    await routeTo(qThread, buf);
    return;
  }

  let routed = false;
  const onMsg = (data: WebSocket.RawData, isBinary: boolean) => {
    if (routed) return;
    buf.push({ data, isBinary });
    if (isBinary) return;
    try {
      const msg = JSON.parse(String(data)) as { type?: string; threadId?: string };
      if (msg.type === "subscribe" && msg.threadId) {
        routed = true;
        client.off("message", onMsg);
        void routeTo(msg.threadId, buf);
      }
    } catch {
      /* wait */
    }
  };
  client.on("message", onMsg);

  // If they never subscribe, eventually attach to RR backend so health checks work.
  setTimeout(() => {
    if (routed) return;
    routed = true;
    client.off("message", onMsg);
    void routeTo(null, buf);
  }, 2000);
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
