import type { ToolName } from "./protocol.js";

/** OpenAI Chat Completions tool definitions (source of truth for CP). */
export const OPENAI_TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file" satisfies ToolName,
      description:
        "Read a file from the workspace. Paths are relative to the workspace root. Optionally slice by 1-based line numbers.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path under workspace root" },
          start_line: {
            type: "number",
            description: "Optional 1-based start line (inclusive)",
          },
          end_line: {
            type: "number",
            description: "Optional 1-based end line (inclusive)",
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "write_file" satisfies ToolName,
      description:
        "Create or overwrite an entire file under the workspace with the given content.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path under workspace root" },
          content: { type: "string", description: "Full file contents" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_file" satisfies ToolName,
      description:
        "Surgical search-replace in a file. old_string must appear exactly once; otherwise the tool fails.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path under workspace root" },
          old_string: { type: "string", description: "Exact text to find (must be unique)" },
          new_string: { type: "string", description: "Replacement text" },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "shell" satisfies ToolName,
      description:
        "Run a shell command. cwd defaults to the workspace root and must stay under the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run" },
          cwd: {
            type: "string",
            description: "Optional working directory relative to workspace root",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];

export const SYSTEM_PROMPT = `You are a coding agent with tools to read, write, and edit files, and run shell commands in a workspace.
Paths are relative to the workspace root. Prefer edit_file for surgical changes; use write_file to create or fully overwrite files.
Be concise in your replies. Use tools when you need to inspect or change files.`;
