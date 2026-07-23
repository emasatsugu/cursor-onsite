import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { remoteUrlWithAuth, WORKSPACE_GIT_REMOTE } from "./gitRemote.js";

/**
 * Workspace persistence: per-thread checkpoint on a shared GitHub remote.
 *
 * Policy (POC):
 * - threadId === branch name (1:1)
 * - restore/persist only — no merge to main in this product
 * - mutating tool calls should call persist after success
 */
export type WorkspaceStore = {
  /** Load thread state into the local workspace (destructive reset). */
  restore(threadId: string): Promise<void>;
  /** Checkpoint local workspace as the thread's latest state. */
  persist(threadId: string, message?: string): Promise<void>;
};

export type GitWorkspaceStoreOptions = {
  workspaceDir: string;
  /** Override hard-coded remote (tests). Defaults to WORKSPACE_GIT_REMOTE. */
  remoteUrl?: string;
  log?: (...args: unknown[]) => void;
};

/** Branch name === thread id (sanitized for git-safety). */
export function threadBranch(threadId: string): string {
  const safe = threadId.replace(/[^a-zA-Z0-9._/-]/g, "-");
  if (!safe) throw new Error("threadId is empty / invalid as branch name");
  return safe;
}

async function runGit(
  cwd: string,
  args: string[],
  opts?: { allowFail?: boolean; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        ...opts?.env,
        GIT_AUTHOR_NAME: "poc-vm",
        GIT_AUTHOR_EMAIL: "vm@poc.local",
        GIT_COMMITTER_NAME: "poc-vm",
        GIT_COMMITTER_EMAIL: "vm@poc.local",
        // Avoid interactive prompts hanging the VM.
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const result = { stdout, stderr, code: code ?? 1 };
      if (code !== 0 && !opts?.allowFail) {
        reject(
          new Error(
            `git ${args.join(" ")} failed (cwd=${cwd}): ${stderr || stdout}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export class GitWorkspaceStore implements WorkspaceStore {
  private readonly workspaceDir: string;
  private readonly remotePublic: string;
  private readonly log: (...args: unknown[]) => void;

  constructor(options: GitWorkspaceStoreOptions) {
    this.workspaceDir = path.resolve(options.workspaceDir);
    this.remotePublic = options.remoteUrl ?? WORKSPACE_GIT_REMOTE;
    this.log = options.log ?? ((...args) => console.log("[vm:git]", ...args));
  }

  private authRemote(): string {
    return remoteUrlWithAuth(this.remotePublic);
  }

  private async ensureWorkspaceRepo(): Promise<void> {
    await fsp.mkdir(this.workspaceDir, { recursive: true });
    const gitDir = path.join(this.workspaceDir, ".git");
    const url = this.authRemote();
    if (!(await pathExists(gitDir))) {
      this.log(`git init workspace ${this.workspaceDir}`);
      await runGit(this.workspaceDir, ["init", "-b", "main"]);
      await runGit(this.workspaceDir, ["remote", "add", "origin", url]);
    } else {
      await runGit(this.workspaceDir, ["remote", "set-url", "origin", url], {
        allowFail: true,
      });
    }
  }

  async restore(threadId: string): Promise<void> {
    await this.ensureWorkspaceRepo();
    const branch = threadBranch(threadId);
    this.log(`restore thread=${threadId} branch=${branch} remote=${this.remotePublic}`);

    await runGit(this.workspaceDir, ["fetch", "origin"]);

    const remoteBranch = await runGit(
      this.workspaceDir,
      ["rev-parse", "--verify", `origin/${branch}`],
      { allowFail: true },
    );

    if (remoteBranch.code === 0) {
      await runGit(this.workspaceDir, ["checkout", "-B", branch, `origin/${branch}`]);
      await runGit(this.workspaceDir, ["reset", "--hard", `origin/${branch}`]);
      await runGit(this.workspaceDir, ["clean", "-fd"]);
    } else {
      // New thread: branch from main (must exist on the remote).
      const main = await runGit(
        this.workspaceDir,
        ["rev-parse", "--verify", "origin/main"],
        { allowFail: true },
      );
      if (main.code !== 0) {
        throw new Error(
          `remote ${this.remotePublic} has no origin/main — create the repo with a main branch first`,
        );
      }
      await runGit(this.workspaceDir, ["checkout", "-B", branch, "origin/main"]);
      await runGit(this.workspaceDir, ["reset", "--hard", "origin/main"]);
      await runGit(this.workspaceDir, ["clean", "-fd"]);
    }

    this.log(`restore done thread=${threadId}`);
  }

  async persist(threadId: string, message?: string): Promise<void> {
    await this.ensureWorkspaceRepo();
    const branch = threadBranch(threadId);
    this.log(`persist thread=${threadId} branch=${branch}`);

    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new Error(
        "GITHUB_TOKEN is required to push (fine-grained PAT with Contents: Read and write on cursor-onsite-test)",
      );
    }

    // Snapshot-style: force-add everything (including gitignored / previously
    // untracked). Do NOT checkout -B first — that can discard WT changes.
    const before = await runGit(this.workspaceDir, ["status", "--porcelain", "-u"], {
      allowFail: true,
    });
    this.log(`persist status before add:\n${before.stdout || "(clean)"}`);

    await runGit(this.workspaceDir, ["add", "-A", "-f"]);

    const status = await runGit(this.workspaceDir, ["status", "--porcelain"]);
    this.log(`persist status after add:\n${status.stdout || "(clean)"}`);

    if (status.stdout.trim().length > 0) {
      const msg = message ?? `vm persist ${branch}`;
      await runGit(this.workspaceDir, ["commit", "-m", msg]);
      this.log(`persist committed: ${msg}`);
    } else {
      this.log(`persist: no local changes for thread=${threadId}`);
    }

    // Push current HEAD to the thread branch name (no local checkout required).
    const pushUrl = this.authRemote();
    await runGit(
      this.workspaceDir,
      [
        "-c",
        "credential.helper=",
        "push",
        "-u",
        pushUrl,
        `HEAD:refs/heads/${branch}`,
      ],
    );
    this.log(`persist done thread=${threadId}`);
  }
}
