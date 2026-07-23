import fs from "node:fs/promises";
import type { ReadFileArgs, ReadFileToolResult, ToolResultPayload } from "@poc/shared";
import { resolveWorkspacePath } from "./paths.js";

export async function readFile(
  workspaceDir: string,
  args: ReadFileArgs,
): Promise<ReadFileToolResult | { ok: false; error: string }> {
  const resolved = await resolveWorkspacePath(workspaceDir, args.path);
  if (!resolved.ok) return resolved;

  let content: string;
  try {
    content = await fs.readFile(resolved.absolutePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to read file: ${message}` };
  }

  if (args.start_line != null || args.end_line != null) {
    const lines = content.split("\n");
    const start = Math.max(1, args.start_line ?? 1);
    const end = Math.min(lines.length, args.end_line ?? lines.length);
    if (start > end) {
      return { ok: false, error: `invalid line range: ${start}-${end}` };
    }
    content = lines.slice(start - 1, end).join("\n");
  }

  return { content };
}

export function isReadFileError(
  result: ReadFileToolResult | ToolResultPayload,
): result is { ok: false; error: string } {
  return "ok" in result && result.ok === false;
}
