import type { WebSocket } from "ws";
import {
  browserSubs,
  isThreadIdleForReclaim,
  isVmAssigned,
  runningLoops,
  threadIdsForVm,
  threadSubsEmptySince,
  vmByThread,
  vmPool,
  vmSockets,
} from "../memory/state.js";
import { IDLE_RECLAIM_MS } from "../assignment/lifecycle.js";
import { openBrowserSocketCount } from "../ws/browserServer.js";
import {
  listActiveAssignmentsFromDb,
  listVmsFromDb,
} from "../assignment/store.js";

function wsReadyState(ws: WebSocket): string {
  switch (ws.readyState) {
    case 0:
      return "CONNECTING";
    case 1:
      return "OPEN";
    case 2:
      return "CLOSING";
    case 3:
      return "CLOSED";
    default:
      return String(ws.readyState);
  }
}

function idleInfo(threadId: string, now: number) {
  const emptySince = threadSubsEmptySince.get(threadId);
  if (emptySince == null) {
    return {
      emptySince: null,
      emptyForMs: null,
      reclaimInMs: null,
      reclaimEligible: false,
    };
  }
  const emptyForMs = now - emptySince;
  const hasSubs = (browserSubs.get(threadId)?.size ?? 0) > 0;
  const reclaimEligible = isThreadIdleForReclaim(threadId, IDLE_RECLAIM_MS);
  return {
    emptySince: new Date(emptySince).toISOString(),
    emptyForMs,
    reclaimInMs: hasSubs ? null : Math.max(0, IDLE_RECLAIM_MS - emptyForMs),
    reclaimEligible,
  };
}

/** Snapshot of CP runtime for GET /debug[/state]. */
export async function buildDebugSnapshot() {
  const now = Date.now();

  const uniqueBrowserSockets = new Set<WebSocket>();
  for (const set of browserSubs.values()) {
    for (const ws of set) uniqueBrowserSockets.add(ws);
  }

  const vmPoolOut = [...vmPool.values()]
    .map((vm) => {
      const connected = vmSockets.has(vm.externalId);
      const assigned = isVmAssigned(vm.externalId);
      return {
        externalId: vm.externalId,
        connected,
        assigned,
        availableForNewThread: connected && !assigned,
        threadIds: threadIdsForVm(vm.externalId),
        connectedAt: new Date(vm.connectedAt).toISOString(),
        lastSeenAt: new Date(vm.lastSeenAt).toISOString(),
        lastSeenAgoMs: now - vm.lastSeenAt,
      };
    })
    .sort((a, b) => a.externalId.localeCompare(b.externalId));

  const assignments = [...vmByThread.entries()]
    .map(([threadId, vmExternalId]) => ({
      threadId,
      vmExternalId,
      vmConnected: vmSockets.has(vmExternalId),
      loopRunning: runningLoops.has(threadId),
      browserSubscribers: browserSubs.get(threadId)?.size ?? 0,
      idle: idleInfo(threadId, now),
    }))
    .sort((a, b) => a.threadId.localeCompare(b.threadId));

  const subscriptions = [...browserSubs.entries()]
    .map(([threadId, set]) => ({
      threadId,
      connections: set.size,
      readyStates: [...set].map(wsReadyState),
      assignedVm: vmByThread.get(threadId) ?? null,
      loopRunning: runningLoops.has(threadId),
    }))
    .sort((a, b) => a.threadId.localeCompare(b.threadId));

  const idleWatch = [...threadSubsEmptySince.keys()]
    .map((threadId) => ({
      threadId,
      assignedVm: vmByThread.get(threadId) ?? null,
      ...idleInfo(threadId, now),
    }))
    .sort((a, b) => a.threadId.localeCompare(b.threadId));

  const [dbVms, dbAssignments] = await Promise.all([
    listVmsFromDb(),
    listActiveAssignmentsFromDb(),
  ]);

  return {
    now: new Date(now).toISOString(),
    idleReclaimMs: IDLE_RECLAIM_MS,
    vmPool: vmPoolOut,
    assignments,
    db: {
      virtualMachines: dbVms,
      activeAssignments: dbAssignments,
      note: "DB is SoT for VM identity/health + sticky assignments; vmPool/assignments above are live cache + sockets.",
    },
    browserWs: {
      openConnections: openBrowserSocketCount(),
      subscribedConnections: uniqueBrowserSockets.size,
      subscriptions,
      idleWatch,
    },
    runningLoops: [...runningLoops].sort(),
  };
}
