import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type VmConfig = {
  controlPlaneWsUrl: string;
  workspaceDir: string;
  heartbeatIntervalMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): VmConfig {
  const workspaceDir = path.resolve(
    env.WORKSPACE_DIR ?? path.join(__dirname, "..", "workspace"),
  );

  return {
    controlPlaneWsUrl: env.CONTROL_PLANE_WS_URL ?? "ws://localhost:3001/ws/vm",
    workspaceDir,
    heartbeatIntervalMs: Number(env.HEARTBEAT_INTERVAL_MS ?? "5000"),
  };
}
