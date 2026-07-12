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
} from "./contract";
import type { GatewayLedger, LedgerRow } from "./ledger";

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
  }): Promise<DispatchOutcome>;
}

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

    // Idempotency: same messageId → return the existing task, don't requeue.
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

    if (this.queue.length >= this.queueLimit) {
      return {
        outcome: "refused_queue_full",
        queueDepth: this.queue.length,
        limit: this.queueLimit,
      };
    }

    // Ledger: received → queued. Both synchronous writes.
    this.ledger.record({
      submissionId: String(args.taskId),
      origin: "agent",
      taskId: String(args.taskId),
      fromAlias: args.authenticatedSender.alias,
      clientUserMessageId: cumid,
    });
    this.ledger.transition(String(args.taskId), "queued");
    this.tasksSeen += 1;

    const entry: QueueEntry = {
      submissionId: String(args.taskId),
      taskId: String(args.taskId),
      fromAlias: args.authenticatedSender.alias,
      text: args.text,
      clientUserMessageId: cumid,
    };
    this.queue.push(entry);
    const position = this.queue.length - 1;
    this.notify();

    // Kick the pump (async; enqueue itself returns immediately).
    void this.pump();

    return {
      outcome: "accepted",
      taskId: args.taskId,
      queuePosition: position === 0 && this.reservation === "none" ? null : position,
      duplicate: false,
    };
  }

  async getTaskState(taskId: TaskId): Promise<TaskState> {
    const row = this.ledger.get(String(taskId));
    if (!row) return { state: "unknown" };
    return ledgerRowToTaskState(row, this.queuePositionOf(String(taskId)));
  }

  async cancelQueuedTask(taskId: TaskId): Promise<CancelQueuedTaskResult> {
    const idx = this.queue.findIndex((e) => e.taskId === String(taskId));
    if (idx === -1) {
      const row = this.ledger.get(String(taskId));
      const current = row ? ledgerRowToTaskState(row, null).state : "unknown";
      return { outcome: "refused_not_queued", currentState: current };
    }
    this.queue.splice(idx, 1);
    this.ledger.transition(String(taskId), "failed", { error: "cancelled by agent while queued" });
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
      this.ledger.transition(submissionId, "completed", { replyText: result.replyText });
      this.ledger.transition(submissionId, "reply_pending");
    } else {
      this.ledger.transition(submissionId, "failed", { error: result.error });
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
    this.ledger.transition(submissionId, "interrupted_by_human", {
      error: "human owner interrupted the running agent turn via TUI (no auto-replay)",
    });
    this.releaseAgentReservation();
  }

  /** The reply was delivered back to CommHub — final ledger state. */
  markReplied(submissionId: string): void {
    this.ledger.transition(submissionId, "replied");
    this.notify();
  }

  snapshot(): SchedulerSnapshot {
    return {
      queueDepth: this.queue.length,
      tasksSeen: this.tasksSeen,
      activeReservationOwner: this.reservation,
      ambiguousCount: this.ambiguousCount,
      failedCount: this.failedCount,
    };
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
      });
    } catch (e) {
      outcome = { kind: "failed", error: (e as Error)?.message ?? String(e) };
    }

    switch (outcome.kind) {
      case "accepted":
        this.ledger.transition(entry.submissionId, "accepted", { turnId: outcome.turnId });
        this.notify();
        // Reservation stays held until onAgentTurnFinished.
        return;
      case "failed":
        this.ledger.transition(entry.submissionId, "failed", { error: outcome.error });
        this.failedCount += 1;
        this.releaseAgentReservation();
        return;
      case "ambiguous":
        // Response lost, reconcile failed. Do NOT resend (duplicate-turn
        // risk). Terminal; requires human/ops attention.
        this.ledger.transition(entry.submissionId, "ambiguous", { error: outcome.detail });
        this.ambiguousCount += 1;
        this.log(
          `[scheduler] submission ${entry.submissionId} AMBIGUOUS — dispatch response lost, not resending: ${outcome.detail}`,
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
    const idx = this.queue.findIndex((e) => e.taskId === taskId);
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
        completedAtMs: row.updatedAt,
        replyText: row.replyText ?? "",
      };
    case "failed":
      return {
        state: "failed",
        startedAtMs: row.createdAt,
        failedAtMs: row.updatedAt,
        errorSummary: row.error ?? "unknown error",
      };
    case "ambiguous":
      return {
        state: "failed",
        startedAtMs: row.createdAt,
        failedAtMs: row.updatedAt,
        errorSummary: `ambiguous: ${row.error ?? "dispatch response lost"}`,
      };
    case "interrupted_by_human":
      return {
        state: "cancelled",
        cancelledAtMs: row.updatedAt,
        cancelledBy: "owner",
      };
  }
}
