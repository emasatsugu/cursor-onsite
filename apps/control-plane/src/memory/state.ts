import { WebSocket } from "ws";

/** In-memory control-plane state (not persisted). */
export const vmSockets = new Map<string, WebSocket>();
export const browserSubs = new Map<string, Set<WebSocket>>();
export const runningLoops = new Set<string>();
/** threadId → VM externalId */
export const vmByThread = new Map<string, string>();

/** Pending tool_call_response waiters keyed by toolCallId */
export const pendingToolCalls = new Map<
  string,
  {
    resolve: (value: { ok: boolean; result: unknown }) => void;
    reject: (err: Error) => void;
  }
>();

export function addBrowserSub(threadId: string, ws: WebSocket): void {
  let set = browserSubs.get(threadId);
  if (!set) {
    set = new Set();
    browserSubs.set(threadId, set);
  }
  set.add(ws);
}

export function removeBrowserSub(threadId: string, ws: WebSocket): void {
  const set = browserSubs.get(threadId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) browserSubs.delete(threadId);
}

export function removeBrowserSubFromAll(ws: WebSocket): void {
  for (const [threadId, set] of browserSubs) {
    if (set.delete(ws) && set.size === 0) {
      browserSubs.delete(threadId);
    }
  }
}
