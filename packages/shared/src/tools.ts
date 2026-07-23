import type { ToolName } from "./protocol.js";

/** OpenAI Chat Completions tool definitions — single source of truth for CP. */
export const OPENAI_TOOLS: Array<{
  type: "function";
  function: {
    name: ToolName;
    description: string;
    parameters: Record<string, unknown>;
  };
}> = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file under the workspace root. Optional 1-based start_line/end_line slice.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to workspace root" },
          start_line: { type: "integer", description: "1-based start line (inclusive)" },
          end_line: { type: "integer", description: "1-based end line (inclusive)" },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite an entire file under the workspace root.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          content: { type: "string" },
        },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace exactly one occurrence of old_string with new_string. Fails if absent or not unique.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
        },
        required: ["path", "old_string", "new_string"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "function",
    function: {
      name: "shell",
      description: "Run a shell command with cwd defaulting to (and constrained to) the workspace.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string" },
          cwd: {
            type: "string",
            description: "Optional cwd relative to workspace; must stay under workspace",
          },
        },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
];
