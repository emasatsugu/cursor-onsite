import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type { VmClientMessage, VmServerMessage } from "@poc/shared";
import type { VmConfig } from "./config.js";
import { executeTool } from "./tools/execute.js";

function preview(value: unknown, max = 200): string {
  try {
    const s = JSON.stringify(value);
    if (s.length <= max) return s;
    return `${s.slice(0, max)}…`;
  } catch {
    return String(value);
  }
}

export type CpClientOptions = VmConfig & {
  externalId?: string;
  /** Optional logger; defaults to console. */
  log?: (...args: unknown[]) => void;
};

export type VmClientDebugStatus = {
  externalId: string;
  healthy: boolean;
  connected: boolean;
  heartbeatsEnabled: boolean;
  reconnectEnabled: boolean;
  threadId: string | null;
  heartbeatCount: number;
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
  private heartbeatCount = 0;
  /** When false, heartbeats are paused (simulate unhealthy). */
  private heartbeatsEnabled = true;
  /** When false, do not auto-reconnect after close (stays unhealthy). */
  private reconnectEnabled = true;

  constructor(options: CpClientOptions) {
    this.config = options;
    this.externalId = options.externalId ?? randomUUID();
    this.log = options.log ?? ((...args) => console.log("[vm:debug]", ...args));
  }

  get threadId(): string | null {
    return this.currentThreadId;
  }

  getDebugStatus(): VmClientDebugStatus {
    return {
      externalId: this.externalId,
      healthy: this.heartbeatsEnabled && this.reconnectEnabled,
      connected: this.ws?.readyState === WebSocket.OPEN,
      heartbeatsEnabled: this.heartbeatsEnabled,
      reconnectEnabled: this.reconnectEnabled,
      threadId: this.currentThreadId,
      heartbeatCount: this.heartbeatCount,
    };
  }

  /**
   * Simulate unhealthy: stop heartbeats and suppress reconnect.
   * If `disconnect` is true, close the WS immediately; otherwise leave it open
   * so the control plane can observe a heartbeat timeout.
   */
  simulateUnhealthy(options?: { disconnect?: boolean }): VmClientDebugStatus {
    this.heartbeatsEnabled = false;
    this.reconnectEnabled = false;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.log(
      `simulate unhealthy (disconnect=${Boolean(options?.disconnect)})`
    );
    if (options?.disconnect && this.ws) {
      this.ws.close();
      this.ws = null;
    }
    return this.getDebugStatus();
  }

  /**
   * Simulate healthy: resume heartbeats + reconnect; connect if currently down.
   */
  simulateHealthy(): VmClientDebugStatus {
    this.heartbeatsEnabled = true;
    this.reconnectEnabled = true;
    this.log("simulate healthy");
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.startHeartbeat();
    } else {
      this.connect();
    }
    return this.getDebugStatus();
  }

  start(): void {
    this.stopped = false;
    this.heartbeatsEnabled = true;
    this.reconnectEnabled = true;
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
    if (this.stopped || !this.reconnectEnabled || this.reconnectTimer) return;
    this.log("scheduling reconnect in 2000ms");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 2000);
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    if (!this.heartbeatsEnabled) {
      this.log("heartbeats suppressed (unhealthy mode)");
      return;
    }
    this.heartbeatCount = 0;
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatCount += 1;
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
      this.log("→ CP DROPPED (socket not open):", msg.type);
      return;
    }
    if (msg.type === "heartbeat") {
      this.log(`→ CP heartbeat #${this.heartbeatCount} externalId=${msg.externalId}`);
    } else {
      this.log(`→ CP ${msg.type}`, preview(msg));
    }
    this.ws.send(JSON.stringify(msg));
  }

  private async onMessage(raw: string): Promise<void> {
    let msg: VmServerMessage;
    try {
      msg = JSON.parse(raw) as VmServerMessage;
    } catch {
      this.log("← CP invalid JSON:", raw.slice(0, 200));
      return;
    }

    this.log(`← CP ${msg.type}`, preview(msg));

    if (msg.type === "assignment") {
      this.currentThreadId = msg.threadId;
      this.log(`assignment stored threadId=${msg.threadId}`);
      return;
    }

    if (msg.type === "execute_tool_call") {
      this.log(
        `executing tool ${msg.name} toolCallId=${msg.toolCallId}`,
        preview(msg.arguments),
      );
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
      this.log(`tool finished toolCallId=${msg.toolCallId} ok=${ok}`, preview(result));
      return;
    }

    this.log("← CP unknown message type:", raw.slice(0, 200));
  }
}
