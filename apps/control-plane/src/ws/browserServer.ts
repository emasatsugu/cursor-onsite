import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { BrowserClientMessage } from "@poc/shared";
import { addBrowserSub, removeBrowserSubFromAll } from "../memory/state.js";
import { cpLog } from "../debug/log.js";

export function createBrowserWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    cpLog("browser socket connected");

    ws.on("message", (data) => {
      let msg: BrowserClientMessage;
      try {
        msg = JSON.parse(data.toString()) as BrowserClientMessage;
      } catch {
        cpLog("← browser invalid JSON", data.toString().slice(0, 200));
        return;
      }
      if (msg.type === "subscribe" && typeof msg.threadId === "string") {
        addBrowserSub(msg.threadId, ws);
        cpLog(`← browser subscribe thread=${msg.threadId}`);
      } else {
        cpLog("← browser unknown message", msg);
      }
    });

    ws.on("close", () => {
      cpLog("browser socket closed");
      removeBrowserSubFromAll(ws);
    });
  });

  return wss;
}

export function handleBrowserUpgrade(
  wss: WebSocketServer,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer
): void {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
}
