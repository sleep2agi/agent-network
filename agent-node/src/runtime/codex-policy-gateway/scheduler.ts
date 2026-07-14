// RFC-030 Wave 1B — gateway scheduler.
//
// Typed enqueue consumer between the Agent contract surface (A's
// contract.ts) and the turn dispatcher (bridge-adapter.ts). Owns:
//
//   - the bounded FIFO queue of agent submissions,
//   - the SINGLE cross-origin reservation (none | human | agent) — the
//     atomic arbiter deciding whether the shared thread is free,
//   - ledger transitions for every submission it manages,
//   - idempotency by messageId (duplicate enqueue returns the original).
//
// Invariants (dispatch requirement 1):
//   - A formal task ALWAYS gets its own `turn/start`; nothing here can
//     express a steer (the dispatcher interface has no steer method).
//   - Reservation acquisition is a synchronous check-and-set — no await
//     between "is it free?" and "it's mine", so two interleaved enqueues
//     cannot both win (JS single-thread + no await in the critical
//     section = atomic).
//   - Human turns (observed via the adapter's thread events) take the
//     same reservation; agent dispatch waits until it frees.
//
// The scheduler never touches a socket and never sees JSON-RPC — it
// speaks ledger states + the dispatcher interface only.

import type {
  EnqueueTaskArgs,
  EnqueueTaskResult,
  TaskState,
  CancelQueuedTaskResult,
  TaskId,
  AuthenticatedSender,
} from "./contract";
import {
  DELIVERY,
  completedDelivery,
  type GatewayLedger,
  type LedgerRow,
} from "./ledger";

// ────────────────────────────────────────────────────────────────────────
// Dispatcher interface (implemented by bridge-adapter)
// ────────────────────────────────────────────────────────────────────────

export type DispatchOutcome =
  | { readonly kind: "accepted"; readonly turnId: string }
  | { readonly kind: "failed"; readonly error: string }
  /**
   * The turn/start request was sent but its response never arrived
   * (timeout / connection loss mid-request) AND the adapter could not
   * reconcile against observed thread events. The scheduler marks the
   * ledger row `ambiguous` and DOES NOT retry — a resend could create a
   * duplicate turn on the shared thread.
   */
  | { readonly kind: "ambiguous"; readonly detail: string };

export interface TurnDispatcher {
  /**
   * Emit exactly one `turn/start` for this submission. NO steer method
   * exists on this interface by design.
   */
  startTurn(input: {
    submissionId: string;
    taskId: string;
    text: string;
    fromAlias: string;
    clientUserMessageId: string;
    /** B-only metadata used for the human-visible origin prefix. */
    sourceType?: InboundSourceType;
    sourceId?: string;
  }): Promise<DispatchOutcome>;
}

export type OrdinaryInboxType = "message" | "reply" | "chained_reply" | "broadcast";
export type InboundSourceType = "task" | OrdinaryInboxType;
const ORDINARY_INBOX_TYPES: ReadonlySet<string> = new Set([
  "message",
  "reply",
  "chained_reply",
  "broadcast",
]);

export interface InjectMessageArgs {
  readonly messageId: string;
  readonly authenticatedSender: AuthenticatedSender;
  readonly type: OrdinaryInboxType;
  readonly text: string;
}

export type InjectMessageResult =
  | { readonly outcome: "accepted"; readonly queuePosition: number | null; readonly duplicate: boolean }
  | { readonly outcome: "refused_queue_full"; readonly queueDepth: number; readonly limit: number }
  | { readonly outcome: "refused_no_owner" }
  | { readonly outcome: "refused_shutting_down" }
  | { readonly outcome: "refused_invalid_arg"; readonly field: string; readonly reason: string };

export type ReservationOwner = "none" | "human" | "agent";

export interface SchedulerOptions {
  ledger: GatewayLedger;
  dispatcher: TurnDispatcher;
  /** Bounded queue limit (refused_queue_full beyond this). */
  queueLimit?: number;
  /**
   * Probe: is a human owner attached? REQUIRED (副指挥 fail-closed
   * blocker): an optional default-true probe meant a gateway with no
   * owner/lease wiring silently accepted work, violating
   * refused_no_owner/NoOwner. Callers without owner wiring must pass
   * `() => false` explicitly — the scheduler then refuses new work and
   * parks the pump. Lease/eviction semantics remain A's lifecycle domain.
   */
  ownerAttached: () => boolean;
  /** Refuse new work when shutting down. */
  isShuttingDown?: () => boolean;
  log?: (msg: string) => void;
}

export interface SchedulerSnapshot {
  readonly queueDepth: number;
  readonly tasksSeen: number;
  readonly activeReservationOwner: ReservationOwner;
  readonly ambiguousCount: number;
  readonly failedCount: number;
}

interface QueueEntry {
  submissionId: string;
  taskId: string;
  fromAlias: string;
  text: string;
  clientUserMessageId: string;
  sourceType: InboundSourceType;
  sourceId: string;
  expectsReply: boolean;
}

export class GatewayScheduler {
  private readonly ledger: GatewayLedger;
  private readonly dispatcher: TurnDispatcher;
  private readonly queueLimit: number;
  private readonly ownerAttached: () => boolean;
  private readonly isShuttingDown: () => boolean;
  private readonly log: (msg: string) => void;

  private queue: QueueEntry[] = [];
  private reservation: ReservationOwner = "none";
  /** submissionId currently holding the agent reservation. */
  private activeSubmissionId: string | null = null;
  /** turnId of the human turn currently holding the reservation. */
  private activeHumanTurnId: string | null = null;

  private tasksSeen = 0;
  private ambiguousCount = 0;
  private failedCount = 0;
  private unexpectedDispatchFailureCounter = 0;
  private listeners = new Set<() => void>();

  constructor(opts: SchedulerOptions) {
    this.ledger = opts.ledger;
    this.dispatcher = opts.dispatcher;
    this.queueLimit = opts.queueLimit ?? 32;
    this.ownerAttached = opts.ownerAttached;
    this.isShuttingDown = opts.isShuttingDown ?? (() => false);
    this.log = opts.log ?? (() => {});
  }

  // ──────────────────────────────────────────────────────────────────
  // Agent contract surface
  // ──────────────────────────────────────────────────────────────────

  async enqueueTask(args: EnqueueTaskArgs): Promise<EnqueueTaskResult> {
    if (this.isShuttingDown()) {
      return { outcome: "refused_shutting_down" };
    }
    if (!this.ownerAttached()) {
      return { outcome: "refused_no_owner" };
    }
    if (typeof args.text !== "string" || args.text.length === 0) {
      return { outcome: "refused_invalid_arg", field: "text", reason: "empty" };
    }

    // Freeze 90d1e58 id semantics: (taskId, messageId) uniquely identifies
    // a DELIVERY ATTEMPT. Same messageId re-submitted → duplicate (return
    // the prior attempt). Same taskId + NEW messageId → a retry attempt of
    // the same logical task — allowed ONLY when the latest attempt is
    // terminal-failure; a live attempt or a successful one dedups (the
    // gateway never double-runs a logical task).
    const cumid = `anet:${String(args.messageId)}`;
    const existing = this.ledger.getByClientUserMessageId(cumid);
    if (existing) {
      return {
        outcome: "accepted",
        taskId: existing.taskId as TaskId,
        queuePosition: null,
        duplicate: true,
      };
    }
    const latest = this.ledger.getLatestByTaskId(String(args.taskId));
    if (latest) {
      const RETRYABLE: ReadonlySet<string> = new Set([
        "failed",
        "ambiguous",
        "interrupted_by_human",
        "cancelled",
      ]);
      if (!RETRYABLE.has(latest.state)) {
        // Live attempt in flight OR already succeeded → idempotent dedup.
        return {
          outcome: "accepted",
          taskId: args.taskId,
          queuePosition: null,
          duplicate: true,
        };
      }
      if (latest.expectsReply && latest.outboundDelivery !== "delivered") {
        // A canonical failure outcome still owns task closure. Starting a
        // retry before that durable outcome reaches H1 races two terminal
        // mutations against the same Hub task, so the redelivery dedups.
        return {
          outcome: "accepted",
          taskId: args.taskId,
          queuePosition: null,
          duplicate: true,
        };
      }
      // else: terminal failure → fall through, new attempt row below.
    }

    const formalQueueDepth = this.queue.filter((entry) => entry.expectsReply).length;
    if (formalQueueDepth >= this.queueLimit) {
      return {
        outcome: "refused_queue_full",
        queueDepth: formalQueueDepth,
        limit: this.queueLimit,
      };
    }

    // One ledger row per ATTEMPT, keyed by messageId (initial dispatch has
    // messageId == taskId on the CommHub side, so first attempts keep the
    // familiar id; retries get their fresh inbox id).
    const submissionId = String(args.messageId);
    this.ledger.record({
      submissionId,
      origin: "agent",
      taskId: String(args.taskId),
      fromAlias: args.authenticatedSender.alias,
      requestText: args.text,
      inboundType: "task",
      expectsReply: true,
      clientUserMessageId: cumid,
    });
    this.ledger.transition(submissionId, "queued");
    this.tasksSeen += 1;

    const entry: QueueEntry = {
      submissionId,
      taskId: String(args.taskId),
      fromAlias: args.authenticatedSender.alias,
      text: args.text,
      clientUserMessageId: cumid,
      sourceType: "task",
      sourceId: String(args.taskId),
      expectsReply: true,
    };
    this.queue.push(entry);
    this.notify();

    // Kick the pump. Its critical section is synchronous — by the time it
    // returns control the entry has either been taken (dispatch started →
    // contract queuePosition null) or is still genuinely queued. Computing
    // the position AFTER the kick fixes the 副指挥-audited race where an
    // idle enqueue reported queuePosition=0 instead of null.
    void this.pump();
    const idx = this.queue.filter((queued) => queued.expectsReply).indexOf(entry);

    return {
      outcome: "accepted",
      taskId: args.taskId,
      queuePosition: idx === -1 ? null : idx,
      duplicate: false,
    };
  }

  /**
   * Queue a non-task CommHub row as its own turn on the SAME scheduler.
   * These rows are durable-before-ACK but never create a CommHub reply.
   */
  async injectMessage(args: InjectMessageArgs): Promise<InjectMessageResult> {
    if (this.isShuttingDown()) return { outcome: "refused_shutting_down" };
    if (!this.ownerAttached()) return { outcome: "refused_no_owner" };
    if (typeof args.messageId !== "string" || args.messageId.length === 0) {
      return { outcome: "refused_invalid_arg", field: "messageId", reason: "empty" };
    }
    if (typeof args.text !== "string" || args.text.length === 0) {
      return { outcome: "refused_invalid_arg", field: "text", reason: "empty" };
    }
    if (!ORDINARY_INBOX_TYPES.has(args.type)) {
      return { outcome: "refused_invalid_arg", field: "type", reason: "unsupported" };
    }

    const cumid = `anet:${args.messageId}`;
    const existing = this.ledger.getByClientUserMessageId(cumid);
    if (existing) {
      return { outcome: "accepted", queuePosition: null, duplicate: true };
    }
    const ordinaryQueueDepth = this.queue.filter((entry) => !entry.expectsReply).length;
    if (ordinaryQueueDepth >= this.queueLimit) {
      return {
        outcome: "refused_queue_full",
        queueDepth: ordinaryQueueDepth,
        limit: this.queueLimit,
      };
    }

    const submissionId = args.messageId;
    this.ledger.record({
      submissionId,
      origin: "agent",
      taskId: null,
      fromAlias: args.authenticatedSender.alias,
      requestText: args.text,
      inboundType: args.type,
      expectsReply: false,
      clientUserMessageId: cumid,
    });
    this.ledger.transition(submissionId, "queued");

    const entry: QueueEntry = {
      submissionId,
      taskId: args.messageId,
      fromAlias: args.authenticatedSender.alias,
      text: args.text,
      clientUserMessageId: cumid,
      sourceType: args.type,
      sourceId: args.messageId,
      expectsReply: false,
    };
    this.queue.push(entry);
    this.notify();
    void this.pump();
    const idx = this.queue.indexOf(entry);
    return {
      outcome: "accepted",
      queuePosition: idx === -1 ? null : idx,
      duplicate: false,
    };
  }

  async getTaskState(taskId: TaskId): Promise<TaskState> {
    // Logical-task view: the LATEST attempt row answers for the taskId
    // (freeze semantics — same taskId spans retry attempts).
    const latest = this.ledger.getLatestByTaskId(String(taskId));
    const legacy = latest === null ? this.ledger.get(String(taskId)) : null;
    const row = latest ?? (
      legacy?.expectsReply && legacy.taskId === String(taskId) ? legacy : null
    );
    if (!row) return { state: "unknown" };
    return ledgerRowToTaskState(row, this.queuePositionOf(String(taskId)));
  }

  async cancelQueuedTask(taskId: TaskId): Promise<CancelQueuedTaskResult> {
    const idx = this.queue.findIndex(
      (e) => e.expectsReply && e.taskId === String(taskId),
    );
    if (idx === -1) {
      const latest = this.ledger.getLatestByTaskId(String(taskId));
      const legacy = latest === null ? this.ledger.get(String(taskId)) : null;
      const row = latest ?? (
        legacy?.expectsReply && legacy.taskId === String(taskId) ? legacy : null
      );
      const current = row ? ledgerRowToTaskState(row, null).state : "unknown";
      return { outcome: "refused_not_queued", currentState: current };
    }
    const [entry] = this.queue.splice(idx, 1);
    // Contract roundtrip (副指挥 P1): outcome 'cancelled' must be what a
    // subsequent getTaskState reads back — dedicated ledger state, not a
    // 'failed' masquerade.
    this.ledger.transition(entry.submissionId, "cancelled", {
      ...(entry.expectsReply ? { outbound: DELIVERY.cancelled } : {}),
    });
    this.notify();
    return { outcome: "cancelled", cancelledAtMs: Date.now() };
  }

  // ──────────────────────────────────────────────────────────────────
  // Cross-origin reservation
  // ──────────────────────────────────────────────────────────────────

  /**
   * Called by the adapter when a turn it did NOT start appears on the
   * bound thread — i.e. the human TUI took the thread. Reserves for the
   * human so the agent pump stays parked.
   */
  onHumanTurnStarted(turnId: string): void {
    if (this.reservation === "agent") {
      // Shouldn't happen (server serializes turns per thread), but if the
      // server double-books, we keep our accounting and just log.
      this.log(`[scheduler] human turn ${turnId} observed while agent holds reservation`);
      return;
    }
    this.reservation = "human";
    this.activeHumanTurnId = turnId;
    this.notify();
  }

  /** Called by the adapter when the human's turn finishes. */
  onHumanTurnFinished(turnId: string): void {
    if (this.reservation === "human" && this.activeHumanTurnId === turnId) {
      this.reservation = "none";
      this.activeHumanTurnId = null;
      this.notify();
      void this.pump();
    }
  }

  /**
   * Called by the adapter when the agent-held turn reaches its terminal
   * event. `result` carries the final text or error.
   */
  onAgentTurnFinished(
    submissionId: string,
    result: { ok: true; replyText: string } | { ok: false; error: string },
  ): void {
    if (this.activeSubmissionId !== submissionId) {
      this.log(`[scheduler] stray turn-finish for ${submissionId} (active=${this.activeSubmissionId})`);
      return;
    }
    if (result.ok) {
      const row = this.ledger.get(submissionId);
      const completion = completedDelivery(result.replyText);
      if (!completion.ok) {
        this.ledger.transition(submissionId, "failed", {
          error: completion.delivery.text,
          ...(row?.expectsReply ? { outbound: completion.delivery } : {}),
        });
        this.failedCount += 1;
      } else if (row?.expectsReply) {
        this.ledger.transition(submissionId, "completed", {
          replyText: completion.delivery.text,
        });
        this.ledger.transition(submissionId, "reply_pending", {
          outbound: completion.delivery,
        });
      } else {
        // Ordinary inbox turns are terminal locally; no send_reply is emitted.
        this.ledger.transition(submissionId, "completed", {
          replyText: completion.delivery.text,
        });
        this.ledger.transition(submissionId, "replied");
      }
    } else {
      const row = this.ledger.get(submissionId);
      this.ledger.transition(submissionId, "failed", {
        // Never persist the dispatcher-provided string. It is a trust
        // boundary and may contain raw upstream error.message/data.
        error: DELIVERY.turnFailed.text,
        ...(row?.expectsReply ? { outbound: DELIVERY.turnFailed } : {}),
      });
      this.failedCount += 1;
    }
    this.releaseAgentReservation();
  }

  /**
   * Phase-1 TUI policy: the human pressed turn/interrupt while an agent
   * task held the reservation. Structured terminal state; the task is
   * NEVER auto-replayed (a restart must not requeue it either — the
   * ledger state is terminal).
   */
  onAgentTurnInterrupted(submissionId: string): void {
    if (this.activeSubmissionId !== submissionId) {
      this.log(`[scheduler] stray interrupt for ${submissionId} (active=${this.activeSubmissionId})`);
      return;
    }
    const row = this.ledger.get(submissionId);
    this.ledger.transition(submissionId, "interrupted_by_human", {
      error: "human owner interrupted the running agent turn via TUI (no auto-replay)",
      ...(row?.expectsReply ? { outbound: DELIVERY.interrupted } : {}),
    });
    this.releaseAgentReservation();
  }

  /** The reply was delivered back to CommHub — final ledger state. */
  markReplied(submissionId: string): void {
    this.ledger.markOutboundDelivered(submissionId);
    this.notify();
  }

  snapshot(): SchedulerSnapshot {
    return {
      queueDepth: this.queue.filter((entry) => entry.expectsReply).length,
      tasksSeen: this.tasksSeen,
      activeReservationOwner: this.reservation,
      ambiguousCount: this.ambiguousCount,
      failedCount: this.failedCount,
    };
  }

  /** B-only heartbeat probe; includes ordinary turns without changing A metrics. */
  hasPendingWork(): boolean {
    return this.reservation !== "none" || this.queue.length > 0;
  }

  /** Subscribe to snapshot-worthy changes (runtime.ts fans out). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Lifecycle hook: call when the owner-attachment probe's answer may
   * have changed (TUI attach/detach). On re-attach this un-parks the
   * pump so queued entries resume dispatching.
   */
  onOwnerAttachmentChanged(): void {
    void this.pump();
  }

  /**
   * Rehydrate boot-time rows proven never to have reached `turn/start`.
   * Missing payloads belong to pre-recovery-schema ledgers and fail closed;
   * they are never guessed or silently left in a permanent queued state.
   */
  restoreRecoveredQueue(rows: readonly LedgerRow[]): void {
    for (const row of rows) {
      if (
        row.state !== "queued" ||
        row.clientUserMessageId === null ||
        row.requestText === null ||
        row.requestText.length === 0 ||
        (row.expectsReply && (row.taskId === null || row.inboundType !== "task")) ||
        (!row.expectsReply && !ORDINARY_INBOX_TYPES.has(row.inboundType))
      ) {
        if (row.state === "queued") {
          this.ledger.transition(row.submissionId, "failed", {
            error: DELIVERY.recoveryInvalid.text,
            ...(row.expectsReply ? { outbound: DELIVERY.recoveryInvalid } : {}),
          });
          this.failedCount += 1;
        }
        this.log(`[scheduler] recovery rejected submission=${row.submissionId}`);
        continue;
      }
      if (this.queue.some((entry) => entry.submissionId === row.submissionId)) continue;
      this.queue.push({
        submissionId: row.submissionId,
        taskId: row.taskId ?? row.submissionId,
        fromAlias: row.fromAlias ?? "(unknown)",
        text: row.requestText,
        clientUserMessageId: row.clientUserMessageId,
        sourceType: row.inboundType,
        sourceId: row.taskId ?? row.submissionId,
        expectsReply: row.expectsReply,
      });
      if (row.expectsReply) this.tasksSeen += 1;
    }
    this.notify();
    void this.pump();
  }

  // ──────────────────────────────────────────────────────────────────
  // Pump
  // ──────────────────────────────────────────────────────────────────

  /**
   * Drain loop. The critical section — reservation check-and-set + queue
   * pop — is fully synchronous, so concurrent pump() calls (from enqueue,
   * human-turn-finish, dispatch-finish) can never double-dispatch.
   */
  private async pump(): Promise<void> {
    // ↓↓ synchronous critical section ↓↓
    if (this.reservation !== "none") return;
    // Owner dropped while entries were queued: PARK — do not dispatch.
    // Entries stay queued (owner may re-attach; lease eviction/timeout is
    // A's lifecycle domain, wired later). An in-flight accepted turn is
    // NOT auto-interrupted by an owner drop — interrupt is the human's
    // explicit action, never an implicit side effect.
    if (!this.ownerAttached()) return;
    const entry = this.queue.shift();
    if (!entry) return;
    this.reservation = "agent";
    this.activeSubmissionId = entry.submissionId;
    // ↑↑ end critical section — reservation is ours before any await ↑↑
    this.notify();

    this.ledger.transition(entry.submissionId, "dispatching", { bumpDispatchAttempts: true });

    let outcome: DispatchOutcome;
    try {
      outcome = await this.dispatcher.startTurn({
        submissionId: entry.submissionId,
        taskId: entry.taskId,
        text: entry.text,
        fromAlias: entry.fromAlias,
        clientUserMessageId: entry.clientUserMessageId,
        sourceType: entry.sourceType,
        sourceId: entry.sourceId,
      });
    } catch {
      // R2: an unexpected dispatcher throw may carry an upstream-controlled
      // message. Persist only a stable correlation reference.
      const ref = `sched-${++this.unexpectedDispatchFailureCounter}`;
      this.log(`[scheduler] dispatch threw ref=${ref}`);
      outcome = { kind: "failed", error: `upstream dispatch failed (ref ${ref})` };
    }

    switch (outcome.kind) {
      case "accepted":
        this.ledger.transition(entry.submissionId, "accepted", { turnId: outcome.turnId });
        this.notify();
        // Reservation stays held until onAgentTurnFinished.
        return;
      case "failed":
        this.ledger.transition(entry.submissionId, "failed", {
          // Ignore arbitrary dispatcher text at the persistence boundary.
          error: DELIVERY.dispatchFailed.text,
          ...(entry.expectsReply ? { outbound: DELIVERY.dispatchFailed } : {}),
        });
        this.failedCount += 1;
        this.releaseAgentReservation();
        return;
      case "ambiguous":
        // Response lost, reconcile failed. Do NOT resend (duplicate-turn
        // risk). Terminal; requires human/ops attention.
        this.ledger.transition(entry.submissionId, "ambiguous", {
          error: DELIVERY.dispatchUnknown.text,
          ...(entry.expectsReply ? { outbound: DELIVERY.dispatchUnknown } : {}),
        });
        this.ambiguousCount += 1;
        this.log(
          `[scheduler] submission ${entry.submissionId} AMBIGUOUS — dispatch response lost, not resending`,
        );
        this.releaseAgentReservation();
        return;
    }
  }

  private releaseAgentReservation(): void {
    this.reservation = "none";
    this.activeSubmissionId = null;
    this.notify();
    void this.pump();
  }

  private queuePositionOf(taskId: string): number | null {
    const formalQueue = this.queue.filter((entry) => entry.expectsReply);
    const idx = formalQueue.findIndex((entry) => entry.taskId === taskId);
    return idx === -1 ? null : idx;
  }

  private notify(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // listener errors must not break scheduling
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Ledger → contract TaskState mapping
// ────────────────────────────────────────────────────────────────────────

export function ledgerRowToTaskState(row: LedgerRow, queuePosition: number | null): TaskState {
  switch (row.state) {
    case "received":
      return { state: "starting" };
    case "queued":
      return { state: "queued", queuePosition: queuePosition ?? 0 };
    case "dispatching":
      return { state: "starting" };
    case "accepted":
      return { state: "running", startedAtMs: row.updatedAt };
    case "completed":
    case "reply_pending":
    case "replied":
      return {
        state: "completed",
        startedAtMs: row.createdAt,
        completedAtMs: row.terminalAt ?? row.updatedAt,
        replyText: row.replyText ?? "",
      };
    case "failed":
      return {
        state: "failed",
        startedAtMs: row.createdAt,
        failedAtMs: row.terminalAt ?? row.updatedAt,
        errorSummary: row.error ?? "unknown error",
      };
    case "ambiguous":
      return {
        state: "failed",
        startedAtMs: row.createdAt,
        failedAtMs: row.terminalAt ?? row.updatedAt,
        errorSummary: `ambiguous: ${row.error ?? "dispatch response lost"}`,
      };
    case "interrupted_by_human":
      return {
        state: "cancelled",
        cancelledAtMs: row.terminalAt ?? row.updatedAt,
        cancelledBy: "owner",
      };
    case "cancelled":
      return {
        state: "cancelled",
        cancelledAtMs: row.terminalAt ?? row.updatedAt,
        cancelledBy: "agent",
      };
  }
}
