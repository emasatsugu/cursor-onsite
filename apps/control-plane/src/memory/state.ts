import { WebSocket } from "ws";

export type VmPoolEntry = {
  externalId: string;
  /** Wall-clock ms when the VM last registered or sent a heartbeat. */
  lastSeenAt: number;
  connectedAt: number;
};

/** In-memory control-plane state (not persisted). */
export const vmSockets = new Map<string, WebSocket>();
/** Connected VM metadata keyed by externalId. */
export const vmPool = new Map<string, VmPoolEntry>();
export const browserSubs = new Map<string, Set<WebSocket>>();
export const runningLoops = new Set<string>();
/** Sticky assignment cache: threadId → VM externalId (write-through; empty after CP boot). */
export const vmByThread = new Map<string, string>();

/**
 * When browser subscriber count for a thread last hit zero.
 * Idle reclaim only starts after a thread *had* subscribers and then lost them.
 */
export const threadSubsEmptySince = new Map<string, number>();

/** Pending tool_call_response waiters keyed by toolCallId */
export const pendingToolCalls = new Map<
  string,
  {
    resolve: (value: { ok: boolean; result: unknown }) => void;
    reject: (err: Error) => void;
  }
>();

/** Pending persist_response waiters keyed by requestId */
export const pendingPersists = new Map<
  string,
  {
    resolve: (value: { ok: boolean; error?: string }) => void;
    reject: (err: Error) => void;
  }
>();

export function registerVm(externalId: string, ws: WebSocket): void {
  const now = Date.now();
  vmSockets.set(externalId, ws);
  const existing = vmPool.get(externalId);
  vmPool.set(externalId, {
    externalId,
    connectedAt: existing?.connectedAt ?? now,
    lastSeenAt: now,
  });
}

export function touchVmHeartbeat(externalId: string, ws?: WebSocket): void {
  if (ws && !vmSockets.has(externalId)) {
    vmSockets.set(externalId, ws);
  }
  const now = Date.now();
  const existing = vmPool.get(externalId);
  vmPool.set(externalId, {
    externalId,
    connectedAt: existing?.connectedAt ?? now,
    lastSeenAt: now,
  });
}

export function removeVm(externalId: string): void {
  vmSockets.delete(externalId);
  vmPool.delete(externalId);
}

/** externalIds currently sticky-assigned to some thread */
export function assignedExternalIds(): Set<string> {
  return new Set(vmByThread.values());
}

export function isVmAssigned(externalId: string): boolean {
  for (const ext of vmByThread.values()) {
    if (ext === externalId) return true;
  }
  return false;
}

/**
 * First connected VM that is not sticky-assigned to any thread.
 */
export function findAvailableVm(): string | null {
  const assigned = assignedExternalIds();
  for (const externalId of vmSockets.keys()) {
    if (!assigned.has(externalId)) return externalId;
  }
  return null;
}

export function assignVmToThread(threadId: string, externalId: string): void {
  vmByThread.set(threadId, externalId);
}

export function clearThreadAssignment(threadId: string): string | undefined {
  const prev = vmByThread.get(threadId);
  vmByThread.delete(threadId);
  threadSubsEmptySince.delete(threadId);
  return prev;
}

export function getAssignedVm(threadId: string): string | undefined {
  return vmByThread.get(threadId);
}

export function threadIdsForVm(externalId: string): string[] {
  return [...vmByThread.entries()]
    .filter(([, ext]) => ext === externalId)
    .map(([threadId]) => threadId);
}

export function browserSubCount(threadId: string): number {
  return browserSubs.get(threadId)?.size ?? 0;
}

/**
 * Idle = has sticky assignment, no running loop, no browser subscribers,
 * and subscribers have been empty for at least `idleMs` (only after having had subs).
 */
export function isThreadIdleForReclaim(threadId: string, idleMs: number): boolean {
  if (!vmByThread.has(threadId)) return false;
  if (runningLoops.has(threadId)) return false;
  if (browserSubCount(threadId) > 0) return false;
  const emptySince = threadSubsEmptySince.get(threadId);
  if (emptySince == null) return false;
  return Date.now() - emptySince >= idleMs;
}

export function addBrowserSub(threadId: string, ws: WebSocket): void {
  let set = browserSubs.get(threadId);
  if (!set) {
    set = new Set();
    browserSubs.set(threadId, set);
  }
  set.add(ws);
  threadSubsEmptySince.delete(threadId);
}

export function removeBrowserSub(threadId: string, ws: WebSocket): string[] {
  const set = browserSubs.get(threadId);
  if (!set) return [];
  set.delete(ws);
  if (set.size === 0) {
    browserSubs.delete(threadId);
    threadSubsEmptySince.set(threadId, Date.now());
    return [threadId];
  }
  return [];
}

/** @returns threadIds whose subscriber set just became empty */
export function removeBrowserSubFromAll(ws: WebSocket): string[] {
  const emptied: string[] = [];
  for (const [threadId, set] of browserSubs) {
    if (set.delete(ws) && set.size === 0) {
      browserSubs.delete(threadId);
      threadSubsEmptySince.set(threadId, Date.now());
      emptied.push(threadId);
    }
  }
  return emptied;
}
