import { randomUUID } from "node:crypto";
import {
  browserSubCount,
  findAvailableVm,
  getAssignedVm,
  isThreadIdleForReclaim,
  runningLoops,
  vmByThread,
  vmSockets,
} from "../memory/state.js";
import { cpLog } from "../debug/log.js";
import {
  sendAssignment,
  sendPersistRequest,
  sendUnassign,
  waitForPersistResponse,
} from "../ws/vm.js";
import { persistAssign, persistClear } from "./store.js";

/**
 * Grace after last browser subscriber leaves before reclaim.
 * Default 30s — long enough to switch threads / survive brief WS blips without
 * thrashing assign+restore. Set 0 for immediate reclaim (debug / demos).
 */
export const IDLE_RECLAIM_MS = Number(process.env.IDLE_RECLAIM_MS ?? 30_000);

/**
 * Ensure the thread has a connected sticky VM.
 * Prefer existing sticky if connected; else assign a free VM.
 * Dead sticky rows should already be cleared on VM disconnect; scrub if present.
 */
export async function ensureConnectedVmForThread(
  threadId: string
): Promise<{ externalId: string; reassigned: boolean } | null> {
  const sticky = getAssignedVm(threadId);
  if (sticky && vmSockets.has(sticky)) {
    return { externalId: sticky, reassigned: false };
  }

  if (sticky && !vmSockets.has(sticky)) {
    cpLog(
      `scrub dead sticky thread=${threadId} was VM ${sticky} (should have been cleared on disconnect)`
    );
    await persistClear(threadId);
  }

  const free = findAvailableVm();
  if (!free) {
    cpLog(`ensureConnectedVm: no free VM for thread=${threadId}`);
    return null;
  }

  cpLog(`assign thread=${threadId} → ${free}`);
  await persistAssign(threadId, free);
  sendAssignment(free, threadId);
  return { externalId: free, reassigned: true };
}

export async function requestPersist(
  externalId: string,
  threadId: string,
  timeoutMs = 30_000
): Promise<void> {
  const requestId = randomUUID();
  const sent = sendPersistRequest(externalId, {
    type: "persist_request",
    threadId,
    requestId,
  });
  if (!sent) {
    throw new Error(`persist_request: VM ${externalId} not connected`);
  }
  const result = await waitForPersistResponse(requestId, timeoutMs);
  if (!result.ok) {
    throw new Error(result.error ?? "persist_response not ok");
  }
}

/**
 * Release sticky assignment back to the pool.
 * Best-effort persist + unassign if VM still connected.
 */
export async function reclaimThreadVm(threadId: string): Promise<void> {
  const externalId = getAssignedVm(threadId);
  if (!externalId) return;
  if (runningLoops.has(threadId)) {
    cpLog(`reclaim deferred thread=${threadId} (loop running)`);
    return;
  }
  if (browserSubCount(threadId) > 0) {
    cpLog(`reclaim skipped thread=${threadId} (has browser subs)`);
    return;
  }

  if (vmSockets.has(externalId)) {
    try {
      await requestPersist(externalId, threadId);
    } catch (err) {
      cpLog(`reclaim persist failed thread=${threadId} (continuing)`, err);
    }
    sendUnassign(externalId, threadId);
  }

  await persistClear(threadId);
  cpLog(`reclaimed thread=${threadId} freed VM ${externalId}`);
}

/**
 * After last browser sub leaves (or loop ends): reclaim if idle long enough.
 * With IDLE_RECLAIM_MS=0 this is immediate.
 */
export function maybeReclaimThread(threadId: string): void {
  if (!isThreadIdleForReclaim(threadId, IDLE_RECLAIM_MS)) return;
  cpLog(`reclaim triggered thread=${threadId} idleMs=${IDLE_RECLAIM_MS}`);
  void reclaimThreadVm(threadId);
}

/** Threads whose subscriber set just hit zero. */
export function maybeReclaimThreads(threadIds: string[]): void {
  for (const threadId of threadIds) {
    maybeReclaimThread(threadId);
  }
}

/**
 * Backup sweeper: catches reclaim deferred while a loop was running,
 * and IDLE_RECLAIM_MS > 0 grace windows.
 */
export function startIdleReclaimMonitor(): NodeJS.Timeout {
  const sweepMs =
    IDLE_RECLAIM_MS <= 0
      ? 2_000
      : Math.min(10_000, Math.max(1_000, IDLE_RECLAIM_MS / 3));
  cpLog(
    `idle reclaim monitor started idleMs=${IDLE_RECLAIM_MS} sweepMs=${sweepMs}`
  );
  return setInterval(() => {
    for (const threadId of [...vmByThread.keys()]) {
      maybeReclaimThread(threadId);
    }
  }, sweepMs);
}
