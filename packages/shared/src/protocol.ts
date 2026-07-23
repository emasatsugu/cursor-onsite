// --- Tools ---
export type ToolName = "read_file" | "write_file" | "edit_file" | "shell";

export type ReadFileArgs = { path: string; start_line?: number; end_line?: number };
export type WriteFileArgs = { path: string; content: string };
export type EditFileArgs = { path: string; old_string: string; new_string: string };
export type ShellArgs = { command: string; cwd?: string };

export type ToolArgs = ReadFileArgs | WriteFileArgs | EditFileArgs | ShellArgs;

export type ShellToolResult = { stdout: string; stderr: string; exit_code: number };
export type ReadFileToolResult = { content: string };
export type WriteFileToolResult = { ok: true };
export type EditFileToolResult = { ok: true } | { ok: false; error: string };
export type ToolResultPayload =
  | ShellToolResult
  | ReadFileToolResult
  | WriteFileToolResult
  | EditFileToolResult
  | { ok: false; error: string };

// --- Transcript blob (one turn) ---
// Stored JSON array of OpenAI-style messages for that turn only (no system/tools).
export type TurnMessage =
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: ToolName; arguments: string }; // arguments = JSON string
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string }; // content = JSON.stringify(result)

export type TranscriptBlob = TurnMessage[];

// --- HTTP ---
export type ThreadSummary = {
  id: string;
  userId: string;
  createdAt: string; // ISO
};

export type TranscriptDTO = {
  id: string;
  threadId: string;
  createdAt: string;
  messages: TranscriptBlob; // blob resolved
};

export type ThreadDetail = ThreadSummary & {
  transcripts: TranscriptDTO[];
};

export type CreateThreadRequest = { prompt: string };
export type CreateThreadResponse = { thread: ThreadSummary };
export type PostMessageRequest = { prompt: string };
export type PostMessageResponse = { transcriptId: string };

export type ThreadsListResponse = { threads: ThreadSummary[] };
export type ApiError = { error: string };

// --- Browser ↔ CP WS ---
export type BrowserClientMessage =
  | { type: "subscribe"; threadId: string }
  | { type: "unsubscribe" };

export type BrowserServerMessage =
  | {
      type: "assistant_message";
      threadId: string;
      transcriptId: string;
      // streaming: cumulative or delta — use delta for POC
      delta: string;
    }
  | {
      type: "tool_call_start";
      threadId: string;
      transcriptId: string;
      toolCallId: string;
      name: ToolName;
      arguments: string; // full JSON args string once buffered/complete
    }
  | {
      type: "tool_call_result";
      threadId: string;
      transcriptId: string;
      toolCallId: string;
      result: string; // JSON string of ToolResultPayload
    }
  | {
      type: "agent_loop_done";
      threadId: string;
      transcriptId: string;
    }
  | {
      type: "agent_loop_error";
      threadId: string;
      transcriptId?: string;
      error: string;
    };

// --- CP ↔ VM WS ---
export type VmClientMessage =
  | { type: "register"; externalId: string }
  | { type: "heartbeat"; externalId: string }
  | {
      type: "tool_call_response";
      toolCallId: string;
      ok: boolean;
      result: ToolResultPayload;
    }
  | {
      type: "persist_response";
      requestId: string;
      ok: boolean;
      error?: string;
    };

export type VmServerMessage =
  | { type: "assignment"; threadId: string }
  | { type: "unassign"; threadId: string }
  | {
      type: "persist_request";
      threadId: string;
      requestId: string;
    }
  | {
      type: "execute_tool_call";
      threadId: string;
      toolCallId: string;
      name: ToolName;
      arguments: ToolArgs; // parsed object, not string
    };
