import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { OPENAI_TOOLS, SYSTEM_PROMPT } from "@poc/shared";
import type { ToolName } from "@poc/shared";

export type StreamedToolCall = {
  id: string;
  name: ToolName;
  arguments: string;
};

export type StreamTurnResult = {
  content: string | null;
  toolCalls: StreamedToolCall[];
};

const useMock = process.env.MOCK_OPENAI === "1" || !process.env.OPENAI_API_KEY;

let openai: OpenAI | null = null;
function getClient(): OpenAI {
  if (!openai) {
    openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openai;
}

export type OnTextDelta = (delta: string) => void;

/**
 * Mock stream: assistant text → one read_file tool call → (caller continues loop).
 * Second call (after tool results present) returns final text with no tools.
 */
async function mockStreamCompletion(
  messages: ChatCompletionMessageParam[],
  onTextDelta: OnTextDelta
): Promise<StreamTurnResult> {
  const hasToolResult = messages.some((m) => m.role === "tool");

  if (!hasToolResult) {
    const text = "I'll inspect the workspace README first.";
    for (const ch of text) {
      onTextDelta(ch);
      await new Promise((r) => setTimeout(r, 5));
    }
    return {
      content: text,
      toolCalls: [
        {
          id: "call_mock_read_readme",
          name: "read_file",
          arguments: JSON.stringify({ path: "README.md" }),
        },
      ],
    };
  }

  const text = "Done — I read the file and I'm finished for this turn.";
  for (const ch of text) {
    onTextDelta(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
  return { content: text, toolCalls: [] };
}

export async function streamChatCompletion(
  messages: ChatCompletionMessageParam[],
  onTextDelta: OnTextDelta
): Promise<StreamTurnResult> {
  if (useMock) {
    return mockStreamCompletion(messages, onTextDelta);
  }

  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  const stream = await getClient().chat.completions.create({
    model,
    messages,
    tools: OPENAI_TOOLS,
    stream: true,
  });

  let content = "";
  const toolAcc = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    if (!choice) continue;
    const delta = choice.delta;

    if (delta?.content) {
      content += delta.content;
      onTextDelta(delta.content);
    }

    if (delta?.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        let acc = toolAcc.get(idx);
        if (!acc) {
          acc = { id: "", name: "", arguments: "" };
          toolAcc.set(idx, acc);
        }
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name) acc.name += tc.function.name;
        if (tc.function?.arguments) acc.arguments += tc.function.arguments;
      }
    }
  }

  const toolCalls: StreamedToolCall[] = [...toolAcc.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, v]) => ({
      id: v.id,
      name: v.name as ToolName,
      arguments: v.arguments,
    }));

  return {
    content: content.length > 0 ? content : null,
    toolCalls,
  };
}

export function buildSystemMessage(): ChatCompletionMessageParam {
  return { role: "system", content: SYSTEM_PROMPT };
}
