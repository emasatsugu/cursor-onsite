import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import express from "express";
import cors from "cors";
import { initDb } from "./db/index.js";
import { createHttpRouter } from "./http/routes.js";
import { createBrowserWss, handleBrowserUpgrade } from "./ws/browserServer.js";
import { createVmWss, handleVmUpgrade } from "./ws/vm.js";

// Load .env.example defaults lightly if present (no dotenv dep required)
function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(__dirname, "../.env"));
loadEnvFile(path.join(__dirname, "../.env.example"));

const PORT = Number(process.env.PORT ?? 3001);

async function main(): Promise<void> {
  await initDb();

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
    console.log(
      `[control-plane] MOCK_OPENAI=${process.env.MOCK_OPENAI === "1" || !process.env.OPENAI_API_KEY ? "on" : "off"}`
    );
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
