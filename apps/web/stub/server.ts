/**
 * Tiny control-plane stub for Component A solo testing.
 * Implements HTTP + browser WS contracts from implementation-edd.md.
 *
 * Run: npm run stub -w @poc/web
 * Then: npm run dev -w @poc/web
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  BrowserClientMessage,
  BrowserServerMessage,
  ThreadDetail,
  ThreadSummary,
  TranscriptBlob,
  TranscriptDTO,
} from "@poc/shared";

const PORT = Number(process.env.PORT || 3001);
const DEMO_USER_ID = "demo-user";

type ThreadRecord = ThreadSummary & {
  transcripts: Array<TranscriptDTO & { messages: TranscriptBlob }>;
};

const threads = new Map<string, ThreadRecord>();
const browserSubs = new Map<string, Set<WebSocket>>();
const runningLoops = new Set<string>();

function sendJson(res: ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  });
  res.end(data);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function broadcast(threadId: string, msg: BrowserServerMessage) {
  const subs = browserSubs.get(threadId);
  if (!subs) return;
  const raw = JSON.stringify(msg);
  for (const ws of subs) {
    if (ws.readyState === ws.OPEN) ws.send(raw);
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runFakeAgentLoop(threadId: string, transcriptId: string, prompt: string) {
  runningLoops.add(threadId);
  const thread = threads.get(threadId);
  if (!thread) {
    runningLoops.delete(threadId);
    return;
  }

  const transcript = thread.transcripts.find((t) => t.id === transcriptId);
  if (!transcript) {
    runningLoops.delete(threadId);
    return;
  }

  try {
    if (prompt.includes("[error]")) {
      await sleep(200);
      broadcast(threadId, {
        type: "agent_loop_error",
        threadId,
        transcriptId,
        error: "Stub simulated agent_loop_error",
      });
      return;
    }

    const chunks = [
      "I'll look at the workspace and make a small change.\n\n",
      "Reading `src/hello.js`…",
    ];
    let assistantText = "";
    for (const delta of chunks) {
      assistantText += delta;
      broadcast(threadId, {
        type: "assistant_message",
        threadId,
        transcriptId,
        delta,
      });
      await sleep(120);
    }

    const toolCallId = `call_${randomUUID().slice(0, 8)}`;
    const args = JSON.stringify({ path: "src/hello.js" });
    broadcast(threadId, {
      type: "tool_call_start",
      threadId,
      transcriptId,
      toolCallId,
      name: "read_file",
      arguments: args,
    });

    transcript.messages.push({
      role: "assistant",
      content: assistantText,
      tool_calls: [
        {
          id: toolCallId,
          type: "function",
          function: { name: "read_file", arguments: args },
        },
      ],
    });

    await sleep(250);
    const result = JSON.stringify({
      content: 'console.log("hello from workspace");\n',
    });
    broadcast(threadId, {
      type: "tool_call_result",
      threadId,
      transcriptId,
      toolCallId,
      result,
    });
    transcript.messages.push({
      role: "tool",
      tool_call_id: toolCallId,
      content: result,
    });

    const finalChunks = [
      "\n\nDone — file contents look good. ",
      "(This was a stubbed control-plane response.)",
    ];
    let finalText = "";
    for (const delta of finalChunks) {
      finalText += delta;
      broadcast(threadId, {
        type: "assistant_message",
        threadId,
        transcriptId,
        delta,
      });
      await sleep(100);
    }
    transcript.messages.push({ role: "assistant", content: finalText });

    broadcast(threadId, {
      type: "agent_loop_done",
      threadId,
      transcriptId,
    });
  } catch (err) {
    broadcast(threadId, {
      type: "agent_loop_error",
      threadId,
      transcriptId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    runningLoops.delete(threadId);
  }
}

async function handleHttp(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const { pathname } = url;

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/threads") {
    const list = [...threads.values()]
      .map(({ id, userId, createdAt }) => ({ id, userId, createdAt }))
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    sendJson(res, 200, { threads: list });
    return;
  }

  const threadMatch = pathname.match(/^\/threads\/([^/]+)$/);
  if (req.method === "GET" && threadMatch) {
    const thread = threads.get(threadMatch[1]);
    if (!thread) {
      sendJson(res, 404, { error: "Thread not found" });
      return;
    }
    const detail: ThreadDetail = {
      id: thread.id,
      userId: thread.userId,
      createdAt: thread.createdAt,
      transcripts: thread.transcripts.map((t) => ({
        id: t.id,
        threadId: t.threadId,
        createdAt: t.createdAt,
        messages: t.messages,
      })),
    };
    sendJson(res, 200, detail);
    return;
  }

  if (req.method === "POST" && pathname === "/threads") {
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}") as { prompt?: string };
    const prompt = (body.prompt || "").trim();
    if (!prompt) {
      sendJson(res, 400, { error: "prompt is required" });
      return;
    }
    if (prompt.includes("[no-vm]")) {
      sendJson(res, 503, { error: "No healthy unassigned VM available" });
      return;
    }

    const threadId = randomUUID();
    const transcriptId = randomUUID();
    const createdAt = new Date().toISOString();
    const record: ThreadRecord = {
      id: threadId,
      userId: DEMO_USER_ID,
      createdAt,
      transcripts: [
        {
          id: transcriptId,
          threadId,
          createdAt,
          messages: [{ role: "user", content: prompt }],
        },
      ],
    };
    threads.set(threadId, record);
    sendJson(res, 201, {
      thread: { id: threadId, userId: DEMO_USER_ID, createdAt },
    });
    void runFakeAgentLoop(threadId, transcriptId, prompt);
    return;
  }

  const msgMatch = pathname.match(/^\/threads\/([^/]+)\/messages$/);
  if (req.method === "POST" && msgMatch) {
    const threadId = msgMatch[1];
    const thread = threads.get(threadId);
    if (!thread) {
      sendJson(res, 404, { error: "Thread not found" });
      return;
    }
    if (runningLoops.has(threadId)) {
      sendJson(res, 409, { error: "Generation already running for this thread" });
      return;
    }
    const raw = await readBody(req);
    const body = JSON.parse(raw || "{}") as { prompt?: string };
    const prompt = (body.prompt || "").trim();
    if (!prompt) {
      sendJson(res, 400, { error: "prompt is required" });
      return;
    }

    const transcriptId = randomUUID();
    const createdAt = new Date().toISOString();
    thread.transcripts.push({
      id: transcriptId,
      threadId,
      createdAt,
      messages: [{ role: "user", content: prompt }],
    });
    sendJson(res, 200, { transcriptId });
    void runFakeAgentLoop(threadId, transcriptId, prompt);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = createServer((req, res) => {
  void handleHttp(req, res).catch((err) => {
    console.error(err);
    sendJson(res, 500, { error: "Internal stub error" });
  });
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  if (url.pathname !== "/ws/browser") {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  let subscribed: string | null = null;

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data)) as BrowserClientMessage;
      if (msg.type === "subscribe" && msg.threadId) {
        if (subscribed) {
          browserSubs.get(subscribed)?.delete(ws);
        }
        subscribed = msg.threadId;
        if (!browserSubs.has(subscribed)) browserSubs.set(subscribed, new Set());
        browserSubs.get(subscribed)!.add(ws);
        ws.send(JSON.stringify({ type: "subscribed", threadId: msg.threadId }));
      }
    } catch (err) {
      console.warn("bad browser WS message", err);
    }
  });

  ws.on("close", () => {
    if (subscribed) browserSubs.get(subscribed)?.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`[stub-cp] HTTP+WS listening on http://localhost:${PORT}`);
  console.log(`[stub-cp] Browser WS path: ws://localhost:${PORT}/ws/browser`);
  console.log(`[stub-cp] Tips: prompt containing [no-vm] → 503; [error] → agent_loop_error`);
});
