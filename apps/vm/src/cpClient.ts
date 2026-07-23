import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { VmClientMessage, VmServerMessage } from "@poc/shared";
import type { VmConfig } from "./config.js";
import { executeTool } from "./tools/execute.js";

export type CpClientOptions = VmConfig & {
  externalId?: string;
  /** Optional logger; defaults to console. */
  log?: (...args: unknown[]) => void;
};

export class ControlPlaneClient {
  readonly externalId: string;
  private readonly config: VmConfig;
  private readonly log: (...args: unknown[]) => void;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private currentThreadId: string | null = null;

  constructor(options: CpClientOptions) {
    this.config = options;
    this.externalId = options.externalId ?? randomUUID();
    this.log = options.log ?? ((...args) => console.log("[vm]", ...args));
  }

  get threadId(): string | null {
    return this.currentThreadId;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    this.log(`connecting to ${this.config.controlPlaneWsUrl}`);
    const ws = new WebSocket(this.config.controlPlaneWsUrl);
    this.ws = ws;

    ws.on("open", () => {
      this.log(`connected; registering as ${this.externalId}`);
      this.send({ type: "register", externalId: this.externalId });
      this.startHeartbeat();
    });

    ws.on("message", (data) => {
      void this.onMessage(data.toString());
    });

    ws.on("close", () => {
      this.log("connection closed");
      this.clearHeartbeat();
      this.ws = null;
      this.scheduleReconnect();
    });

    ws.on("error", (err) => {
      this.log("ws error:", err.message);
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: "heartbeat", externalId: this.externalId });
    }, this.config.heartbeatIntervalMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private send(msg: VmClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log("cannot send; socket not open:", msg.type);
      return;
    }
    this.ws.send(JSON.stringify(msg));
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: VmServerMessage;
    try {
      msg = JSON.parse(raw) as VmServerMessage;
    } catch {
      this.log("invalid JSON from CP:", raw);
      return;
    }

    if (msg.type === "assignment") {
      this.currentThreadId = msg.threadId;
      this.log(`assignment received for thread ${msg.threadId}`);
      return;
    }

    if (msg.type === "execute_tool_call") {
      this.log(
        `execute_tool_call ${msg.toolCallId} name=${msg.name}`,
      );
      // Parallel tool calls each get their own response with matching toolCallId.
      const { ok, result } = await executeTool(
        this.config.workspaceDir,
        msg.name,
        msg.arguments,
      );
      this.send({
        type: "tool_call_response",
        toolCallId: msg.toolCallId,
        ok,
        result,
      });
      this.log(`tool_call_response ${msg.toolCallId} ok=${ok}`);
      return;
    }

    this.log("unknown message from CP:", raw);
  }
}
