import type { BrowserServerMessage, ToolName, TurnMessage } from "@poc/shared";

/** Flattened view model for the thread transcript + live stream. */
export type DisplayItem =
  | { kind: "user"; id: string; content: string }
  | { kind: "assistant"; id: string; content: string; streaming?: boolean }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      name: ToolName | string;
      arguments: string;
      result?: string;
      open?: boolean;
    }
  | { kind: "error"; id: string; error: string };

export function flattenHistory(
  transcripts: Array<{ id: string; messages: TurnMessage[] }>,
): DisplayItem[] {
  const items: DisplayItem[] = [];

  for (const t of transcripts) {
    const pendingTools = new Map<
      string,
      { name: string; arguments: string }
    >();

    for (let i = 0; i < t.messages.length; i++) {
      const msg = t.messages[i];
      if (msg.role === "user") {
        items.push({
          kind: "user",
          id: `${t.id}-user-${i}`,
          content: msg.content,
        });
      } else if (msg.role === "assistant") {
        if (msg.content) {
          items.push({
            kind: "assistant",
            id: `${t.id}-asst-${i}`,
            content: msg.content,
          });
        }
        for (const tc of msg.tool_calls ?? []) {
          pendingTools.set(tc.id, {
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
          items.push({
            kind: "tool",
            id: `${t.id}-tool-${tc.id}`,
            toolCallId: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      } else if (msg.role === "tool") {
        const meta = pendingTools.get(msg.tool_call_id);
        const existing = items.find(
          (it) => it.kind === "tool" && it.toolCallId === msg.tool_call_id,
        );
        if (existing && existing.kind === "tool") {
          existing.result = msg.content;
        } else {
          items.push({
            kind: "tool",
            id: `${t.id}-toolres-${msg.tool_call_id}`,
            toolCallId: msg.tool_call_id,
            name: meta?.name ?? "tool",
            arguments: meta?.arguments ?? "{}",
            result: msg.content,
          });
        }
      }
    }
  }

  return items;
}

/**
 * Apply a live WS event onto the current display list for the open thread.
 * Mutates a copy and returns the new array.
 */
export function applyLiveEvent(
  items: DisplayItem[],
  msg: BrowserServerMessage,
  opts: { threadId: string },
): DisplayItem[] {
  if (msg.threadId !== opts.threadId) return items;
  const next = [...items];

  switch (msg.type) {
    case "assistant_message": {
      const last = next[next.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = {
          ...last,
          content: last.content + msg.delta,
        };
      } else {
        next.push({
          kind: "assistant",
          id: `live-asst-${msg.transcriptId}-${next.length}`,
          content: msg.delta,
          streaming: true,
        });
      }
      return next;
    }
    case "tool_call_start": {
      // Finalize any streaming assistant bubble before tool UI
      const last = next[next.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { ...last, streaming: false };
      }
      next.push({
        kind: "tool",
        id: `live-tool-${msg.toolCallId}`,
        toolCallId: msg.toolCallId,
        name: msg.name,
        arguments: msg.arguments,
        open: true,
      });
      return next;
    }
    case "tool_call_result": {
      const idx = next.findIndex(
        (it) => it.kind === "tool" && it.toolCallId === msg.toolCallId,
      );
      if (idx >= 0 && next[idx].kind === "tool") {
        next[idx] = { ...next[idx], result: msg.result };
      } else {
        next.push({
          kind: "tool",
          id: `live-toolres-${msg.toolCallId}`,
          toolCallId: msg.toolCallId,
          name: "tool",
          arguments: "{}",
          result: msg.result,
          open: true,
        });
      }
      return next;
    }
    case "agent_loop_done": {
      const last = next[next.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { ...last, streaming: false };
      }
      return next;
    }
    case "agent_loop_error": {
      const last = next[next.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        next[next.length - 1] = { ...last, streaming: false };
      }
      next.push({
        kind: "error",
        id: `live-err-${Date.now()}`,
        error: msg.error,
      });
      return next;
    }
    default:
      return next;
  }
}
