// RFC-030 Wave 1B — bridge adapter: scheduler ↔ codex app-server client.
//
// Implements the scheduler's TurnDispatcher on top of CodexAppServerClient
// (NOT on CodexAppServerBridge — the Phase-0A bridge keeps its own internal
// queue, and Wave 1B moves queueing/reservation into the scheduler; two
// queues fighting over one thread would break the single-arbiter
// invariant). Every upstream call passes the policy allowlist first.
//
// Responsibilities:
//   - policy-checked `turn/start` per submission (NEVER steer),
//   - turn event routing: our turns → scheduler.onAgentTurnFinished;
//     any turn we did not start → human reservation signals,
//   - dispatch-response-loss handling: on request timeout, watch the
//     thread for `turn/started` carrying our clientUserMessageId within a
//     reconcile window; found → accepted, else → ambiguous (no resend),
//   - reverse requests: observed, logged, NEVER answered (they belong to
//     the human TUI; additionally Phase 1 runs approval_policy=never so
//     these should not occur at all — seeing one is itself an anomaly),
//   - constructing AuthenticatedSender from a CommHub inbox row with
//     FAIL-CLOSED semantics: no verified principal → no task. There is NO
//     bypass env (协调 owner decision); dev/test uses explicit fixtures.

import { EventEmitter } from "events";
import type { CodexAppServerClient } from "../codex-app-server-client";
import { evaluateUpstreamCall } from "./policy";
import type { DispatchOutcome, GatewayScheduler, TurnDispatcher } from "./scheduler";
import type { AuthenticatedSender } from "./contract";

/**
 * L2 (副指挥 P1, aligned with A's ProtocolDiagnostics): raw upstream
 * errors NEVER cross into the Agent wire / task state. The full exception
 * goes to this sink with a correlationId; the wire/state only ever sees a
 * stable generalized summary carrying the same id, so an operator can
 * match a support report to the internal log line.
 */
export interface AdapterDiagnostics {
  newCorrelationId(): string;
  reportInternalError(entry: {
    correlationId: string;
    operation: string;
    error: unknown;
  }): void;
}

const MAX_ALIAS_DISPLAY = 64;

/**
 * L2 (副指挥 P1): the visible task prefix interpolates a caller-
 * controlled display alias. Unescaped, a newline in the alias forges
 * extra `type:` / `task_id:` display lines toward the human TUI. Collapse
 * ALL control chars to single spaces and cap the length — display only;
 * authorization and the ledger continue to key on tokenId, never alias.
 */
export function sanitizeDisplayAlias(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const oneLine = raw.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  const capped = oneLine.slice(0, MAX_ALIAS_DISPLAY).trim();
  return capped.length > 0 ? capped : "(unknown)";
}

export interface BridgeAdapterOptions {
  client: CodexAppServerClient;
  threadId: string;
  /** How long to watch for a reconciling turn/started after a lost dispatch response. */
  reconcileWindowMs?: number;
  /** Per-request timeout for turn/start. */
  dispatchTimeoutMs?: number;
  log?: (msg: string) => void;
  /** Error sink — defaults to a counter-correlated log sink. */
  diagnostics?: AdapterDiagnostics;
}

interface TrackedTurn {
  submissionId: string;
  taskId: string;
  chunks: string[];
  /**
   * True once startTurn's outcome has been returned to the scheduler (so
   * the ledger row is `accepted`). A turn/completed observed BEFORE that
   * (possible when the dispatch response is delayed but thread events race
   * ahead) is buffered in `pendingCompletion` and flushed on a macrotask
   * after settlement — otherwise the scheduler would try an illegal
   * dispatching→completed ledger transition.
   */
  settled: boolean;
  pendingCompletion?: { ok: true; replyText: string } | { ok: false; error: string };
}

export class BridgeAdapter extends EventEmitter implements TurnDispatcher {
  private readonly client: CodexAppServerClient;
  private readonly threadId: string;
  private readonly reconcileWindowMs: number;
  private readonly dispatchTimeoutMs: number;
  private readonly log: (msg: string) => void;

  private scheduler: GatewayScheduler | null = null;

  /** turnId → tracked agent turn. */
  private myTurns = new Map<string, TrackedTurn>();
  /** clientUserMessageId → submission info (pre-acceptance, for reconcile). */
  private awaitingAcceptance = new Map<string, { submissionId: string; taskId: string }>();
  /** turnIds observed via turn/started that we reconciled by cumid. */
  private reconciledTurnByCumid = new Map<string, string>();
  /** Human (unowned) turns currently active. */
  private humanTurns = new Set<string>();

  private readonly diagnostics: AdapterDiagnostics;

  constructor(opts: BridgeAdapterOptions) {
    super();
    this.client = opts.client;
    this.threadId = opts.threadId;
    this.reconcileWindowMs = opts.reconcileWindowMs ?? 5_000;
    this.dispatchTimeoutMs = opts.dispatchTimeoutMs ?? 30_000;
    this.log = opts.log ?? (() => {});
    this.diagnostics = opts.diagnostics ?? this.defaultDiagnostics();
    this.attach();
  }

  private correlationCounter = 0;
  private defaultDiagnostics(): AdapterDiagnostics {
    return {
      newCorrelationId: () => `cx-${++this.correlationCounter}`,
      reportInternalError: (entry) => {
        // Internal log only — full detail, capped, never on the wire.
        const raw = entry.error instanceof Error ? entry.error.message : String(entry.error);
        this.log(
          `[adapter] internal error ${entry.correlationId} op=${entry.operation}: ${raw.slice(0, 300)}`,
        );
      },
    };
  }

  /** Report the raw error internally, return the generalized wire summary. */
  private generalizeError(operation: string, error: unknown): string {
    const correlationId = this.diagnostics.newCorrelationId();
    this.diagnostics.reportInternalError({ correlationId, operation, error });
    return `upstream ${operation} failed (ref ${correlationId})`;
  }

  /** Late-bind the scheduler (adapter is constructed first). */
  bindScheduler(scheduler: GatewayScheduler): void {
    this.scheduler = scheduler;
  }

  // ──────────────────────────────────────────────────────────────────
  // TurnDispatcher
  // ──────────────────────────────────────────────────────────────────

  async startTurn(input: {
    submissionId: string;
    taskId: string;
    text: string;
    fromAlias: string;
    clientUserMessageId: string;
  }): Promise<DispatchOutcome> {
    const params = {
      threadId: this.threadId,
      clientUserMessageId: input.clientUserMessageId,
      input: [
        {
          type: "text",
          // RFC-030 §6.4 visible origin prefix — the human in the TUI can
          // always tell which turns came from the Agent Network.
          text: `[Agent Network]\nfrom: ${sanitizeDisplayAlias(input.fromAlias)}\ntype: task\ntask_id: ${input.taskId}\n\n${input.text}`,
        },
      ],
    };

    const decision = evaluateUpstreamCall("turn/start", params, this.threadId);
    if (!decision.allowed) {
      return { kind: "failed", error: `policy denied: ${decision.reason} (${decision.code})` };
    }

    // Register for reconcile BEFORE sending, so a turn/started that races
    // ahead of the response is still matched.
    this.awaitingAcceptance.set(input.clientUserMessageId, {
      submissionId: input.submissionId,
      taskId: input.taskId,
    });

    try {
      const resp = await this.client.request<{ turnId?: string }>(
        "turn/start",
        params,
        this.dispatchTimeoutMs,
      );
      const turnId = typeof resp?.turnId === "string" ? resp.turnId : null;
      if (!turnId) {
        this.awaitingAcceptance.delete(input.clientUserMessageId);
        return { kind: "failed", error: "turn/start response missing turnId" };
      }
      this.adoptTurn(turnId, input);
      return this.settleAccepted(turnId);
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e);
      if (/timed out/.test(msg)) {
        // Response lost. The server may or may not have started the turn.
        // Watch for a reconciling turn/started with our cumid; do NOT
        // resend either way.
        const turnId = await this.awaitReconcile(input.clientUserMessageId);
        if (turnId) {
          this.adoptTurn(turnId, input);
          this.log(
            `[adapter] reconciled lost dispatch for ${input.submissionId} → turn ${turnId}`,
          );
          return this.settleAccepted(turnId);
        }
        this.awaitingAcceptance.delete(input.clientUserMessageId);
        return {
          kind: "ambiguous",
          detail: `turn/start response lost (${this.dispatchTimeoutMs}ms) and no matching turn/started observed within ${this.reconcileWindowMs}ms`,
        };
      }
      this.awaitingAcceptance.delete(input.clientUserMessageId);
      // Raw upstream message goes to diagnostics ONLY; wire/state gets a
      // stable generalized summary with the correlation ref.
      return { kind: "failed", error: this.generalizeError("turn/start", e) };
    }
  }

  /**
   * Mark the turn settled and flush any completion that raced ahead of the
   * dispatch response. The flush is deferred one macrotask so the
   * scheduler's synchronous `accepted` ledger transition (which happens as
   * soon as startTurn resolves) is guaranteed to precede completion
   * handling — otherwise the ledger would see dispatching→completed.
   */
  private settleAccepted(turnId: string): DispatchOutcome {
    const tracked = this.myTurns.get(turnId);
    if (tracked) {
      tracked.settled = true;
      if (tracked.pendingCompletion) {
        const pc = tracked.pendingCompletion;
        tracked.pendingCompletion = undefined;
        setTimeout(() => {
          this.myTurns.delete(turnId);
          this.scheduler?.onAgentTurnFinished(tracked.submissionId, pc);
        }, 0);
      }
    }
    return { kind: "accepted", turnId };
  }

  // ──────────────────────────────────────────────────────────────────
  // Event wiring
  // ──────────────────────────────────────────────────────────────────

  private attach(): void {
    this.client.on("turn/started", (params: unknown) => this.onTurnStarted(params));
    this.client.on("item/agentMessage/delta", (params: unknown) => this.onDelta(params));
    this.client.on("turn/completed", (params: unknown) => this.onTurnCompleted(params));
    this.client.on(
      "reverse_request",
      (rr: { id: number; method: string; params: unknown }) => {
        // Phase 1 runs approval_policy=never — a reverse request should not
        // happen. If one does, we record + surface but NEVER answer.
        this.log(
          `[adapter] ANOMALY: reverse request ${rr.method} (id=${rr.id}) under approval=never — not answering`,
        );
        this.emit("reverse_request_anomaly", rr);
      },
    );
  }

  private onTurnStarted(params: unknown): void {
    const p = params as {
      threadId?: string;
      turnId?: string;
      clientUserMessageId?: string;
    };
    if (!p || p.threadId !== this.threadId || !p.turnId) return;

    // A turn whose cumid matches an in-flight dispatch is OURS — adopt it
    // immediately (early-adopt) so deltas/completions that arrive before
    // the (possibly delayed/lost) turn/start response are captured instead
    // of being misread as an unknown turn. The completion is buffered
    // until startTurn settles (see TrackedTurn.settled).
    if (p.clientUserMessageId && this.awaitingAcceptance.has(p.clientUserMessageId)) {
      const pending = this.awaitingAcceptance.get(p.clientUserMessageId)!;
      if (!this.myTurns.has(p.turnId)) {
        this.myTurns.set(p.turnId, {
          submissionId: pending.submissionId,
          taskId: pending.taskId,
          chunks: [],
          settled: false,
        });
      }
      this.reconciledTurnByCumid.set(p.clientUserMessageId, p.turnId);
      this.emit(`reconcile:${p.clientUserMessageId}`, p.turnId);
      return;
    }
    // Already-adopted turn (normal path) → nothing to do.
    if (this.myTurns.has(p.turnId)) return;

    // Not ours → human took the thread.
    this.humanTurns.add(p.turnId);
    this.scheduler?.onHumanTurnStarted(p.turnId);
  }

  private onDelta(params: unknown): void {
    const p = params as { threadId?: string; turnId?: string; delta?: { text?: string } };
    if (!p || p.threadId !== this.threadId || !p.turnId) return;
    const tracked = this.myTurns.get(p.turnId);
    if (!tracked) return; // human turn deltas are none of our business
    if (typeof p.delta?.text === "string") tracked.chunks.push(p.delta.text);
  }

  private onTurnCompleted(params: unknown): void {
    const p = params as {
      threadId?: string;
      turnId?: string;
      finalText?: string;
      error?: { message?: string };
    };
    if (!p || p.threadId !== this.threadId || !p.turnId) return;

    const tracked = this.myTurns.get(p.turnId);
    if (tracked) {
      const result: { ok: true; replyText: string } | { ok: false; error: string } =
        p.error?.message
          ? { ok: false, error: this.generalizeError("turn/completed", p.error.message) }
          : {
              ok: true,
              replyText:
                typeof p.finalText === "string" && p.finalText.length > 0
                  ? p.finalText
                  : tracked.chunks.join(""),
            };
      if (!tracked.settled) {
        // Completion raced ahead of the dispatch response — buffer it;
        // settleAccepted() flushes once the scheduler holds `accepted`.
        tracked.pendingCompletion = result;
        return;
      }
      this.myTurns.delete(p.turnId);
      this.scheduler?.onAgentTurnFinished(tracked.submissionId, result);
      return;
    }

    if (this.humanTurns.delete(p.turnId)) {
      this.scheduler?.onHumanTurnFinished(p.turnId);
      return;
    }
    // Unknown turn completing — cross-boot leftovers etc.; surface only.
    this.emit("unknown_turn_completed", p.turnId);
  }

  // ──────────────────────────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────────────────────────

  private adoptTurn(
    turnId: string,
    input: { submissionId: string; taskId: string; clientUserMessageId: string },
  ): void {
    this.awaitingAcceptance.delete(input.clientUserMessageId);
    this.reconciledTurnByCumid.delete(input.clientUserMessageId);
    // Early-adopt may have created the entry already (with buffered
    // deltas/completion) — keep it rather than clobbering the buffers.
    if (!this.myTurns.has(turnId)) {
      this.myTurns.set(turnId, {
        submissionId: input.submissionId,
        taskId: input.taskId,
        chunks: [],
        settled: false,
      });
    }
  }

  private awaitReconcile(cumid: string): Promise<string | null> {
    // Check whether the event already arrived while the request promise
    // was rejecting.
    const already = this.reconciledTurnByCumid.get(cumid);
    if (already) return Promise.resolve(already);
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener(`reconcile:${cumid}`, onHit);
        resolve(null);
      }, this.reconcileWindowMs);
      const onHit = (turnId: string) => {
        clearTimeout(timer);
        resolve(turnId);
      };
      this.once(`reconcile:${cumid}`, onHit);
    });
  }
}

// ────────────────────────────────────────────────────────────────────────
// AuthenticatedSender construction — FAIL CLOSED
// ────────────────────────────────────────────────────────────────────────

/** Shape of a CommHub inbox row as get_inbox returns it (Wave 1B adds the
 *  two nullable sender_* columns via the approved principal-stamp
 *  migration; legacy rows have them null/undefined). */
export interface InboxRowLike {
  id: string;
  type?: string | null;
  from_session?: string | null;
  network_id?: string | null;
  sender_token_id?: string | null;
  sender_role?: string | null;
  /** L1 (拍板): the STABLE task id — original tasks.task_id across
   *  retry/reassign re-queues; the row's own id is the messageId. */
  canonical_task_id?: string | null;
}

// A final freeze 90d1e58 role union (Δ14): node = plain ntok minimal
// identity, child = RFC-026 child token. "unknown" is NOT permitted —
// rows that can't be classified stay null-stamped and are refused here.
const VALID_ROLES: ReadonlySet<string> = new Set([
  "admin",
  "owner",
  "member",
  "viewer",
  "node",
  "child",
]);

/**
 * Build an AuthenticatedSender from an inbox row, or return null when the
 * row carries no server-stamped principal. NULL MEANS REFUSE: the caller
 * must not enqueue (refused_invalid_arg). The alias (`from_session`) is
 * display-only and never a substitute for the token principal — a forged
 * alias without a server-side stamp yields null, not a sender.
 */
export function senderFromInboxRow(row: InboxRowLike): AuthenticatedSender | null {
  const tokenId = row.sender_token_id;
  const role = row.sender_role;
  const networkId = row.network_id;
  if (typeof tokenId !== "string" || tokenId.length === 0) return null;
  if (typeof role !== "string" || !VALID_ROLES.has(role)) return null;
  if (typeof networkId !== "string" || networkId.length === 0) return null;
  return {
    alias: typeof row.from_session === "string" && row.from_session.length > 0 ? row.from_session : "(unknown)",
    tokenId,
    role: role as AuthenticatedSender["role"],
    networkId,
  };
}
