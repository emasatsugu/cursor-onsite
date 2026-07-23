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
 */
export class BrowserSocket {
  private ws: WebSocket | null = null;
  private subscribedThreadId: string | null = null;
  private handlers: BrowserSocketHandlers;
  private intentionallyClosed = false;

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
      if (!this.intentionallyClosed) {
        // Best-effort reconnect for POC demos
        window.setTimeout(() => this.connect(), 1500);
      }
    };
  }

  subscribe(threadId: string): void {
    this.subscribedThreadId = threadId;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(threadId);
    } else {
      this.connect();
    }
  }

  close(): void {
    this.intentionallyClosed = true;
    this.subscribedThreadId = null;
    this.ws?.close();
    this.ws = null;
  }

  private sendSubscribe(threadId: string): void {
    const msg: BrowserClientMessage = { type: "subscribe", threadId };
    this.ws?.send(JSON.stringify(msg));
  }
}
