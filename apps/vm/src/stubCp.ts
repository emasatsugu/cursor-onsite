/**
 * Minimal stub control plane for solo VM testing.
 * Listens on ws://localhost:3001/ws/vm — accepts register, sends assignment,
 * then a read_file execute_tool_call, and prints the response.
 *
 * Run: npm run stub:cp -w @poc/vm
 * Then in another terminal: npm run start -w @poc/vm
 */
import http from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { VmClientMessage, VmServerMessage } from "@poc/shared";

const PORT = Number(process.env.PORT ?? "3001");

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ ok: true, stub: "cp-vm" }));
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  if (url.pathname !== "/ws/vm") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws: WebSocket) => {
  console.log("[stub-cp] VM connected");
  let registered = false;

  ws.on("message", (data) => {
    let msg: VmClientMessage;
    try {
      msg = JSON.parse(data.toString()) as VmClientMessage;
    } catch {
      console.log("[stub-cp] bad JSON", data.toString());
      return;
    }

    if (msg.type === "register") {
      console.log("[stub-cp] register", msg.externalId);
      registered = true;
      const assignment: VmServerMessage = {
        type: "assignment",
        threadId: "stub-thread-1",
      };
      ws.send(JSON.stringify(assignment));
      console.log("[stub-cp] sent assignment");

      const toolCall: VmServerMessage = {
        type: "execute_tool_call",
        threadId: "stub-thread-1",
        toolCallId: "tc_stub_read_1",
        name: "read_file",
        arguments: { path: "src/hello.js" },
      };
      ws.send(JSON.stringify(toolCall));
      console.log("[stub-cp] sent execute_tool_call read_file");

      // Exercise parallel fan-out: second call overlapping the first.
      const toolCall2: VmServerMessage = {
        type: "execute_tool_call",
        threadId: "stub-thread-1",
        toolCallId: "tc_stub_read_2",
        name: "read_file",
        arguments: { path: "README.md", start_line: 1, end_line: 2 },
      };
      ws.send(JSON.stringify(toolCall2));
      console.log("[stub-cp] sent parallel execute_tool_call read_file #2");
      return;
    }

    if (msg.type === "heartbeat") {
      if (registered) {
        // quiet heartbeats after first
      }
      return;
    }

    if (msg.type === "tool_call_response") {
      console.log(
        "[stub-cp] tool_call_response",
        msg.toolCallId,
        "ok=",
        msg.ok,
        "result=",
        JSON.stringify(msg.result).slice(0, 200),
      );
      return;
    }

    console.log("[stub-cp] unexpected message", msg);
  });

  ws.on("close", () => console.log("[stub-cp] VM disconnected"));
});

server.listen(PORT, () => {
  console.log(`[stub-cp] listening on http://localhost:${PORT} (WS /ws/vm)`);
});
