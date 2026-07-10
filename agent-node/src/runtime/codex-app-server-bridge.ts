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
  /**
   * Persistent thread ID this bridge binds to (from node config). Leave
   * empty/undefined to have `bootstrap()` create a fresh thread and adopt
   * its id (network-runtime mode, where the bridge owns the thread). A
   * non-empty id is resumed; if the resume fails because the thread has no
   * persisted rollout yet, bootstrap falls back to creating a new one.
   */
  threadId?: string;
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
  private threadId: string;
  private readonly label: string;
  private status: BridgeStatus = "connecting";
  private activeTurnId: string | null = null;
  /**
   * Synchronous claim taken BEFORE the `turn/start` RPC round-trip.
   * `activeTurnId` alone is insufficient as a mutual-exclusion guard: it is
   * only assigned after the server responds, so two concurrent
   * `startTaskTurn` calls could both pass the `activeTurnId === null` check
   * and double-start (通信龙 review finding #1).
   */
  private turnClaimed = false;
  private pendingTurns = new Map<string, PendingTurn>();
  /** Reverse-request ids we've observed but not resolved (bridge policy). */
  private waitingApprovals = new Map<number, WaitingApproval>();
  /**
   * FIFO of tasks waiting for the thread to go idle (通信龙 review finding #2;
   * RFC §6.3 — Phase 0 gate requires the second concurrent task to queue
   * stably rather than error). Drained on turn completion/error.
   */
  private taskQueue: Array<{ taskId: string; text: string; from?: string }> = [];
  private draining = false;

  constructor(opts: CodexAppServerBridgeOptions) {
    super();
    this.client = opts.client;
    this.threadId = opts.threadId ?? "";
    this.label = opts.bridgeLabel ?? `bridge:${(this.threadId || "new").slice(0, 8)}`;
    this.attachClientListeners();
  }

  /** The thread this bridge is bound to (final id after bootstrap adoption). */
  getThreadId(): string {
    return this.threadId;
  }

  /**
   * Perform initialize → initialized → (thread/resume | thread/start).
   *
   * REAL-WIRE CORRECTION (通信龙, verified against codex-cli 0.144.0 live
   * two-client PoC): `initialize` is scoped to the **app-server**, NOT to
   * each connection. When the human TUI (`codex --remote`) has already
   * initialized the shared server, a second client's `initialize` returns
   * `-32600: Already initialized`. RFC §7.2's "每个连接必须单独初始化" is
   * wrong for the shared-server topology — the bridge tolerates an
   * already-initialized server and proceeds straight to thread binding.
   *
   * Thread binding is create-or-resume (mirrors the opencode runtime's
   * session/load-else-new):
   *   - empty threadId → thread/start, adopt the returned id.
   *   - non-empty threadId → thread/resume; if that fails because the
   *     thread has no persisted rollout yet ("no rollout found"), fall
   *     back to thread/start so a stale/never-persisted id can't wedge
   *     the node at boot.
   * Emits "thread_ready" { threadId, created } so the runtime can persist
   * a freshly-created id back to node config.
   */
  async bootstrap(): Promise<void> {
    try {
      await this.client.request("initialize", {
        clientInfo: {
          name: "anet_codex_bridge",
          title: "Agent Network Codex Bridge",
          version: "0.1.0",
        },
      });
      this.client.notify("initialized", {});
    } catch (e) {
      if (!isAlreadyInitialized(e)) throw e;
      // Shared server already initialized by the human TUI — expected in the
      // second-client bridge role. Do NOT re-send `initialized`.
    }

    let created = false;
    if (this.threadId) {
      try {
        await this.client.request("thread/resume", { threadId: this.threadId });
      } catch (e) {
        if (!isNoRollout(e)) throw e;
        // Persisted id never got a rollout (e.g. node created but never ran
        // a turn) — create a fresh thread rather than wedging at boot.
        this.threadId = await this.startNewThread();
        created = true;
      }
    } else {
      this.threadId = await this.startNewThread();
      created = true;
    }

    this.emit("thread_ready", { threadId: this.threadId, created });
    this.setStatus("idle");
  }

  private async startNewThread(): Promise<string> {
    const started = await this.client.request<{
      threadId?: string;
      thread?: { id?: string };
    }>("thread/start", {});
    const id = started?.threadId ?? started?.thread?.id;
    if (!id) {
      throw new Error(
        "thread/start returned no threadId: " + JSON.stringify(started).slice(0, 200),
      );
    }
    return id;
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
    // Bridge discipline: one active turn at a time. The claim is taken
    // SYNCHRONOUSLY (before any await) so concurrent callers race cleanly:
    // exactly one proceeds, the rest throw. Queueing callers should use
    // `submitTask()` instead of this low-level primitive.
    if (this.turnClaimed || this.activeTurnId) {
      throw new Error(
        `${this.label}: refusing to start turn for task=${input.taskId} while turn=${this.activeTurnId ?? "(starting)"} active`,
      );
    }
    this.turnClaimed = true;
    const clientUserMessageId = `anet:${input.taskId}`;
    const fromLabel = displaySender(input.from);
    const promptPrefix = fromLabel ? `[Agent Network/from=${fromLabel}/task=${input.taskId}] ` : `[Agent Network/task=${input.taskId}] `;
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
      this.turnClaimed = false;
      this.setStatus("idle");
      throw e;
    }
    const turnId = extractTurnId(resp);
    if (!turnId) {
      this.turnClaimed = false;
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

  /**
   * Queueing entry point (Phase 0 gate: "两个 Agent 同时派 task，只创建一个
   * active turn，另一个稳定排队"). If the thread is free the task starts
   * immediately; otherwise it joins a FIFO drained on turn completion/error.
   *
   * Human-priority note (§6.1): the bridge only ever starts a turn when the
   * shared thread is idle from ITS point of view; if the human TUI wins the
   * idle race, `turn/start` fails with an active-turn error and the task is
   * requeued at the FRONT (original order preserved) — the app-server is the
   * authority (§6.3).
   */
  async submitTask(input: { taskId: string; text: string; from?: string }): Promise<
    { started: true; turnId: string } | { started: false; queuedAt: number }
  > {
    if (this.turnClaimed || this.activeTurnId || this.taskQueue.length > 0) {
      this.taskQueue.push(input);
      this.emit("task_queued", { taskId: input.taskId, depth: this.taskQueue.length });
      return { started: false, queuedAt: this.taskQueue.length };
    }
    const turnId = await this.startTaskTurn(input);
    return { started: true, turnId };
  }

  /** Drain the FIFO after a turn finishes. One task per idle transition. */
  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    if (this.turnClaimed || this.activeTurnId) return;
    const next = this.taskQueue.shift();
    if (!next) return;
    this.draining = true;
    try {
      await this.startTaskTurn(next);
    } catch (e) {
      // Lost the idle race to the human TUI (or transport error). Requeue at
      // the FRONT to preserve order; retry on the next idle transition.
      this.taskQueue.unshift(next);
      this.emit("drain_deferred", {
        taskId: next.taskId,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      this.draining = false;
    }
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

    this.client.on("close", () => {
      // Transport gone: release the claim so a future reconnect (Phase 1)
      // can restart cleanly. Queue is intentionally preserved — those tasks
      // were never accepted by the server.
      this.turnClaimed = false;
      this.setStatus("offline");
    });
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
    // REAL-WIRE: turn/started params = { threadId, turn: { id, status, … } }.
    const p = params as { threadId?: string };
    if (!p || p.threadId !== this.threadId) {
      this.emit("cross_thread_drop", { event: "turn/started", params });
      return;
    }
    const turnId = extractTurnId(params);
    if (!turnId) return;
    if (!this.pendingTurns.has(turnId)) {
      // A turn we didn't start (§7.5 rule) — e.g. the human TUI. Observe only.
      this.emit("unowned_turn_drop", { turnId, event: "turn/started" });
      return;
    }
  }

  private onItemStarted(_params: unknown): void {
    // No-op in Phase 0. Real bridge will use item ids to gate approval
    // acceptance in later phases.
  }

  private onAgentDelta(params: unknown): void {
    // REAL-WIRE: item/agentMessage/delta = { threadId, turnId, itemId, delta }
    // where `delta` is a plain string (NOT { text }).
    const p = params as { threadId?: string; turnId?: string; delta?: unknown };
    if (!p || p.threadId !== this.threadId) return;
    if (typeof p.turnId !== "string") return;
    const pending = this.pendingTurns.get(p.turnId);
    if (!pending) return; // Not our turn — human TUI is receiving deltas too.
    if (typeof p.delta === "string") pending.agentTextChunks.push(p.delta);
  }

  private onItemCompleted(params: unknown): void {
    // REAL-WIRE: item/completed = { item: { type, text, phase, … }, threadId,
    // turnId }. The final agent answer is the agentMessage item with
    // phase === "final_answer". Capture it as the authoritative reply text.
    const p = params as {
      threadId?: string;
      turnId?: string;
      item?: { type?: string; text?: string; phase?: string };
    };
    if (!p || p.threadId !== this.threadId) return;
    if (typeof p.turnId !== "string") return;
    const pending = this.pendingTurns.get(p.turnId);
    if (!pending) return;
    if (
      p.item?.type === "agentMessage" &&
      p.item.phase === "final_answer" &&
      typeof p.item.text === "string"
    ) {
      pending.finalText = p.item.text;
    }
  }

  private onTurnCompleted(params: unknown): void {
    // REAL-WIRE: turn/completed = { threadId, turn: { id, status, error, … } }.
    const p = params as {
      threadId?: string;
      turn?: { id?: string; status?: string; error?: { message?: string } | null };
    };
    if (!p || p.threadId !== this.threadId) {
      this.emit("cross_thread_drop", { event: "turn/completed", params });
      return;
    }
    const turnId = extractTurnId(params);
    if (!turnId) return;
    const pending = this.pendingTurns.get(turnId);
    if (!pending) {
      // Human-TUI-initiated turn completed. Absolutely no reply mapping —
      // but the thread just went idle, so queued Agent tasks may proceed
      // (§6.1: human input had its priority; FIFO resumes after).
      this.emit("unowned_turn_drop", { turnId, event: "turn/completed" });
      void this.drainQueue();
      return;
    }
    this.pendingTurns.delete(turnId);
    if (this.activeTurnId === turnId) {
      this.activeTurnId = null;
      this.turnClaimed = false;
      this.setStatus(this.waitingApprovals.size > 0 ? "waiting_human" : "idle");
    }
    const turnErr = p.turn?.error?.message;
    if (turnErr) {
      this.emit("task_error", { taskId: pending.taskId, error: turnErr });
    } else {
      // Prefer the captured final_answer item; fall back to accumulated deltas.
      const text = pending.finalText && pending.finalText.length > 0
        ? pending.finalText
        : pending.agentTextChunks.join("");
      this.emit("task_reply", { taskId: pending.taskId, text });
    }
    // Either way the thread just went idle from our perspective → drain FIFO.
    void this.drainQueue();
  }

  /** Read-only queue depth (for tests / observability). */
  queueDepth(): number {
    return this.taskQueue.length;
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

// REAL-WIRE (codex-cli 0.144.0): turn/start response and turn/{started,completed}
// events nest the id under `turn.id`; only item-level events use a flat
// `turnId`. Accept both so this survives either surface.
function extractTurnId(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const o = v as { turn?: { id?: unknown }; turnId?: unknown };
  if (o.turn && typeof o.turn === "object" && typeof o.turn.id === "string") return o.turn.id;
  if (typeof o.turnId === "string") return o.turnId;
  return null;
}

/** Recognise the app-server's "already initialized" rejection (shared server). */
function isAlreadyInitialized(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  const msg = (e as { message?: unknown })?.message;
  if (code === -32600) return true;
  return typeof msg === "string" && /already initialized/i.test(msg);
}

/** thread/resume against an id the app-server has no persisted rollout for. */
function isNoRollout(e: unknown): boolean {
  const msg = (e as { message?: unknown })?.message;
  return typeof msg === "string" && /no rollout found|thread not found|unknown thread/i.test(msg);
}

/**
 * Human-readable sender label for the codex prompt prefix. The hub defaults
 * `from_session` to "api" for dashboard/REST-originated tasks (server/src/
 * index.ts), which reads as opaque "from=api" in the TUI — map it to a clear
 * "控制台(dashboard)" so a human at the TUI knows it came from the panel.
 * Everything else (agent aliases, "hub") passes through unchanged.
 */
function displaySender(from?: string): string | undefined {
  if (!from) return undefined;
  if (from === "api") return "控制台(dashboard)";
  return from;
}

function extractReverseRequestId(params: unknown): number | null {
  if (!params || typeof params !== "object") return null;
  const p = params as { reverseRequestId?: unknown; requestId?: unknown };
  if (typeof p.reverseRequestId === "number") return p.reverseRequestId;
  if (typeof p.requestId === "number") return p.requestId;
  return null;
}
