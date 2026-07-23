/**
 * Smoke test: fake VM + browser WS against a running control plane.
 * Usage: tsx scripts/smoke.ts
 * Requires: control-plane already listening on :3001 with MOCK_OPENAI=1
 */
import WebSocket from "ws";
import { randomUUID } from "node:crypto";

const CP = process.env.CP_HTTP_URL ?? "http://localhost:3001";
const VM_WS = process.env.CP_VM_WS_URL ?? "ws://localhost:3001/ws/vm";
const BR_WS = process.env.CP_BROWSER_WS_URL ?? "ws://localhost:3001/ws/browser";

async function main() {
  const health = await fetch(`${CP}/health`).then((r) => r.json());
  console.log("health", health);

  const externalId = randomUUID();
  const vmEvents: unknown[] = [];
  const browserEvents: unknown[] = [];

  await new Promise<void>((resolve, reject) => {
    const vm = new WebSocket(VM_WS);
    const timeout = setTimeout(() => reject(new Error("timeout")), 30_000);

    vm.on("open", () => {
      vm.send(JSON.stringify({ type: "register", externalId }));
      setInterval(() => {
        if (vm.readyState === WebSocket.OPEN) {
          vm.send(JSON.stringify({ type: "heartbeat", externalId }));
        }
      }, 5000);
    });

    vm.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      vmEvents.push(msg);
      console.log("[vm←]", msg.type, msg);

      if (msg.type === "execute_tool_call") {
        vm.send(
          JSON.stringify({
            type: "tool_call_response",
            toolCallId: msg.toolCallId,
            ok: true,
            result: { content: "# Workspace\nHello from fake VM\n" },
          })
        );
      }
    });

    vm.on("error", reject);

    // Wait a beat for register, then create thread
    setTimeout(async () => {
      try {
        // 503 without VM would fail — we registered
        const createRes = await fetch(`${CP}/threads`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: "Read README.md please" }),
        });
        const createBody = await createRes.json();
        console.log("POST /threads", createRes.status, createBody);
        if (createRes.status !== 201) {
          clearTimeout(timeout);
          reject(new Error(`create failed: ${JSON.stringify(createBody)}`));
          return;
        }

        const threadId = createBody.thread.id as string;
        const br = new WebSocket(BR_WS);
        br.on("open", () => {
          br.send(JSON.stringify({ type: "subscribe", threadId }));
        });
        br.on("message", (data) => {
          const msg = JSON.parse(data.toString());
          browserEvents.push(msg);
          console.log("[browser←]", msg.type, msg.type === "assistant_message" ? msg.delta : "");
          if (msg.type === "agent_loop_done" || msg.type === "agent_loop_error") {
            clearTimeout(timeout);
            setTimeout(async () => {
              const detail = await fetch(`${CP}/threads/${threadId}`).then((r) => r.json());
              console.log("GET thread detail transcripts:", detail.transcripts?.length);
              console.log(
                "messages:",
                JSON.stringify(detail.transcripts?.[0]?.messages, null, 2)
              );

              // concurrent 409
              const again = await fetch(`${CP}/threads/${threadId}/messages`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: "follow up" }),
              });
              // loop should be done so this should be 200; test 409 by overlapping
              console.log("follow-up status", again.status, await again.json());

              // no VM → 503 on new thread: assign already used VM
              const noVm = await fetch(`${CP}/threads`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ prompt: "another" }),
              });
              console.log("second thread (expect 503)", noVm.status, await noVm.json());

              resolve();
              process.exit(0);
            }, 200);
          }
        });
      } catch (e) {
        clearTimeout(timeout);
        reject(e);
      }
    }, 300);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
