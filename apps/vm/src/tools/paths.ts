import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolve a user-supplied path under workspaceDir.
 * Rejects absolute paths and any `..` escape outside the workspace.
 */
export async function resolveWorkspacePath(
  workspaceDir: string,
  userPath: string,
): Promise<{ ok: true; absolutePath: string } | { ok: false; error: string }> {
  if (!userPath || typeof userPath !== "string") {
    return { ok: false, error: "path is required" };
  }

  const root = path.resolve(workspaceDir);
  const candidate = path.resolve(root, userPath);

  const rel = path.relative(root, candidate);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return { ok: false, error: `path escapes workspace: ${userPath}` };
  }

  return { ok: true, absolutePath: candidate };
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}
