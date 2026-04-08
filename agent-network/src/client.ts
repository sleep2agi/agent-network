/**
 * @sleep2agi/commhub-sdk
 *
 * CommHub 通信 SDK — 一个文件，SSE 长连接 + 自动重连 + 心跳。
 * 支持 Node.js 18+ 和 Bun。
 */

import { EventEmitter } from "events";
import { hostname as osHostname } from "os";

// ── Types ──

export interface CommHubOptions {
  /** CommHub Server URL, e.g. "http://YOUR_COMMHUB_IP:9200" */
  url: string;
  /** Session alias, e.g. "SDK马" */
  alias: string;
  /** Auth token (optional) */
  token?: string;
  /** Agent type for registration (default: "sdk") */
  agent?: string;
  /** Heartbeat interval in ms (default: 180000 = 3 min) */
  heartbeatInterval?: number;
  /** SSE reconnect base delay in ms (default: 3000) */
  reconnectDelay?: number;
  /** Auto-connect on creation (default: true) */
  autoConnect?: boolean;
}

export interface InboxMessage {
  id: string;
  content: string;
  from_session: string;
  priority: string;
  created_at: string;
}

export interface CommHubEvents {
  task: (msg: InboxMessage) => void;
  message: (msg: InboxMessage) => void;
  connected: () => void;
  disconnected: () => void;
  error: (err: Error) => void;
}

// ── CommHub Class ──

export class CommHub extends EventEmitter {
  private url: string;
  private alias: string;
  private token?: string;
  private agent: string;
  private resumeId: string;
  private heartbeatInterval: number;
  private reconnectDelay: number;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private sseAbort?: AbortController;
  private running = false;

  constructor(opts: CommHubOptions) {
    super();
    this.url = opts.url.replace(/\/$/, "");
    this.alias = opts.alias;
    this.token = opts.token;
    this.agent = opts.agent || "sdk";
    this.resumeId = `sdk-${opts.alias}-${Date.now().toString(36)}`;
    this.heartbeatInterval = opts.heartbeatInterval ?? 3 * 60 * 1000;
    this.reconnectDelay = opts.reconnectDelay ?? 3000;

    if (opts.autoConnect !== false) {
      this.connect();
    }
  }

  private log(msg: string) {
    console.log(`[${new Date().toTimeString().slice(0, 8)}] [commhub:${this.alias}] ${msg}`);
  }

  // ── MCP JSON-RPC call ──

  private async call(tool: string, args: Record<string, unknown>): Promise<any> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

    const res = await fetch(`${this.url}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: tool, arguments: args },
      }),
    });

    const data = (await res.json()) as any;
    const text = data?.result?.content?.[0]?.text;
    return text ? JSON.parse(text) : data;
  }

  // ── Public API ──

  /** Connect to CommHub: register + start SSE + heartbeat */
  async connect() {
    if (this.running) return;
    this.running = true;

    // Register
    await this.status("idle");
    this.log("registered");

    // Heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.status("idle").catch((e) => this.log(`heartbeat failed: ${e.message}`));
    }, this.heartbeatInterval);

    // SSE
    this.connectSSE();
  }

  /** Disconnect: stop SSE + heartbeat, report offline */
  async disconnect() {
    this.running = false;
    this.sseAbort?.abort();
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    await this.status("offline").catch(() => {});
    this.log("disconnected");
  }

  /** Send a task to another session */
  async send(targetAlias: string, content: string, priority: "high" | "normal" | "low" = "normal") {
    return this.call("send_task", {
      alias: targetAlias,
      task: content,
      priority,
      from_session: this.alias,
    });
  }

  /** Send a message (no task lifecycle) */
  async message(targetAlias: string, content: string) {
    return this.call("send_message", {
      alias: targetAlias,
      message: content,
      from_session: this.alias,
    });
  }

  /** Reply to a task (update status) */
  async reply(taskId: string, text: string, status: "completed" | "blocked" | "error" | "in_progress" = "completed") {
    return this.call("reply", { task_id: taskId, text, status });
  }

  /** Update session status */
  async status(state: string, extra?: { task?: string; progress?: number }) {
    return this.call("report_status", {
      resume_id: this.resumeId,
      alias: this.alias,
      status: state,
      server: osHostname(),
      hostname: osHostname(),
      agent: this.agent,
      project_dir: process.cwd(),
      ...extra,
    });
  }

  /** Get all session statuses */
  async getAllStatus() {
    return this.call("get_all_status", {});
  }

  /** Broadcast to all sessions */
  async broadcast(content: string, filter?: { server?: string; status?: string }) {
    return this.call("broadcast", {
      message: content,
      filter_server: filter?.server,
      filter_status: filter?.status,
    });
  }

  // ── SSE long connection ──

  private async connectSSE() {
    const encodedAlias = encodeURIComponent(this.alias);
    const sseUrl = `${this.url}/events/${encodedAlias}`;
    let delay = this.reconnectDelay;

    while (this.running) {
      try {
        this.sseAbort = new AbortController();
        const headers: Record<string, string> = { Accept: "text/event-stream" };
        if (this.token) headers["Authorization"] = `Bearer ${this.token}`;

        const res = await fetch(sseUrl, { headers, signal: this.sseAbort.signal });

        if (!res.ok || !res.body) {
          this.log(`SSE failed: ${res.status}`);
          await this.sleep(delay);
          delay = Math.min(delay * 1.5, 60_000);
          continue;
        }

        delay = this.reconnectDelay;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (this.running) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;

            try {
              const event = JSON.parse(line.slice(6));

              if (event.type === "connected") {
                this.log("SSE connected");
                this.emit("connected");
                continue;
              }

              if (event.type === "new_task" || event.type === "new_message" || event.type === "broadcast") {
                await this.processInbox();
              }
            } catch {
              // ignore non-JSON (keepalive comments etc)
            }
          }
        }
      } catch (err: any) {
        if (err.name === "AbortError") break;
        this.emit("error", err);
        this.log(`SSE error: ${err.message}`);
      }

      if (this.running) {
        this.emit("disconnected");
        this.log(`SSE reconnecting in ${delay / 1000}s...`);
        await this.sleep(delay);
        delay = Math.min(delay * 1.5, 60_000);
      }
    }
  }

  private async processInbox() {
    try {
      const result = await this.call("get_inbox", { alias: this.alias, limit: 10 });
      const messages: InboxMessage[] = result?.messages || [];

      for (const msg of messages) {
        // ACK
        await this.call("ack_inbox", { alias: this.alias, message_id: msg.id });

        // Emit event
        this.log(`← ${msg.from_session}: ${msg.content.slice(0, 60)}`);
        this.emit("task", msg);
        this.emit("message", msg);
      }
    } catch (err: any) {
      this.log(`inbox error: ${err.message}`);
    }
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

export default CommHub;
