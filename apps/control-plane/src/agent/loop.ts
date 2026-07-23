import { v4 as uuidv4 } from "uuid";
import type {
  ToolArgs,
  ToolName,
  TranscriptBlob,
  TurnMessage,
} from "@poc/shared";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import {
  BlobStorage,
  Transcript,
} from "../db/index.js";
import { runningLoops, vmByThread } from "../memory/state.js";
import { broadcastToThread } from "../ws/browser.js";
import {
  sendExecuteToolCall,
  waitForToolCallResponse,
} from "../ws/vm.js";
import {
  buildSystemMessage,
  streamChatCompletion,
} from "./openai.js";

const MAX_STEPS = 25;

async function putBlob(key: string, messages: TranscriptBlob): Promise<void> {
  const value = JSON.stringify(messages);
  const existing = await BlobStorage.findByPk(key);
  if (existing) {
    await existing.update({ value });
  } else {
    await BlobStorage.create({ key, value });
  }
}

async function loadBlob(key: string): Promise<TranscriptBlob> {
  const row = await BlobStorage.findByPk(key);
  if (!row) return [];
  return JSON.parse(row.value) as TranscriptBlob;
}

async function loadAllTurnMessages(threadId: string): Promise<TurnMessage[]> {
  const transcripts = await Transcript.findAll({
    where: { threadId },
    order: [["createdAt", "ASC"]],
  });
  const out: TurnMessage[] = [];
  for (const t of transcripts) {
    const blob = await loadBlob(t.key);
    out.push(...blob);
  }
  return out;
}

function toOpenAIMessages(turns: TurnMessage[]): ChatCompletionMessageParam[] {
  return turns.map((m) => {
    if (m.role === "user") {
      return { role: "user" as const, content: m.content };
    }
    if (m.role === "tool") {
      return {
        role: "tool" as const,
        tool_call_id: m.tool_call_id,
        content: m.content,
      };
    }
    // assistant
    const msg: ChatCompletionMessageParam = {
      role: "assistant",
      content: m.content,
    };
    if (m.tool_calls && m.tool_calls.length > 0) {
      (msg as { tool_calls?: unknown }).tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));
    }
    return msg;
  });
}

export async function createTranscriptWithUserPrompt(
  threadId: string,
  prompt: string
): Promise<{ transcriptId: string; key: string }> {
  const transcriptId = uuidv4();
  const key = `transcript:${transcriptId}`;
  const initial: TranscriptBlob = [{ role: "user", content: prompt }];
  await BlobStorage.create({ key, value: JSON.stringify(initial) });
  await Transcript.create({ id: transcriptId, threadId, key });
  return { transcriptId, key };
}

/**
 * Runs the agent loop asynchronously. Caller should already have added threadId
 * to runningLoops and created the transcript with the user prompt.
 */
export async function runAgentLoop(
  threadId: string,
  transcriptId: string,
  key: string
): Promise<void> {
  try {
    let steps = 0;
    while (steps < MAX_STEPS) {
      steps += 1;
      const turnMessages = await loadAllTurnMessages(threadId);
      const messages: ChatCompletionMessageParam[] = [
        buildSystemMessage(),
        ...toOpenAIMessages(turnMessages),
      ];

      const result = await streamChatCompletion(messages, (delta) => {
        if (!delta) return;
        broadcastToThread(threadId, {
          type: "assistant_message",
          threadId,
          transcriptId,
          delta,
        });
      });

      const blob = await loadBlob(key);
      const assistantMsg: TurnMessage = {
        role: "assistant",
        content: result.content,
        ...(result.toolCalls.length > 0
          ? {
              tool_calls: result.toolCalls.map((tc) => ({
                id: tc.id,
                type: "function" as const,
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };
      blob.push(assistantMsg);
      await putBlob(key, blob);

      if (result.toolCalls.length === 0) {
        broadcastToThread(threadId, {
          type: "agent_loop_done",
          threadId,
          transcriptId,
        });
        return;
      }

      const externalId = vmByThread.get(threadId);
      if (!externalId) {
        throw new Error("No sticky VM for thread");
      }

      // Emit tool_call_start for each, then parallel fan-out
      for (const tc of result.toolCalls) {
        broadcastToThread(threadId, {
          type: "tool_call_start",
          threadId,
          transcriptId,
          toolCallId: tc.id,
          name: tc.name,
          arguments: tc.arguments,
        });
      }

      const toolResults = await Promise.all(
        result.toolCalls.map(async (tc) => {
          let args: ToolArgs;
          try {
            args = JSON.parse(tc.arguments) as ToolArgs;
          } catch {
            args = {} as ToolArgs;
          }
          const sent = sendExecuteToolCall(externalId, {
            type: "execute_tool_call",
            threadId,
            toolCallId: tc.id,
            name: tc.name as ToolName,
            arguments: args,
          });
          if (!sent) {
            throw new Error(`VM ${externalId} not connected`);
          }
          const response = await waitForToolCallResponse(tc.id);
          return { toolCallId: tc.id, response };
        })
      );

      const blobAfter = await loadBlob(key);
      for (const { toolCallId, response } of toolResults) {
        const resultStr = JSON.stringify(response.result);
        broadcastToThread(threadId, {
          type: "tool_call_result",
          threadId,
          transcriptId,
          toolCallId,
          result: resultStr,
        });
        blobAfter.push({
          role: "tool",
          tool_call_id: toolCallId,
          content: resultStr,
        });
      }
      await putBlob(key, blobAfter);
      // loop again
    }

    broadcastToThread(threadId, {
      type: "agent_loop_error",
      threadId,
      transcriptId,
      error: `Exceeded MAX_STEPS (${MAX_STEPS})`,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[agent] loop error thread=${threadId}`, err);
    broadcastToThread(threadId, {
      type: "agent_loop_error",
      threadId,
      transcriptId,
      error,
    });
  } finally {
    runningLoops.delete(threadId);
  }
}
