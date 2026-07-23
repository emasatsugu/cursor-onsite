import WebSocket from "ws";
import { randomUUID } from "node:crypto";

async function main() {
  const externalId = randomUUID();
  const vm = new WebSocket("ws://localhost:3001/ws/vm");
  await new Promise<void>((r) => vm.on("open", () => r()));
  vm.send(JSON.stringify({ type: "register", externalId }));
  vm.on("message", (d) => {
    const msg = JSON.parse(d.toString());
    if (msg.type === "execute_tool_call") {
      setTimeout(() => {
        vm.send(
          JSON.stringify({
            type: "tool_call_response",
            toolCallId: msg.toolCallId,
            ok: true,
            result: { content: "x" },
          })
        );
      }, 2000);
    }
  });
  await new Promise((r) => setTimeout(r, 200));
  const c = await fetch("http://localhost:3001/threads", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "go" }),
  });
  const body = (await c.json()) as { thread: { id: string } };
  console.log("create", c.status, body.thread?.id);
  const threadId = body.thread.id;
  await new Promise((r) => setTimeout(r, 50));
  const m = await fetch(`http://localhost:3001/threads/${threadId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "overlap" }),
  });
  console.log("concurrent", m.status, await m.json());
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
