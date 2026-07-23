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
import { cpLog, debugPreview } from "../debug/log.js";

function sendVm(ws: WebSocket, message: VmServerMessage, externalId?: string): void {
  if (ws.readyState === WebSocket.OPEN) {
    cpLog(
      `→ VM${externalId ? ` ${externalId}` : ""}`,
      message.type,
      debugPreview(message)
    );
    ws.send(JSON.stringify(message));
  } else {
    cpLog(
      `→ VM${externalId ? ` ${externalId}` : ""} DROPPED (socket not open)`,
      message.type
    );
  }
}

export function sendAssignment(externalId: string, threadId: string): boolean {
  const ws = vmSockets.get(externalId);
  if (!ws) {
    cpLog(`assignment FAILED — no socket for VM ${externalId} thread=${threadId}`);
    return false;
  }
  cpLog(`assignment thread=${threadId} → VM ${externalId}`);
  sendVm(ws, { type: "assignment", threadId }, externalId);
  return true;
}

export function sendExecuteToolCall(
  externalId: string,
  payload: Extract<VmServerMessage, { type: "execute_tool_call" }>
): boolean {
  const ws = vmSockets.get(externalId);
  if (!ws) {
    cpLog(
      `execute_tool_call FAILED — no socket for VM ${externalId} toolCallId=${payload.toolCallId}`
    );
    return false;
  }
  sendVm(ws, payload, externalId);
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
  cpLog(`VM disconnected ${externalId}`);
  vmSockets.delete(externalId);
  try {
    const vm = await VirtualMachine.findOne({ where: { externalId } });
    if (vm) {
      await vm.update({ status: "unhealthy" });
      cpLog(`VM ${externalId} marked unhealthy`);
    }

    for (const [threadId, ext] of [...vmByThread.entries()]) {
      if (ext !== externalId) continue;
      if (!runningLoops.has(threadId)) continue;

      for (const [toolCallId, waiter] of [...pendingToolCalls.entries()]) {
        waiter.reject(
          new Error(`VM ${externalId} disconnected during tool call ${toolCallId}`)
        );
        pendingToolCalls.delete(toolCallId);
      }
    }
  } catch (err) {
    console.error("handleDisconnect error", err);
  }
}

export function createVmWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    let externalId: string | null = null;
    cpLog("VM socket connected (awaiting register)");

    ws.on("message", async (data) => {
      let msg: VmClientMessage;
      try {
        msg = JSON.parse(data.toString()) as VmClientMessage;
      } catch {
        cpLog("← VM invalid JSON", data.toString().slice(0, 200));
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
          cpLog(`← VM register ${externalId} (pool size=${vmSockets.size})`);
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
          cpLog(`← VM heartbeat ${id}`);
          return;
        }

        if (msg.type === "tool_call_response") {
          cpLog(
            `← VM tool_call_response ${msg.toolCallId} ok=${msg.ok}`,
            debugPreview(msg.result)
          );
          const waiter = pendingToolCalls.get(msg.toolCallId);
          if (waiter) {
            pendingToolCalls.delete(msg.toolCallId);
            waiter.resolve({ ok: msg.ok, result: msg.result });
          } else {
            cpLog(`← VM tool_call_response unmatched toolCallId=${msg.toolCallId}`);
          }
          return;
        }

        cpLog("← VM unknown message", debugPreview(msg));
      } catch (err) {
        console.error("[vm] message handler error", err);
      }
    });

    ws.on("close", () => {
      if (externalId) {
        void handleDisconnect(externalId);
      } else {
        cpLog("VM socket closed before register");
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
