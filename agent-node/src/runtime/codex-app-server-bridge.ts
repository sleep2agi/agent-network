// RFC-030 Phase 0 — Minimal bridge for the shared-thread PoC.
//
// The bridge:
//   - Owns a single CodexAppServerClient connection.
//   - Binds one persistent thread (via `thread/resume`).
//   - Maps each Agent Network task_id ↔ one Codex `turnId`.
//   - Filters incoming events to the configured thread and `pendingTurns`
//     the bridge itself created (per RFC §7.5).
//   - Records `waiting_human` when a reverse request arrives, WITHOUT
//     responding — approvals belong to the human TUI (§7.6).
//   - Emits `task_reply` with the final agent text mapped back to the
//     originating `task_id` when its turn completes.
//
// Scope discipline (通信龙): Phase 0 is a PoC only. This bridge deliberately
// does NOT:
//   - Persist a durable ledger (§9 is Phase 2).
//   - Reconnect on transport loss (Phase 1 will add `thread/resume` retry).
//   - Wire into CommHub / cli.ts (§8.4 is Phase 1).
//   - Steer / cancel / interrupt (§7.4 is future scope).
//   - Run a tool proxy (§8.6 later).

import { EventEmitter } from "events";
import { CodexAppServerClient } from "./codex-app-server-client";

// ────────────────────────────────────────────────────────────────────────────
// Public shapes
// ────────────────────────────────────────────────────────────────────────────

export interface CodexAppServerBridgeOptions {
  client: CodexAppServerClient;
  /** Persistent thread ID this bridge binds to (from node config). */
  threadId: string;
  /** Optional label for logs. */
  bridgeLabel?: string;
}

export type BridgeStatus =
  | "connecting"
  | "idle"
  | "working"
  | "waiting_human"
  | "offline";

export interface PendingTurn {
  taskId: string;
  clientUserMessageId: string;
  submittedAt: number;
  turnId?: string;
  agentTextChunks: string[];
}

export interface WaitingApproval {
  reverseRequestId: number;
  method: string;
  params: unknown;
  observedAt: number;
}

// ────────────────────────────────────────────────────────────────────────────
// Bridge
// ────────────────────────────────────────────────────────────────────────────

/**
 * Events:
 *   - "status_changed"    → { previous, current }
 *   - "waiting_human"     → WaitingApproval (bridge did not respond)
 *   - "approval_resolved" → { reverseRequestId } — from serverRequest/resolved
 *   - "task_reply"        → { taskId, text }  — final agent message
 *   - "task_error"        → { taskId, error }
 *   - "cross_thread_drop" → { event } — event for a thread we don't own
 *   - "unowned_turn_drop" → { turnId, event } — turn started outside this bridge
 */
export class CodexAppServerBridge extends EventEmitter {
  private client: CodexAppServerClient;
  private readonly threadId: string;
  private readonly label: string;
  private status: BridgeStatus = "connecting";
  private activeTurnId: string | null = null;
  private pendingTurns = new Map<string, PendingTurn>();
  /** Reverse-request ids we've observed but not resolved (bridge policy). */
  private waitingApprovals = new Map<number, WaitingApproval>();

  constructor(opts: CodexAppServerBridgeOptions) {
    super();
    this.client = opts.client;
    this.threadId = opts.threadId;
    this.label = opts.bridgeLabel ?? `bridge:${this.threadId.slice(0, 8)}`;
    this.attachClientListeners();
  }

  /** Perform initialize → initialized → thread/resume. */
  async bootstrap(): Promise<void> {
    // Initialize handshake per RFC §7.2. The response is not used here beyond
    // ensuring the server accepted us.
    await this.client.request("initialize", {
      clientInfo: {
        name: "anet_codex_bridge",
        title: "Agent Network Codex Bridge",
        version: "0.1.0",
      },
    });
    this.client.notify("initialized", {});
    await this.client.request("thread/resume", { threadId: this.threadId });
    this.setStatus("idle");
  }

  /**
   * Start a turn for an Agent Network task. Returns the turnId the server
   * assigned. The final agent reply is delivered later via `task_reply`.
   */
  async startTaskTurn(input: {
    taskId: string;
    text: string;
    from?: string;
  }): Promise<string> {
    // Bridge discipline: one active turn at a time. Phase 0 queueing lives in
    // the caller (per RFC §6.3 — scheduling is bridge-external for now). If
    // callers race we surface it as an error rather than pretending to queue.
    if (this.activeTurnId) {
      throw new Error(
        `${this.label}: refusing to start turn for task=${input.taskId} while turn=${this.activeTurnId} active`,
      );
    }
    const clientUserMessageId = `anet:${input.taskId}`;
    const promptPrefix = input.from ? `[Agent Network/from=${input.from}/task=${input.taskId}] ` : `[Agent Network/task=${input.taskId}] `;
    const pending: PendingTurn = {
      taskId: input.taskId,
      clientUserMessageId,
      submittedAt: Date.now(),
      agentTextChunks: [],
    };
    // Optimistically claim active so a concurrent call races cleanly.
    this.setStatus("working");

    let resp: unknown;
    try {
      resp = await this.client.request("turn/start", {
        threadId: this.threadId,
        clientUserMessageId,
        input: [{ type: "text", text: promptPrefix + input.text }],
      });
    } catch (e) {
      this.setStatus("idle");
      throw e;
    }
    const turnId = extractTurnId(resp);
    if (!turnId) {
      this.setStatus("idle");
      throw new Error(
        `${this.label}: turn/start response did not include a turnId (task=${input.taskId})`,
      );
    }
    pending.turnId = turnId;
    this.pendingTurns.set(turnId, pending);
    this.activeTurnId = turnId;
    return turnId;
  }

  /** Read-only accessors (for testing / observability). */
  currentStatus(): BridgeStatus {
    return this.status;
  }
  activeTurn(): string | null {
    return this.activeTurnId;
  }
  pendingTurnCount(): number {
    return this.pendingTurns.size;
  }
  isWaitingHuman(): boolean {
    return this.waitingApprovals.size > 0;
  }

  // ──────────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────────

  private attachClientListeners(): void {
    // Notifications we care about (§7.5). We use `.on(method)` rather than
    // parsing a single "notification" stream because the client dispatches
    // notifications on their method name.
    this.client.on("thread/status/changed", (params) => this.onStatusChanged(params));
    this.client.on("turn/started", (params) => this.onTurnStarted(params));
    this.client.on("item/started", (params) => this.onItemStarted(params));
    this.client.on("item/agentMessage/delta", (params) => this.onAgentDelta(params));
    this.client.on("item/completed", (params) => this.onItemCompleted(params));
    this.client.on("turn/completed", (params) => this.onTurnCompleted(params));
    this.client.on("error", (err) => this.emit("client_error", err));
    this.client.on("serverRequest/resolved", (params) => this.onApprovalResolved(params));

    // Reverse requests: approvals must NOT be answered by this bridge.
    this.client.on("reverse_request", (rr: { id: number; method: string; params: unknown }) =>
      this.onReverseRequest(rr),
    );

    this.client.on("close", () => this.setStatus("offline"));
  }

  private onReverseRequest(rr: { id: number; method: string; params: unknown }): void {
    // The set of methods that indicate a human decision. We deliberately
    // widen this to anything that looks like an approval or user-input
    // request, per §7.6. Non-matching reverse requests are still recorded
    // (Phase 0 policy: don't respond to *anything* until a later phase
    // gates specific tool methods through a proxy).
    const waiting: WaitingApproval = {
      reverseRequestId: rr.id,
      method: rr.method,
      params: rr.params,
      observedAt: Date.now(),
    };
    this.waitingApprovals.set(rr.id, waiting);
    this.setStatus("waiting_human");
    this.emit("waiting_human", waiting);
  }

  private onApprovalResolved(params: unknown): void {
    // Server broadcasts `serverRequest/resolved` once *any* subscriber
    // responded. We just clean up our tracking and (if no more approvals
    // are outstanding, and a turn is active) return to working.
    const resolvedId = extractReverseRequestId(params);
    if (resolvedId === null) return;
    if (!this.waitingApprovals.delete(resolvedId)) return;
    this.emit("approval_resolved", { reverseRequestId: resolvedId });
    if (this.waitingApprovals.size === 0) {
      if (this.activeTurnId) this.setStatus("working");
      else this.setStatus("idle");
    }
  }

  private onStatusChanged(_params: unknown): void {
    // Phase 0 relies on the bridge's own accounting (activeTurnId +
    // waitingApprovals) rather than trusting server-reported status. But
    // we still forward as an event for observability.
    this.emit("status_notification", _params);
  }

  private onTurnStarted(params: unknown): void {
    // Filter: turns started by other subscribers (the human TUI) must not
    // touch bridge accounting.
    const p = params as { threadId?: string; turnId?: string };
    if (!p || p.threadId !== this.threadId) {
      this.emit("cross_thread_drop", { event: "turn/started", params });
      return;
    }
    if (!p.turnId) return;
    if (!this.pendingTurns.has(p.turnId)) {
      // A turn we didn't start (§7.5 rule). Emit for observability, but
      // do not touch status or claim ownership.
      this.emit("unowned_turn_drop", { turnId: p.turnId, event: "turn/started" });
      return;
    }
  }

  private onItemStarted(_params: unknown): void {
    // No-op in Phase 0. Real bridge will use item ids to gate approval
    // acceptance in later phases.
  }

  private onAgentDelta(params: unknown): void {
    const p = params as { threadId?: string; turnId?: string; delta?: { text?: string } };
    if (!p || p.threadId !== this.threadId) return;
    if (!p.turnId) return;
    const pending = this.pendingTurns.get(p.turnId);
    if (!pending) return; // Not our turn — human TUI is receiving deltas too.
    if (typeof p.delta?.text === "string") pending.agentTextChunks.push(p.delta.text);
  }

  private onItemCompleted(_params: unknown): void {
    // No-op in Phase 0.
  }

  private onTurnCompleted(params: unknown): void {
    const p = params as {
      threadId?: string;
      turnId?: string;
      finalText?: string;
      error?: { message?: string };
    };
    if (!p || p.threadId !== this.threadId) {
      this.emit("cross_thread_drop", { event: "turn/completed", params });
      return;
    }
    if (!p.turnId) return;
    const pending = this.pendingTurns.get(p.turnId);
    if (!pending) {
      // Human-TUI-initiated turn completed. Absolutely no reply mapping.
      this.emit("unowned_turn_drop", { turnId: p.turnId, event: "turn/completed" });
      return;
    }
    this.pendingTurns.delete(p.turnId);
    if (this.activeTurnId === p.turnId) {
      this.activeTurnId = null;
      this.setStatus(this.waitingApprovals.size > 0 ? "waiting_human" : "idle");
    }
    if (p.error?.message) {
      this.emit("task_error", { taskId: pending.taskId, error: p.error.message });
      return;
    }
    const text = typeof p.finalText === "string" && p.finalText.length > 0
      ? p.finalText
      : pending.agentTextChunks.join("");
    this.emit("task_reply", { taskId: pending.taskId, text });
  }

  private setStatus(next: BridgeStatus): void {
    if (this.status === next) return;
    const previous = this.status;
    this.status = next;
    this.emit("status_changed", { previous, current: next });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Field extractors — defensive against schema drift.
// ────────────────────────────────────────────────────────────────────────────

function extractTurnId(resp: unknown): string | null {
  if (!resp || typeof resp !== "object") return null;
  const r = resp as { turnId?: unknown };
  return typeof r.turnId === "string" ? r.turnId : null;
}

function extractReverseRequestId(params: unknown): number | null {
  if (!params || typeof params !== "object") return null;
  const p = params as { reverseRequestId?: unknown; requestId?: unknown };
  if (typeof p.reverseRequestId === "number") return p.reverseRequestId;
  if (typeof p.requestId === "number") return p.requestId;
  return null;
}
