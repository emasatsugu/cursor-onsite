import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "./tools/paths.js";
import type { ControlPlaneClient } from "./cpClient.js";

export type DebugServerOptions = {
  port: number;
  workspaceDir: string;
  client: ControlPlaneClient;
};

type DirEntry = {
  name: string;
  type: "file" | "directory" | "other";
  size?: number;
};

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 2));
}

async function listDirectory(
  workspaceDir: string,
  userPath: string,
): Promise<{ ok: true; absolutePath: string; entries: DirEntry[] } | { ok: false; error: string }> {
  const resolved = await resolveWorkspacePath(workspaceDir, userPath);
  if (!resolved.ok) return resolved;

  let stat;
  try {
    stat = await fs.stat(resolved.absolutePath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }

  if (!stat.isDirectory()) {
    return { ok: false, error: `not a directory: ${userPath}` };
  }

  const names = await fs.readdir(resolved.absolutePath);
  const entries: DirEntry[] = [];
  for (const name of names.sort()) {
    const full = path.join(resolved.absolutePath, name);
    try {
      const s = await fs.stat(full);
      if (s.isDirectory()) {
        entries.push({ name, type: "directory" });
      } else if (s.isFile()) {
        entries.push({ name, type: "file", size: s.size });
      } else {
        entries.push({ name, type: "other" });
      }
    } catch {
      entries.push({ name, type: "other" });
    }
  }

  return { ok: true, absolutePath: resolved.absolutePath, entries };
}

/**
 * Tiny debug HTTP server:
 * - GET  /debug/ls?path=.
 * - GET  /debug/status
 * - POST /debug/unhealthy           — pause heartbeats (CP times out ~30s)
 * - POST /debug/unhealthy?disconnect=1 — pause + close WS immediately
 * - POST /debug/healthy             — resume heartbeats / reconnect
 */
export function startDebugServer(options: DebugServerOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/debug/ls") {
      const dirPath = url.searchParams.get("path") ?? ".";
      const result = await listDirectory(options.workspaceDir, dirPath);

      if (!result.ok) {
        console.log(`[vm:debug] ls failed path=${dirPath}: ${result.error}`);
        json(res, 400, { error: result.error });
        return;
      }

      console.log(`[vm:debug] listing ${result.absolutePath}`);
      for (const e of result.entries) {
        const suffix = e.type === "directory" ? "/" : e.size != null ? ` (${e.size}b)` : "";
        console.log(`[vm:debug]   ${e.type === "directory" ? "dir " : "file"} ${e.name}${suffix}`);
      }
      console.log(`[vm:debug] ${result.entries.length} entries`);

      json(res, 200, {
        path: dirPath,
        absolutePath: result.absolutePath,
        entries: result.entries,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/debug/status") {
      json(res, 200, options.client.getDebugStatus());
      return;
    }

    if (
      (req.method === "POST" || req.method === "GET") &&
      url.pathname === "/debug/unhealthy"
    ) {
      const disconnect =
        url.searchParams.get("disconnect") === "1" ||
        url.searchParams.get("disconnect") === "true";
      const status = options.client.simulateUnhealthy({ disconnect });
      console.log(`[vm:debug] /debug/unhealthy disconnect=${disconnect}`, status);
      json(res, 200, {
        ok: true,
        action: "unhealthy",
        disconnect,
        status,
        note: disconnect
          ? "WS closed immediately; will not reconnect until /debug/healthy"
          : "Heartbeats paused; CP should evict after VM_HEARTBEAT_TIMEOUT_MS (~30s)",
      });
      return;
    }

    if (
      (req.method === "POST" || req.method === "GET") &&
      url.pathname === "/debug/healthy"
    ) {
      const status = options.client.simulateHealthy();
      console.log(`[vm:debug] /debug/healthy`, status);
      json(res, 200, {
        ok: true,
        action: "healthy",
        status,
        note: "Heartbeats + reconnect enabled; connecting if needed",
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, ...options.client.getDebugStatus() });
      return;
    }

    json(res, 404, {
      error: "not found",
      endpoints: [
        "GET /debug/ls?path=.",
        "GET /debug/status",
        "POST /debug/unhealthy",
        "POST /debug/unhealthy?disconnect=1",
        "POST /debug/healthy",
        "GET /health",
      ],
    });
  });

  server.listen(options.port, () => {
    console.log(
      `[vm] debug HTTP on :${options.port}  /debug/ls /debug/status /debug/unhealthy /debug/healthy`,
    );
  });

  return server;
}
