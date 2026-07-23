import type { BrowserServerMessage } from "@poc/shared";
import { WebSocket } from "ws";
import { browserSubs } from "../memory/state.js";

export function broadcastToThread(threadId: string, message: BrowserServerMessage): void {
  const set = browserSubs.get(threadId);
  if (!set || set.size === 0) return;
  const raw = JSON.stringify(message);
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(raw);
    }
  }
}
