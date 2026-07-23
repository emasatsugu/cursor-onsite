import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_GIT_REMOTE } from "./gitRemote.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type VmConfig = {
  controlPlaneWsUrl: string;
  workspaceDir: string;
  heartbeatIntervalMs: number;
  /** Local HTTP port for debug endpoints (0 = disabled). */
  debugPort: number;
  /** Stable id used for CP register/heartbeat — required via VM_EXTERNAL_ID. */
  externalId: string;
  /** Hard-coded GitHub workspace remote (all VMs share this). */
  gitRemote: string;
};

export function resolveExternalId(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.VM_EXTERNAL_ID?.trim();
  if (!fromEnv) {
    throw new Error(
      "VM_EXTERNAL_ID is required (e.g. VM_EXTERNAL_ID=vm-a npm run start:vm)",
    );
  }
  return fromEnv;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VmConfig {
  const workspaceDir = path.resolve(
    env.WORKSPACE_DIR ?? path.join(__dirname, "..", "workspace"),
  );

  return {
    controlPlaneWsUrl: env.CONTROL_PLANE_WS_URL ?? "ws://localhost:3001/ws/vm",
    workspaceDir,
    heartbeatIntervalMs: Number(env.HEARTBEAT_INTERVAL_MS ?? "5000"),
    debugPort: Number(env.DEBUG_PORT ?? "3002"),
    externalId: resolveExternalId(env),
    gitRemote: WORKSPACE_GIT_REMOTE,
  };
}
