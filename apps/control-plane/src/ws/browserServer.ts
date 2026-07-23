import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { BrowserClientMessage } from "@poc/shared";
import {
  addBrowserSub,
  removeBrowserSubFromAll,
} from "../memory/state.js";
import { maybeReclaimThreads } from "../assignment/lifecycle.js";
import { cpLog } from "../debug/log.js";

/** Open browser sockets (subscribed or not). */
const openBrowserSockets = new Set<WebSocket>();

export function openBrowserSocketCount(): number {
  return openBrowserSockets.size;
}

export function createBrowserWss(): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage) => {
    openBrowserSockets.add(ws);
    cpLog(`browser WS established (open=${openBrowserSockets.size})`);

    let subscribedThreadId: string | null = null;

    ws.on("message", (data) => {
      let msg: BrowserClientMessage;
      try {
        msg = JSON.parse(data.toString()) as BrowserClientMessage;
      } catch {
        cpLog("← browser invalid JSON", data.toString().slice(0, 200));
        return;
      }
      if (msg.type === "subscribe" && typeof msg.threadId === "string") {
        // One socket → one thread. Drop prior subscriptions so idle reclaim works.
        const emptied = removeBrowserSubFromAll(ws);
        addBrowserSub(msg.threadId, ws);
        subscribedThreadId = msg.threadId;
        cpLog(`← browser subscribe thread=${msg.threadId} (exclusive)`);
        maybeReclaimThreads(emptied.filter((id) => id !== msg.threadId));
        // Ack so clients can wait until they are on the right CP (via proxy) before prompting.
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "subscribed", threadId: msg.threadId }));
        }
      } else if (msg.type === "unsubscribe") {
        const emptied = removeBrowserSubFromAll(ws);
        subscribedThreadId = null;
        cpLog("← browser unsubscribe (all threads)");
        maybeReclaimThreads(emptied);
      } else {
        cpLog("← browser unknown message", msg);
      }
    });

    ws.on("close", (code, reasonBuf) => {
      openBrowserSockets.delete(ws);
      const reason = reasonBuf?.toString() || "";
      const thread = subscribedThreadId ?? "(none)";
      const emptied = removeBrowserSubFromAll(ws);
      cpLog(
        `browser WS closed code=${code}` +
          (reason ? ` reason=${reason}` : "") +
          ` thread=${thread} open=${openBrowserSockets.size}`
      );
      maybeReclaimThreads(emptied);
    });

    ws.on("error", (err) => {
      cpLog(`browser WS error: ${err.message}`);
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
