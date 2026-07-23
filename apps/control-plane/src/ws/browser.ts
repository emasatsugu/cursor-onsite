import type { BrowserServerMessage } from "@poc/shared";
import { WebSocket } from "ws";
import { browserSubs } from "../memory/state.js";
import { cpLog, debugPreview } from "../debug/log.js";

export function broadcastToThread(threadId: string, message: BrowserServerMessage): void {
  const set = browserSubs.get(threadId);
  const n = set?.size ?? 0;
  if (!set || n === 0) {
    cpLog(`→ browser thread=${threadId} (0 subscribers)`, message.type);
    return;
  }
  const raw = JSON.stringify(message);
  cpLog(
    `→ browser thread=${threadId} subscribers=${n}`,
    message.type,
    debugPreview(message)
  );
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  }
}
