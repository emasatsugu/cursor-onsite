import type { BrowserClientMessage, BrowserServerMessage } from "@poc/shared";

const WS_URL =
  import.meta.env.VITE_CP_WS_URL || "ws://localhost:3001/ws/browser";

export type BrowserSocketHandlers = {
  onMessage?: (msg: BrowserServerMessage) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (event: Event) => void;
};

/**
 * Browser ↔ CP WebSocket helper.
 * Connect once, then `subscribe(threadId)` when opening a thread.
 * Prompts stay on HTTP; this socket is subscribe-only for streaming.
 *
 * Prefer `await subscribeReady(threadId)` after HTTP create/message so the
 * proxy has an owner in DB and attaches to the right CP (avoids missing
 * `agent_loop_done`).
 */
export class BrowserSocket {
  private ws: WebSocket | null = null;
  private subscribedThreadId: string | null = null;
  private handlers: BrowserSocketHandlers;
  private intentionallyClosed = false;
  /** Coalesce concurrent subscribeReady calls for the same thread. */
  private inflight: { threadId: string; promise: Promise<void> } | null = null;
  private pendingSubscribe: {
    threadId: string;
    resolve: () => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(handlers: BrowserSocketHandlers = {}) {
    this.handlers = handlers;
  }

  connect(): void {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.intentionallyClosed = false;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.handlers.onOpen?.();
      if (this.subscribedThreadId) {
        this.sendSubscribe(this.subscribedThreadId);
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(String(event.data)) as BrowserServerMessage;
        if (msg.type === "subscribed") {
          const pending = this.pendingSubscribe;
          if (pending && pending.threadId === msg.threadId) {
            clearTimeout(pending.timer);
            this.pendingSubscribe = null;
            pending.resolve();
          }
        }
        this.handlers.onMessage?.(msg);
      } catch (err) {
        console.warn("Failed to parse browser WS message", err);
      }
    };

    ws.onerror = (event) => {
      this.handlers.onError?.(event);
    };

    ws.onclose = () => {
      this.handlers.onClose?.();
      this.ws = null;
      if (this.pendingSubscribe) {
        clearTimeout(this.pendingSubscribe.timer);
        this.pendingSubscribe.reject(
          new Error("WebSocket closed during subscribe"),
        );
        this.pendingSubscribe = null;
      }
      this.inflight = null;
      if (!this.intentionallyClosed) {
        window.setTimeout(() => this.connect(), 1500);
      }
    };
  }

  /** Fire-and-forget subscribe (e.g. when selecting a thread in the sidebar). */
  subscribe(threadId: string): void {
    void this.subscribeReady(threadId).catch(() => {
      /* sidebar select — non-fatal */
    });
  }

  /**
   * Subscribe and wait for `subscribed` ack (from proxy and/or CP).
   * Concurrent calls for the same threadId share one in-flight promise.
   */
  subscribeReady(threadId: string, timeoutMs = 8_000): Promise<void> {
    if (this.inflight?.threadId === threadId) {
      return this.inflight.promise;
    }

    this.subscribedThreadId = threadId;

    if (this.pendingSubscribe && this.pendingSubscribe.threadId !== threadId) {
      clearTimeout(this.pendingSubscribe.timer);
      this.pendingSubscribe.reject(new Error("subscribe superseded"));
      this.pendingSubscribe = null;
    }

    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingSubscribe?.threadId === threadId) {
          this.pendingSubscribe = null;
          reject(new Error(`subscribe timeout for ${threadId}`));
        }
      }, timeoutMs);

      this.pendingSubscribe = { threadId, resolve, reject, timer };

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.sendSubscribe(threadId);
      } else {
        this.connect();
      }
    }).finally(() => {
      if (this.inflight?.threadId === threadId) {
        this.inflight = null;
      }
    });

    this.inflight = { threadId, promise };
    return promise;
  }

  /** Leave all thread subscriptions (e.g. draft / new-thread mode). */
  unsubscribe(): void {
    this.subscribedThreadId = null;
    this.inflight = null;
    if (this.pendingSubscribe) {
      clearTimeout(this.pendingSubscribe.timer);
      this.pendingSubscribe.reject(new Error("unsubscribed"));
      this.pendingSubscribe = null;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      const msg: BrowserClientMessage = { type: "unsubscribe" };
      this.ws.send(JSON.stringify(msg));
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.subscribedThreadId = null;
    this.inflight = null;
    if (this.pendingSubscribe) {
      clearTimeout(this.pendingSubscribe.timer);
      this.pendingSubscribe = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  private sendSubscribe(threadId: string): void {
    const msg: BrowserClientMessage = { type: "subscribe", threadId };
    this.ws?.send(JSON.stringify(msg));
  }
}
