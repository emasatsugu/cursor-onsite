import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { VmClientMessage, VmServerMessage, ToolResultPayload } from "@poc/shared";
import {
  vmSockets,
  vmPool,
  pendingToolCalls,
  runningLoops,
  registerVm,
  touchVmHeartbeat,
  removeVm,
  threadIdsForVm,
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

function handleDisconnect(externalId: string, reason: "close" | "heartbeat_timeout"): void {
  cpLog(`VM removed ${externalId} reason=${reason}`);
  const ws = vmSockets.get(externalId);
  removeVm(externalId);

  // Drop the socket if we're evicting for missed heartbeats (close path already closed).
  if (reason === "heartbeat_timeout" && ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  // Sticky assignment is kept in vmByThread (follow-ups will 503 until that VM reconnects
  // with the same externalId — which won't happen for this POC since VMs mint new IDs).
  const threads = threadIdsForVm(externalId);
  for (const threadId of threads) {
    if (!runningLoops.has(threadId)) continue;
    for (const [toolCallId, waiter] of [...pendingToolCalls.entries()]) {
      waiter.reject(
        new Error(`VM ${externalId} disconnected during tool call ${toolCallId}`)
      );
      pendingToolCalls.delete(toolCallId);
    }
    cpLog(`in-flight work on thread=${threadId} will fail (VM gone)`);
  }
}

/** Default 30s — VM heartbeats every 5s, so this allows several misses. */
export const VM_HEARTBEAT_TIMEOUT_MS = Number(
  process.env.VM_HEARTBEAT_TIMEOUT_MS ?? 30_000
);
const SWEEP_INTERVAL_MS = Math.min(5_000, Math.max(1_000, VM_HEARTBEAT_TIMEOUT_MS / 3));

/**
 * Periodically evict VMs that have not registered/heartbeated within the timeout.
 */
export function startVmHeartbeatMonitor(): NodeJS.Timeout {
  cpLog(
    `VM heartbeat monitor started timeoutMs=${VM_HEARTBEAT_TIMEOUT_MS} sweepMs=${SWEEP_INTERVAL_MS}`
  );
  return setInterval(() => {
    const now = Date.now();
    for (const [externalId, entry] of [...vmPool.entries()]) {
      const age = now - entry.lastSeenAt;
      if (age > VM_HEARTBEAT_TIMEOUT_MS) {
        cpLog(
          `VM heartbeat timeout ${externalId} lastSeenAgeMs=${age} timeoutMs=${VM_HEARTBEAT_TIMEOUT_MS}`
        );
        handleDisconnect(externalId, "heartbeat_timeout");
      }
    }
  }, SWEEP_INTERVAL_MS);
}

export function createVmWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    let externalId: string | null = null;
    cpLog("VM socket connected (awaiting register)");

    ws.on("message", (data) => {
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
          registerVm(externalId, ws);
          cpLog(`← VM register ${externalId} (pool size=${vmSockets.size})`);
          return;
        }

        if (msg.type === "heartbeat") {
          const id = msg.externalId;
          touchVmHeartbeat(id, ws);
          externalId = id;
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
        // Only handle if still in pool (heartbeat sweeper may have already removed it).
        if (vmSockets.has(externalId) || vmPool.has(externalId)) {
          handleDisconnect(externalId, "close");
        }
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
