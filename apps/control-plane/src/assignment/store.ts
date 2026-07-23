import { Assignment, VirtualMachine } from "../db/index.js";
import { cpLog } from "../debug/log.js";
import {
  assignVmToThread,
  clearThreadAssignment,
  vmByThread,
} from "../memory/state.js";

/**
 * DB is source of truth for VM rows + sticky assignments.
 * `vmByThread` is a cache rebuilt on boot and updated on every write.
 *
 * Policy (matches runtime): sticky cleared on VM disconnect / reclaim;
 * follow-ups assign any free connected VM on demand.
 */

/** This process id — written to `virtual_machines.owner_cp_id` on register. */
export function cpInstanceId(): string {
  return process.env.CP_INSTANCE_ID?.trim() || "1";
}

export async function hydrateAssignmentCache(): Promise<void> {
  vmByThread.clear();
  const rows = await Assignment.findAll({
    where: { status: "active" },
    include: [{ model: VirtualMachine, as: "vm" }],
  });
  for (const row of rows) {
    const vm = row.vm;
    if (!vm) {
      cpLog(`hydrate: assignment ${row.id} missing vm — skipping`);
      continue;
    }
    vmByThread.set(row.threadId, vm.externalId);
  }
  cpLog(`hydrated ${vmByThread.size} active assignment(s) from DB`);
}

export async function upsertVmHealthy(externalId: string): Promise<VirtualMachine> {
  const owner = cpInstanceId();
  const existing = await VirtualMachine.findOne({ where: { externalId } });
  if (existing) {
    await existing.update({ status: "healthy", ownerCpId: owner });
    return existing;
  }
  return VirtualMachine.create({
    externalId,
    status: "healthy",
    ownerCpId: owner,
  });
}

export async function markVmUnhealthy(externalId: string): Promise<void> {
  const vm = await VirtualMachine.findOne({ where: { externalId } });
  if (!vm) return;
  await vm.update({ status: "unhealthy", ownerCpId: null });
}

/** Create or reactivate sticky assignment; updates memory cache. */
export async function persistAssign(
  threadId: string,
  externalId: string
): Promise<void> {
  const vm = await upsertVmHealthy(externalId);
  const existing = await Assignment.findOne({ where: { threadId } });
  if (existing) {
    await existing.update({ vmId: vm.id, status: "active" });
  } else {
    await Assignment.create({
      threadId,
      vmId: vm.id,
      status: "active",
    });
  }
  assignVmToThread(threadId, externalId);
}

/** Mark assignment completed (or no-op); clears memory cache. */
export async function persistClear(threadId: string): Promise<string | undefined> {
  const active = await Assignment.findOne({
    where: { threadId, status: "active" },
  });
  if (active) {
    await active.update({ status: "completed" });
  }
  return clearThreadAssignment(threadId);
}

export async function listActiveAssignmentsFromDb(): Promise<
  Array<{
    id: string;
    threadId: string;
    status: string;
    vmExternalId: string;
    vmStatus: string;
    ownerCpId: string | null;
    updatedAt: string;
  }>
> {
  const rows = await Assignment.findAll({
    where: { status: "active" },
    include: [{ model: VirtualMachine, as: "vm" }],
    order: [["updatedAt", "DESC"]],
  });
  return rows.map((row) => ({
    id: row.id,
    threadId: row.threadId,
    status: row.status,
    vmExternalId: row.vm?.externalId ?? "(missing)",
    vmStatus: row.vm?.status ?? "(missing)",
    ownerCpId: row.vm?.ownerCpId ?? null,
    updatedAt: row.updatedAt.toISOString(),
  }));
}

export async function listVmsFromDb(): Promise<
  Array<{
    id: string;
    externalId: string;
    status: string;
    ownerCpId: string | null;
    updatedAt: string;
  }>
> {
  const rows = await VirtualMachine.findAll({ order: [["externalId", "ASC"]] });
  return rows.map((row) => ({
    id: row.id,
    externalId: row.externalId,
    status: row.status,
    ownerCpId: row.ownerCpId,
    updatedAt: row.updatedAt.toISOString(),
  }));
}
