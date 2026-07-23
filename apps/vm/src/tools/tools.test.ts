import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executeTool } from "./execute.js";
import { resolveWorkspacePath } from "./paths.js";

describe("resolveWorkspacePath", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vm-ws-"));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("resolves relative paths under workspace", async () => {
    const result = await resolveWorkspacePath(workspace, "src/hello.js");
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.absolutePath, path.join(workspace, "src/hello.js"));
    }
  });

  it("rejects path traversal with ..", async () => {
    const result = await resolveWorkspacePath(workspace, "../outside.txt");
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /escapes workspace/);
    }
  });

  it("rejects absolute paths outside workspace", async () => {
    const result = await resolveWorkspacePath(workspace, "/etc/passwd");
    assert.equal(result.ok, false);
  });
});

describe("tools", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "vm-tools-"));
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.writeFile(
      path.join(workspace, "src", "hello.js"),
      'console.log("hello");\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(workspace, "dup.txt"),
      "aaa\nbbb\naaa\n",
      "utf8",
    );
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it("read_file returns full content", async () => {
    const { ok, result } = await executeTool(workspace, "read_file", {
      path: "src/hello.js",
    });
    assert.equal(ok, true);
    assert.deepEqual(result, { content: 'console.log("hello");\n' });
  });

  it("read_file supports 1-based line slice", async () => {
    await fs.writeFile(
      path.join(workspace, "lines.txt"),
      "one\ntwo\nthree\nfour\n",
      "utf8",
    );
    const { ok, result } = await executeTool(workspace, "read_file", {
      path: "lines.txt",
      start_line: 2,
      end_line: 3,
    });
    assert.equal(ok, true);
    assert.deepEqual(result, { content: "two\nthree" });
  });

  it("write_file creates and overwrites", async () => {
    const written = await executeTool(workspace, "write_file", {
      path: "new/dir/file.txt",
      content: "created",
    });
    assert.equal(written.ok, true);
    assert.deepEqual(written.result, { ok: true });

    const content = await fs.readFile(
      path.join(workspace, "new/dir/file.txt"),
      "utf8",
    );
    assert.equal(content, "created");

    const overwritten = await executeTool(workspace, "write_file", {
      path: "new/dir/file.txt",
      content: "updated",
    });
    assert.equal(overwritten.ok, true);
    assert.equal(
      await fs.readFile(path.join(workspace, "new/dir/file.txt"), "utf8"),
      "updated",
    );
  });

  it("edit_file replaces a unique occurrence", async () => {
    const { ok, result } = await executeTool(workspace, "edit_file", {
      path: "src/hello.js",
      old_string: 'console.log("hello");',
      new_string: 'console.log("hi");',
    });
    assert.equal(ok, true);
    assert.deepEqual(result, { ok: true });
    assert.equal(
      await fs.readFile(path.join(workspace, "src/hello.js"), "utf8"),
      'console.log("hi");\n',
    );
  });

  it("edit_file fails when old_string is missing", async () => {
    const { ok, result } = await executeTool(workspace, "edit_file", {
      path: "src/hello.js",
      old_string: "does-not-exist",
      new_string: "x",
    });
    assert.equal(ok, false);
    assert.equal(
      (result as { ok: false; error: string }).error,
      "old_string not found in file",
    );
  });

  it("edit_file fails when old_string is not unique", async () => {
    const { ok, result } = await executeTool(workspace, "edit_file", {
      path: "dup.txt",
      old_string: "aaa",
      new_string: "zzz",
    });
    assert.equal(ok, false);
    assert.match(
      (result as { ok: false; error: string }).error,
      /not unique/,
    );
  });

  it("shell runs command in workspace and returns exit_code", async () => {
    const { ok, result } = await executeTool(workspace, "shell", {
      command: "pwd && echo hi && false",
    });
    assert.equal(ok, true);
    const shellResult = result as {
      stdout: string;
      stderr: string;
      exit_code: number;
    };
    assert.match(shellResult.stdout, /hi/);
    assert.equal(shellResult.exit_code, 1);
    // cwd should be workspace
    assert.ok(shellResult.stdout.includes(workspace));
  });

  it("shell rejects cwd outside workspace", async () => {
    const { ok, result } = await executeTool(workspace, "shell", {
      command: "echo nope",
      cwd: "..",
    });
    assert.equal(ok, false);
    assert.match((result as { ok: false; error: string }).error, /escapes/);
  });

  it("path traversal fails for write_file", async () => {
    const { ok, result } = await executeTool(workspace, "write_file", {
      path: "../../etc/evil",
      content: "x",
    });
    assert.equal(ok, false);
    assert.match((result as { ok: false; error: string }).error, /escapes/);
  });

  it("parallel executeTool calls complete independently", async () => {
    const results = await Promise.all([
      executeTool(workspace, "read_file", { path: "src/hello.js" }),
      executeTool(workspace, "read_file", { path: "dup.txt" }),
      executeTool(workspace, "shell", { command: "echo parallel" }),
    ]);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, true);
    assert.equal(results[2].ok, true);
    assert.deepEqual(results[0].result, {
      content: 'console.log("hello");\n',
    });
    assert.match(
      (results[2].result as { stdout: string }).stdout,
      /parallel/,
    );
  });
});
