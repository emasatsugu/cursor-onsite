import fs from "node:fs/promises";
import type { WriteFileArgs, WriteFileToolResult } from "@poc/shared";
import { ensureParentDir, resolveWorkspacePath } from "./paths.js";

export async function writeFile(
  workspaceDir: string,
  args: WriteFileArgs,
): Promise<WriteFileToolResult | { ok: false; error: string }> {
  if (typeof args.content !== "string") {
    return { ok: false, error: "content must be a string" };
  }

  const resolved = await resolveWorkspacePath(workspaceDir, args.path);
  if (!resolved.ok) return resolved;

  try {
    await ensureParentDir(resolved.absolutePath);
    await fs.writeFile(resolved.absolutePath, args.content, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to write file: ${message}` };
  }

  return { ok: true };
}
