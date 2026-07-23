import { spawn } from "node:child_process";
import type { ShellArgs, ShellToolResult } from "@poc/shared";
import { resolveWorkspacePath } from "./paths.js";

export async function shell(
  workspaceDir: string,
  args: ShellArgs,
): Promise<ShellToolResult | { ok: false; error: string }> {
  if (!args.command || typeof args.command !== "string") {
    return { ok: false, error: "command is required" };
  }

  const cwdRel = args.cwd ?? ".";
  const resolved = await resolveWorkspacePath(workspaceDir, cwdRel);
  if (!resolved.ok) return resolved;

  return await new Promise((resolve) => {
    const child = spawn(args.command, {
      cwd: resolved.absolutePath,
      shell: true,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      resolve({
        stdout,
        stderr: stderr || err.message,
        exit_code: 1,
      });
    });

    child.on("close", (code) => {
      resolve({
        stdout,
        stderr,
        exit_code: code ?? 1,
      });
    });
  });
}
