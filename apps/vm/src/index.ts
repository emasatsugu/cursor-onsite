import { loadConfig } from "./config.js";
import { ControlPlaneClient } from "./cpClient.js";

const config = loadConfig();
const client = new ControlPlaneClient(config);

console.log("[vm] starting", {
  controlPlaneWsUrl: config.controlPlaneWsUrl,
  workspaceDir: config.workspaceDir,
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  externalId: client.externalId,
});

client.start();

function shutdown(signal: string) {
  console.log(`[vm] received ${signal}; shutting down`);
  client.stop();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
