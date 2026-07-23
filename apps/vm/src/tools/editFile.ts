import fs from "node:fs/promises";
import type { EditFileArgs, EditFileToolResult } from "@poc/shared";
import { resolveWorkspacePath } from "./paths.js";

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let idx = 0;
  while (true) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count += 1;
    idx = found + needle.length;
  }
  return count;
}

export async function editFile(
  workspaceDir: string,
  args: EditFileArgs,
): Promise<EditFileToolResult> {
  if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
    return { ok: false, error: "old_string and new_string must be strings" };
  }

  const resolved = await resolveWorkspacePath(workspaceDir, args.path);
  if (!resolved.ok) return resolved;

  let content: string;
  try {
    content = await fs.readFile(resolved.absolutePath, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to read file: ${message}` };
  }

  const occurrences = countOccurrences(content, args.old_string);
  if (occurrences === 0) {
    return { ok: false, error: "old_string not found in file" };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      error: `old_string is not unique (found ${occurrences} occurrences)`,
    };
  }

  const updated = content.replace(args.old_string, args.new_string);
  try {
    await fs.writeFile(resolved.absolutePath, updated, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `failed to write file: ${message}` };
  }

  return { ok: true };
}
