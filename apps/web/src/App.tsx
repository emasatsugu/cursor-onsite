import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BrowserServerMessage,
  ThreadSummary,
  TurnMessage,
} from "@poc/shared";
import {
  ApiClientError,
  createThread,
  getThread,
  listThreads,
  postMessage,
} from "./api/client";
import { Composer } from "./components/Composer";
import { ThreadList } from "./components/ThreadList";
import { ThreadView } from "./components/ThreadView";
import {
  applyLiveEvent,
  flattenHistory,
  type DisplayItem,
} from "./lib/display";
import { BrowserSocket } from "./ws/browserSocket";
import "./App.css";

type Banner = { tone: "error" | "info"; text: string } | null;

export default function App() {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftMode, setDraftMode] = useState(true);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [running, setRunning] = useState(false);
  const [banner, setBanner] = useState<Banner>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const socketRef = useRef<BrowserSocket | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const runningGenRef = useRef(0);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  const refreshThreads = useCallback(async () => {
    setThreadsLoading(true);
    try {
      const res = await listThreads();
      setThreads(
        [...res.threads].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        ),
      );
    } catch (err) {
      setBanner({
        tone: "error",
        text: errMessage(err, "Failed to load threads"),
      });
    } finally {
      setThreadsLoading(false);
    }
  }, []);

  const loadThread = useCallback(async (id: string) => {
    setDetailLoading(true);
    setBanner(null);
    try {
      const detail = await getThread(id);
      setItems(flattenHistory(detail.transcripts));
    } catch (err) {
      setBanner({
        tone: "error",
        text: errMessage(err, "Failed to load thread"),
      });
      setItems([]);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // WS lifecycle
  useEffect(() => {
    const socket = new BrowserSocket({
      onMessage: (msg) => handleLiveEvent(msg),
      onError: () => {
        // Connection errors are common when stub/CP isn't up yet
      },
    });
    socketRef.current = socket;
    socket.connect();
    return () => {
      socket.close();
      socketRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleLiveEvent(msg: BrowserServerMessage) {
    if (msg.type === "subscribed") return;

    const threadId = selectedIdRef.current;
    if (!threadId || msg.threadId !== threadId) return;

    setItems((prev) => applyLiveEvent(prev, msg, { threadId }));

    if (msg.type === "agent_loop_done") {
      setRunning(false);
      runningGenRef.current += 1;
      void loadThread(threadId);
      void refreshThreads();
    } else if (msg.type === "agent_loop_error") {
      setRunning(false);
      runningGenRef.current += 1;
      setBanner({ tone: "error", text: msg.error });
    } else if (
      msg.type === "assistant_message" ||
      msg.type === "tool_call_start"
    ) {
      setRunning(true);
    }
  }

  useEffect(() => {
    void refreshThreads();
  }, [refreshThreads]);

  function selectThread(id: string) {
    runningGenRef.current += 1;
    setDraftMode(false);
    setSelectedId(id);
    setRunning(false);
    setBanner(null);
    socketRef.current?.subscribe(id);
    void loadThread(id);
  }

  function startNewThread() {
    runningGenRef.current += 1;
    setDraftMode(true);
    setSelectedId(null);
    setItems([]);
    setRunning(false);
    setBanner(null);
    socketRef.current?.unsubscribe();
  }

  async function handleSend(prompt: string) {
    setBanner(null);
    const gen = ++runningGenRef.current;

    try {
      if (draftMode || !selectedId) {
        setItems([
          { kind: "user", id: `pending-user-${Date.now()}`, content: prompt },
        ]);
        setRunning(true);

        // Assign + start loop first so owner_cp_id is in DB before we subscribe
        // (otherwise proxy may attach to the wrong CP).
        const { thread } = await createThread({ prompt });
        if (gen !== runningGenRef.current) return;
        setDraftMode(false);
        setSelectedId(thread.id);
        selectedIdRef.current = thread.id;
        setThreads((prev) => [thread, ...prev.filter((t) => t.id !== thread.id)]);
        try {
          await socketRef.current?.subscribeReady(thread.id);
        } catch (subErr) {
          console.warn("subscribe after create failed; will poll for completion", subErr);
        }
        if (gen !== runningGenRef.current) return;
        void recoverIfMissedDone(thread.id, gen);
      } else {
        const threadId = selectedId;
        setItems((prev) => [
          ...prev,
          { kind: "user", id: `pending-user-${Date.now()}`, content: prompt },
        ]);
        setRunning(true);
        // POST first: ensures assignment/owner exists, then subscribe to that owner.
        // Subscribe-before-POST raced when the thread had no sticky (wrong CP → miss done).
        const { transcriptId } = await postMessage(threadId, { prompt });
        if (gen !== runningGenRef.current) return;
        try {
          await socketRef.current?.subscribeReady(threadId);
        } catch (subErr) {
          console.warn("subscribe after post failed; will poll for completion", subErr);
        }
        if (gen !== runningGenRef.current) return;
        void recoverIfMissedDone(threadId, gen, transcriptId);
      }
    } catch (err) {
      if (gen !== runningGenRef.current) return;
      setRunning(false);
      if (err instanceof ApiClientError && err.status === 503) {
        setBanner({
          tone: "error",
          text: err.message || "No VM available. Start a VM and try again.",
        });
      } else if (err instanceof ApiClientError && err.status === 409) {
        setBanner({
          tone: "error",
          text: err.message || "A generation is already running for this thread.",
        });
      } else {
        setBanner({
          tone: "error",
          text: errMessage(err, "Failed to send prompt"),
        });
      }
    }
  }

  /**
   * If WS missed agent_loop_done (proxy/CP race), poll history until the turn
   * looks finished, then clear the spinner.
   */
  async function recoverIfMissedDone(
    threadId: string,
    gen: number,
    transcriptId?: string,
  ) {
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (gen !== runningGenRef.current) return;
      if (selectedIdRef.current !== threadId) return;
      try {
        const detail = await getThread(threadId);
        if (gen !== runningGenRef.current) return;
        const turn = transcriptId
          ? detail.transcripts.find((t) => t.id === transcriptId)
          : detail.transcripts[detail.transcripts.length - 1];
        if (turn && turnLooksComplete(turn.messages)) {
          setItems(flattenHistory(detail.transcripts));
          setRunning(false);
          void refreshThreads();
          return;
        }
      } catch {
        /* keep polling */
      }
    }
    if (gen === runningGenRef.current && selectedIdRef.current === threadId) {
      setRunning(false);
      void loadThread(threadId);
    }
  }

  return (
    <div className="app-shell">
      <ThreadList
        threads={threads}
        selectedId={selectedId}
        loading={threadsLoading}
        onSelect={selectThread}
        onNewThread={startNewThread}
      />
      <main className="main">
        <header className="main-header">
          <div>
            <h2>
              {draftMode
                ? "New thread"
                : selectedId
                  ? `Thread ${shortId(selectedId)}`
                  : "Agent Edit"}
            </h2>
            <p className="muted">
              Prompt over HTTP · live events over WebSocket
            </p>
          </div>
          {selectedId && !draftMode && (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => void loadThread(selectedId)}
              disabled={detailLoading || running}
            >
              Refresh
            </button>
          )}
        </header>

        {banner && (
          <div className={`banner ${banner.tone}`} role="alert">
            {banner.text}
            <button
              type="button"
              className="banner-dismiss"
              onClick={() => setBanner(null)}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        <ThreadView
          items={items}
          running={running}
          emptyHint={
            draftMode
              ? "Write a prompt below to create a thread and start the agent."
              : undefined
          }
        />

        <Composer
          disabled={running}
          onSend={handleSend}
          placeholder={
            draftMode
              ? "Describe what to change in the workspace…"
              : "Follow up on this thread…"
          }
        />
      </main>
    </div>
  );
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when the turn ends with a final assistant reply (no pending tool calls). */
function turnLooksComplete(messages: TurnMessage[]): boolean {
  if (messages.length === 0) return false;
  const toolResults = new Set(
    messages
      .filter(
        (m): m is Extract<TurnMessage, { role: "tool" }> => m.role === "tool",
      )
      .map((m) => m.tool_call_id),
  );
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls?.length) {
      for (const tc of m.tool_calls) {
        if (!toolResults.has(tc.id)) return false;
      }
    }
  }
  const last = messages[messages.length - 1];
  return last.role === "assistant" && !last.tool_calls?.length;
}
