import WebSocket from "ws";
import type { VmClientMessage, VmServerMessage } from "@poc/shared";
import type { VmConfig } from "./config.js";
import { executeTool } from "./tools/execute.js";
import type { WorkspaceStore } from "./workspaceStore.js";

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
  workspaceStore?: WorkspaceStore;
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
  private readonly workspaceStore: WorkspaceStore | null;
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
    if (!options.externalId?.trim()) {
      throw new Error("externalId is required");
    }
    this.externalId = options.externalId.trim();
    this.workspaceStore = options.workspaceStore ?? null;
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

  async persistWorkspace(message?: string): Promise<void> {
    if (!this.workspaceStore) {
      throw new Error("workspace store not configured");
    }
    if (!this.currentThreadId) {
      throw new Error("no thread assigned — cannot persist");
    }
    await this.workspaceStore.persist(this.currentThreadId, message);
  }

  async restoreWorkspace(threadId?: string): Promise<void> {
    if (!this.workspaceStore) {
      throw new Error("workspace store not configured");
    }
    const id = threadId ?? this.currentThreadId;
    if (!id) {
      throw new Error("threadId required — none assigned");
    }
    await this.workspaceStore.restore(id);
    this.currentThreadId = id;
  }

  /**
   * Simulate unhealthy: stop heartbeats and suppress reconnect.
   * If `disconnect` is true, close the WS immediately; otherwise leave it open
   * so the control plane can observe a heartbeat timeout.
   * If `persist` is true (default), checkpoint the workspace first.
   */
  async simulateUnhealthy(options?: {
    disconnect?: boolean;
    persist?: boolean;
  }): Promise<VmClientDebugStatus> {
    const shouldPersist = options?.persist !== false;
    if (shouldPersist && this.workspaceStore && this.currentThreadId) {
      try {
        await this.workspaceStore.persist(
          this.currentThreadId,
          "persist before unhealthy",
        );
      } catch (err) {
        this.log("persist before unhealthy failed:", err);
      }
    }

    this.heartbeatsEnabled = false;
    this.reconnectEnabled = false;
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.log(
      `simulate unhealthy (disconnect=${Boolean(options?.disconnect)})`,
    );
    if (options?.disconnect && this.ws) {
      this.ws.close();
      this.ws = null;
    }
    return this.getDebugStatus();
  }

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
      if (this.workspaceStore) {
        try {
          await this.workspaceStore.restore(msg.threadId);
        } catch (err) {
          this.log("restore on assignment failed:", err);
        }
      }
      return;
    }

    if (msg.type === "unassign") {
      this.log(`unassign threadId=${msg.threadId}`);
      if (this.currentThreadId === msg.threadId) {
        this.currentThreadId = null;
      }
      return;
    }

    if (msg.type === "persist_request") {
      this.log(`persist_request ${msg.requestId} thread=${msg.threadId}`);
      try {
        if (!this.workspaceStore) {
          throw new Error("workspace store not configured");
        }
        await this.workspaceStore.persist(msg.threadId, `cp persist ${msg.requestId}`);
        this.currentThreadId = msg.threadId;
        this.send({
          type: "persist_response",
          requestId: msg.requestId,
          ok: true,
        });
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        this.log(`persist_request failed:`, error);
        this.send({
          type: "persist_response",
          requestId: msg.requestId,
          ok: false,
          error,
        });
      }
      return;
    }

    if (msg.type === "execute_tool_call") {
      this.log(
        `executing tool ${msg.name} toolCallId=${msg.toolCallId}`,
        preview(msg.arguments),
      );

      // Tool calls carry threadId so persist works even if we missed `assignment`
      // (VM restart, follow-up without re-assign, etc.).
      if (msg.threadId && msg.threadId !== this.currentThreadId) {
        this.currentThreadId = msg.threadId;
        this.log(`threadId from tool call → ${msg.threadId}`);
        if (this.workspaceStore) {
          try {
            await this.workspaceStore.restore(msg.threadId);
          } catch (err) {
            this.log("restore from tool-call threadId failed:", err);
          }
        }
      } else if (msg.threadId) {
        this.currentThreadId = msg.threadId;
      }

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

      // After mutating tools, checkpoint thread branch on the shared remote.
      const mutating =
        msg.name === "write_file" ||
        msg.name === "edit_file" ||
        msg.name === "shell";
      if (!mutating) {
        this.log(`skip persist — tool ${msg.name} is non-mutating`);
      } else if (!ok) {
        this.log(`skip persist — tool ${msg.name} failed`);
      } else if (!this.workspaceStore) {
        this.log("skip persist — no workspace store configured");
      } else if (!this.currentThreadId) {
        this.log("skip persist — no thread assigned yet");
      } else {
        this.log(`persist starting after ${msg.name} thread=${this.currentThreadId}`);
        try {
          await this.workspaceStore.persist(
            this.currentThreadId,
            `tool ${msg.name} ${msg.toolCallId}`,
          );
          this.log(`persist finished after ${msg.name}`);
        } catch (err) {
          this.log("persist after mutating tool failed:", err);
        }
      }
      return;
    }

    this.log("← CP unknown message type:", raw.slice(0, 200));
  }
}
