import type http from "node:http";
import { loadConfig } from "./config.js";
import { ControlPlaneClient } from "./cpClient.js";
import { startDebugServer } from "./debugServer.js";
import { GitWorkspaceStore } from "./workspaceStore.js";

const config = loadConfig();
const workspaceStore = new GitWorkspaceStore({
  workspaceDir: config.workspaceDir,
  remoteUrl: config.gitRemote,
});

const client = new ControlPlaneClient({
  ...config,
  externalId: config.externalId,
  workspaceStore,
});

console.log("[vm] starting", {
  controlPlaneWsUrl: config.controlPlaneWsUrl,
  workspaceDir: config.workspaceDir,
  heartbeatIntervalMs: config.heartbeatIntervalMs,
  debugPort: config.debugPort,
  externalId: config.externalId,
  gitRemote: config.gitRemote,
  githubToken: process.env.GITHUB_TOKEN ? "set" : "MISSING (push will fail)",
});

client.start();

let debugServer: http.Server | null = null;
if (config.debugPort > 0) {
  debugServer = startDebugServer({
    port: config.debugPort,
    workspaceDir: config.workspaceDir,
    client,
  });
}

function shutdown(signal: string) {
  console.log(`[vm] received ${signal}; shutting down`);
  client.stop();
  debugServer?.close();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
