import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { VmClientMessage, VmServerMessage, ToolResultPayload } from "@poc/shared";
import { VirtualMachine } from "../db/index.js";
import {
  vmSockets,
  vmByThread,
  pendingToolCalls,
  runningLoops,
} from "../memory/state.js";

function sendVm(ws: WebSocket, message: VmServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function sendAssignment(externalId: string, threadId: string): boolean {
  const ws = vmSockets.get(externalId);
  if (!ws) return false;
  sendVm(ws, { type: "assignment", threadId });
  return true;
}

export function sendExecuteToolCall(
  externalId: string,
  payload: Extract<VmServerMessage, { type: "execute_tool_call" }>
): boolean {
  const ws = vmSockets.get(externalId);
  if (!ws) return false;
  sendVm(ws, payload);
  return true;
}

export function waitForToolCallResponse(
  toolCallId: string,
  timeoutMs = 60_000
): Promise<{ ok: boolean; result: ToolResultPayload }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingToolCalls.delete(toolCallId);
      reject(new Error(`tool_call_response timeout for ${toolCallId}`));
    }, timeoutMs);

    pendingToolCalls.set(toolCallId, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value as { ok: boolean; result: ToolResultPayload });
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });
  });
}

async function handleDisconnect(externalId: string): Promise<void> {
  vmSockets.delete(externalId);
  try {
    const vm = await VirtualMachine.findOne({ where: { externalId } });
    if (vm) {
      await vm.update({ status: "unhealthy" });
    }

    // Fail in-flight tool calls + notify browsers for threads on this VM
    for (const [threadId, ext] of [...vmByThread.entries()]) {
      if (ext !== externalId) continue;
      if (!runningLoops.has(threadId)) continue;

      for (const [toolCallId, waiter] of [...pendingToolCalls.entries()]) {
        waiter.reject(
          new Error(`VM ${externalId} disconnected during tool call ${toolCallId}`)
        );
        pendingToolCalls.delete(toolCallId);
      }
      // agent_loop_error will also be emitted from runAgentLoop catch; avoid double-send here
    }
  } catch (err) {
    console.error("handleDisconnect error", err);
  }
}

export function createVmWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    let externalId: string | null = null;

    ws.on("message", async (data) => {
      let msg: VmClientMessage;
      try {
        msg = JSON.parse(data.toString()) as VmClientMessage;
      } catch {
        return;
      }

      try {
        if (msg.type === "register") {
          externalId = msg.externalId;
          vmSockets.set(externalId, ws);
          const [vm] = await VirtualMachine.findOrCreate({
            where: { externalId },
            defaults: { externalId, status: "healthy" },
          });
          if (vm.status !== "healthy") {
            await vm.update({ status: "healthy" });
          }
          console.log(`[vm] registered ${externalId}`);
          return;
        }

        if (msg.type === "heartbeat") {
          const id = msg.externalId;
          if (!vmSockets.has(id)) {
            vmSockets.set(id, ws);
            externalId = id;
          }
          const vm = await VirtualMachine.findOne({ where: { externalId: id } });
          if (vm && vm.status !== "healthy") {
            await vm.update({ status: "healthy" });
          }
          return;
        }

        if (msg.type === "tool_call_response") {
          const waiter = pendingToolCalls.get(msg.toolCallId);
          if (waiter) {
            pendingToolCalls.delete(msg.toolCallId);
            waiter.resolve({ ok: msg.ok, result: msg.result });
          }
          return;
        }
      } catch (err) {
        console.error("[vm] message handler error", err);
      }
    });

    ws.on("close", () => {
      if (externalId) {
        void handleDisconnect(externalId);
      }
    });
  });

  return wss;
}

export function handleVmUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
}
