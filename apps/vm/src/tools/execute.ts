import type {
  EditFileArgs,
  ReadFileArgs,
  ShellArgs,
  ToolArgs,
  ToolName,
  ToolResultPayload,
  WriteFileArgs,
} from "@poc/shared";
import { editFile } from "./editFile.js";
import { readFile } from "./readFile.js";
import { shell } from "./shell.js";
import { writeFile } from "./writeFile.js";

export async function executeTool(
  workspaceDir: string,
  name: ToolName,
  args: ToolArgs,
): Promise<{ ok: boolean; result: ToolResultPayload }> {
  try {
    switch (name) {
      case "read_file": {
        const result = await readFile(workspaceDir, args as ReadFileArgs);
        if ("ok" in result && result.ok === false) {
          return { ok: false, result };
        }
        return { ok: true, result };
      }
      case "write_file": {
        const result = await writeFile(workspaceDir, args as WriteFileArgs);
        if ("ok" in result && result.ok === false) {
          return { ok: false, result };
        }
        return { ok: true, result };
      }
      case "edit_file": {
        const result = await editFile(workspaceDir, args as EditFileArgs);
        return { ok: result.ok, result };
      }
      case "shell": {
        const result = await shell(workspaceDir, args as ShellArgs);
        if ("ok" in result && result.ok === false) {
          return { ok: false, result };
        }
        return { ok: true, result };
      }
      default: {
        const _exhaustive: never = name;
        return {
          ok: false,
          result: { ok: false, error: `unknown tool: ${String(_exhaustive)}` },
        };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, result: { ok: false, error: message } };
  }
}
