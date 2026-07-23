import "./env.js"; // must load .env before other modules read process.env
import http from "node:http";
import express from "express";
import cors from "cors";
import { shouldUseMockOpenAI } from "./env.js";
import { initDb } from "./db/index.js";
import { createHttpRouter } from "./http/routes.js";
import { createBrowserWss, handleBrowserUpgrade } from "./ws/browserServer.js";
import { createVmWss, handleVmUpgrade, startVmHeartbeatMonitor } from "./ws/vm.js";
import { startIdleReclaimMonitor, IDLE_RECLAIM_MS } from "./assignment/lifecycle.js";
import {
  clearActiveAssignmentsOnBoot,
  cpInstanceId,
} from "./assignment/store.js";

const PORT = Number(process.env.PORT ?? 3001);

async function main(): Promise<void> {
  await initDb();
  await clearActiveAssignmentsOnBoot();

  const app = express();
  app.use(
    cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
    })
  );
  app.use(express.json({ limit: "2mb" }));
  app.use(createHttpRouter());

  const server = http.createServer(app);
  const browserWss = createBrowserWss();
  const vmWss = createVmWss();
  startVmHeartbeatMonitor();
  startIdleReclaimMonitor();

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (url.pathname === "/ws/browser") {
      handleBrowserUpgrade(browserWss, req, socket, head);
      return;
    }
    if (url.pathname === "/ws/vm") {
      handleVmUpgrade(vmWss, req, socket, head);
      return;
    }
    socket.destroy();
  });

  server.listen(PORT, () => {
    console.log(`[control-plane] HTTP+WS listening on :${PORT}`);
    console.log(`[control-plane] CP_INSTANCE_ID=${cpInstanceId()}`);
    console.log(
      `[control-plane] MOCK_OPENAI=${shouldUseMockOpenAI() ? "on" : "off"}`
    );
    console.log(`[control-plane] IDLE_RECLAIM_MS=${IDLE_RECLAIM_MS}`);
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
