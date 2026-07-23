import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveWorkspacePath } from "./tools/paths.js";

export type DebugServerOptions = {
  port: number;
  workspaceDir: string;
};

type DirEntry = {
  name: string;
  type: "file" | "directory" | "other";
  size?: number;
};

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
 * Tiny debug HTTP server: GET /debug/ls?path=.
 * Logs directory listing to the VM console and returns JSON.
 */
export function startDebugServer(options: DebugServerOptions): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && url.pathname === "/debug/ls") {
      const dirPath = url.searchParams.get("path") ?? ".";
      const result = await listDirectory(options.workspaceDir, dirPath);

      if (!result.ok) {
        console.log(`[vm:debug] ls failed path=${dirPath}: ${result.error}`);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: result.error }));
        return;
      }

      console.log(`[vm:debug] listing ${result.absolutePath}`);
      for (const e of result.entries) {
        const suffix = e.type === "directory" ? "/" : e.size != null ? ` (${e.size}b)` : "";
        console.log(`[vm:debug]   ${e.type === "directory" ? "dir " : "file"} ${e.name}${suffix}`);
      }
      console.log(`[vm:debug] ${result.entries.length} entries`);

      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          {
            path: dirPath,
            absolutePath: result.absolutePath,
            entries: result.entries,
          },
          null,
          2,
        ),
      );
      return;
    }

    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found; try GET /debug/ls?path=." }));
  });

  server.listen(options.port, () => {
    console.log(`[vm] debug HTTP on :${options.port}  GET /debug/ls?path=.`);
  });

  return server;
}
