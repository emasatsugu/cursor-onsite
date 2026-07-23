import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { BrowserClientMessage } from "@poc/shared";
import { addBrowserSub, removeBrowserSubFromAll } from "../memory/state.js";

export function createBrowserWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    ws.on("message", (data) => {
      let msg: BrowserClientMessage;
      try {
        msg = JSON.parse(data.toString()) as BrowserClientMessage;
      } catch {
        return;
      }
      if (msg.type === "subscribe" && typeof msg.threadId === "string") {
        addBrowserSub(msg.threadId, ws);
      }
    });

    ws.on("close", () => {
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
