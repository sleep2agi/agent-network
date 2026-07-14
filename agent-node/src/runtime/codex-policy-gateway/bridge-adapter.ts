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
//   - dispatch-response-loss handling: on request timeout, only the legacy
//     extension carrying clientUserMessageId can reconcile exactly; the
//     pinned Codex 0.144 wire has no such field, so loss stays ambiguous
//     (and is never resent),
//   - reverse requests: observed, logged, NEVER answered (they belong to
//     the human TUI; additionally Phase 1 runs approval_policy=never so
//     these should not occur at all — seeing one is itself an anomaly),
//   - constructing AuthenticatedSender from a CommHub inbox row with
//     FAIL-CLOSED semantics: no verified principal → no task. There is NO
//     bypass env (协调 owner decision); dev/test uses explicit fixtures.

import { EventEmitter } from "events";
import { evaluateUpstreamCall } from "./policy";
import type {
  DispatchOutcome,
  GatewayScheduler,
  InboundSourceType,
  TurnDispatcher,
} from "./scheduler";
import type { AuthenticatedSender } from "./contract";
import {
  MAX_HUB_REPLY_TEXT_LENGTH,
  TRUNCATED_REPLY_MARKER,
  boundHubReplyText,
} from "./ledger";

/**
 * R2: raw upstream error.message/error.data NEVER cross into any adapter
 * surface, including the diagnostic sink. Diagnostics receive only a
 * stable failure classification plus a correlation id; client, ledger,
 * and log surfaces receive the same correlation id but no upstream detail.
 */
export interface AdapterDiagnostics {
  newCorrelationId(): string;
  reportInternalError(entry: {
    correlationId: string;
    operation: string;
    /** Sanitized marker only; never the thrown upstream value. */
    error: {
      readonly name: "RedactedUpstreamFailure";
      readonly classification: "upstream_request_failed" | "upstream_turn_failed";
      readonly redacted: true;
    };
  }): void;
}

const MAX_ALIAS_DISPLAY = 64;

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return typeof value === "object" && value !== null
    ? (value as UnknownRecord)
    : null;
}

/** Pinned Codex 0.144 uses `{ turn: { id } }`; flat turnId is legacy-only. */
function extractTurnId(value: unknown): string | null {
  const root = asRecord(value);
  if (!root) return null;
  if ("turn" in root) {
    const turn = asRecord(root.turn);
    return turn && typeof turn.id === "string" && turn.id.length > 0
      ? turn.id
      : null;
  }
  return typeof root.turnId === "string" && root.turnId.length > 0
    ? root.turnId
    : null;
}

function isDispatchTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: unknown }).code;
  if (code === "ETIMEDOUT" || code === "ERR_REQUEST_TIMEOUT") return true;
  // CodexAppServerClient's bounded request timer uses this exact wording.
  return /^codex request 'turn\/start' \(id=\d+\) timed out after \d+ms$/.test(error.message);
}

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

function sanitizeDisplayIdentifier(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9._:-]/g, "?").slice(0, 200);
  return safe.length > 0 ? safe : "(unknown)";
}

/**
 * L3-R6: the adapter's upstream surface is STRUCTURAL — request +
 * event subscription. Standalone/Phase-0 passes a CodexAppServerClient;
 * gateway mode passes the assembly shim (request → A GatewayLifecycle
 * .sendInternal with timeout; on → transport notification fan-out) so
 * every request id comes from THE one UpstreamRequestMux.
 */
export interface UpstreamRpcLike {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  on(event: string, fn: (params: unknown) => void): unknown;
}

export interface BridgeAdapterOptions {
  client: UpstreamRpcLike;
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
  /** Bounded fallback accumulator; never grows beyond the Hub reply limit. */
  text: string;
  textTruncated: boolean;
  /** Authoritative final answer from item/completed phase=final_answer. */
  finalText?: string;
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

function appendBoundedText(tracked: TrackedTurn, chunk: string): void {
  if (tracked.textTruncated || chunk.length === 0) return;
  if (tracked.text.length + chunk.length <= MAX_HUB_REPLY_TEXT_LENGTH) {
    tracked.text += chunk;
    return;
  }
  const prefixLimit = MAX_HUB_REPLY_TEXT_LENGTH - TRUNCATED_REPLY_MARKER.length;
  if (tracked.text.length > prefixLimit) {
    tracked.text = tracked.text.slice(0, prefixLimit);
  } else if (tracked.text.length < prefixLimit) {
    tracked.text += chunk.slice(0, prefixLimit - tracked.text.length);
  }
  tracked.text += TRUNCATED_REPLY_MARKER;
  tracked.textTruncated = true;
}

export class BridgeAdapter extends EventEmitter implements TurnDispatcher {
  private readonly client: UpstreamRpcLike;
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
  /**
   * L3-R8: set when the TUI glue forwards an ALLOWED turn/interrupt for
   * the bound thread while an agent turn is active. The next completion
   * of that agent turn is then classified interrupted_by_human (structured
   * terminal, NO auto-replay) instead of completed/failed. Cleared once
   * consumed — a turn that finished BEFORE the interrupt landed keeps its
   * completed outcome (no false interruption of finished work).
   */
  private humanInterruptPending = false;

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
        this.log(
          `[adapter] upstream failure ${entry.correlationId} op=${entry.operation} class=${entry.error.classification}`,
        );
      },
    };
  }

  /**
   * Return a stable failure summary without ever handing the raw upstream
   * error (including `.message` / `.data`) to a logger or injected sink.
   */
  private generalizeError(
    operation: string,
    classification: "upstream_request_failed" | "upstream_turn_failed",
  ): string {
    let correlationId: string;
    try {
      const candidate = this.diagnostics.newCorrelationId();
      correlationId = /^[A-Za-z0-9._:-]{1,64}$/.test(candidate)
        ? candidate
        : `cx-local-${++this.correlationCounter}`;
    } catch {
      correlationId = `cx-local-${++this.correlationCounter}`;
    }
    try {
      this.diagnostics.reportInternalError({
        correlationId,
        operation,
        error: {
          name: "RedactedUpstreamFailure",
          classification,
          redacted: true,
        },
      });
    } catch {
      // Diagnostics are observational. A broken sink must not expose the
      // raw error or change the scheduler-visible failure classification.
    }
    return `upstream ${operation} failed (ref ${correlationId})`;
  }

  /** Late-bind the scheduler (adapter is constructed first). */
  bindScheduler(scheduler: GatewayScheduler): void {
    this.scheduler = scheduler;
  }

  /**
   * L3-R8 wire hook: A's uds-server glue calls this the moment it FORWARDS
   * an authorizer-ALLOWED `turn/interrupt` upstream for the bound thread.
   * If an agent turn is active, its upcoming completion is reclassified
   * interrupted_by_human (the upstream aborts the turn and still emits a
   * completion). No-op when no agent turn holds the reservation — a human
   * interrupting their own turn is not gateway business.
   */
  noteHumanInterruptForwarded(): void {
    if (this.myTurns.size > 0) {
      this.humanInterruptPending = true;
    }
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
    sourceType?: InboundSourceType;
    sourceId?: string;
  }): Promise<DispatchOutcome> {
    const sourceType = input.sourceType ?? "task";
    const sourceId = sanitizeDisplayIdentifier(input.sourceId ?? input.taskId);
    const idLabel = sourceType === "task" ? "task_id" : "message_id";
    const params = {
      threadId: this.threadId,
      clientUserMessageId: input.clientUserMessageId,
      input: [
        {
          type: "text",
          // RFC-030 §6.4 visible origin prefix — the human in the TUI can
          // always tell which turns came from the Agent Network.
          text: `[Agent Network]\nfrom: ${sanitizeDisplayAlias(input.fromAlias)}\ntype: ${sourceType}\n${idLabel}: ${sourceId}\n\n${input.text}`,
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
      const resp = await this.client.request<unknown>(
        "turn/start",
        params,
        this.dispatchTimeoutMs,
      );
      const turnId = extractTurnId(resp);
      if (!turnId) {
        this.abandonPending(input);
        return { kind: "failed", error: "turn/start response missing turn.id" };
      }
      this.adoptTurn(turnId, input);
      return this.settleAccepted(turnId);
    } catch (e) {
      if (isDispatchTimeout(e)) {
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
        this.abandonPending(input);
        return {
          kind: "ambiguous",
          detail: `turn/start response lost (${this.dispatchTimeoutMs}ms) and no matching turn/started observed within ${this.reconcileWindowMs}ms`,
        };
      }
      this.abandonPending(input);
      return {
        kind: "failed",
        error: this.generalizeError("turn/start", "upstream_request_failed"),
      };
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
          // L3-R8 sentinel: an interrupt that raced the dispatch response
          // lands as interrupted_by_human, not failed.
          if (!pc.ok && pc.error === "__interrupted_by_human__") {
            this.scheduler?.onAgentTurnInterrupted(tracked.submissionId);
            return;
          }
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
    this.client.on("item/completed", (params: unknown) => this.onItemCompleted(params));
    this.client.on("turn/completed", (params: unknown) => this.onTurnCompleted(params));
    this.client.on(
      "reverse_request",
      (value: unknown) => {
        // Phase 1 runs approval_policy=never — a reverse request should not
        // happen. If one does, we record + surface but NEVER answer.
        const rr = asRecord(value);
        if (!rr || typeof rr.id !== "number" || typeof rr.method !== "string") {
          this.log("[adapter] ANOMALY: malformed reverse request under approval=never — not answering");
          this.emit("reverse_request_anomaly", { malformed: true });
          return;
        }
        const methodForLog = rr.method.replace(/[^A-Za-z0-9_./:-]/g, "?").slice(0, 96);
        this.log(
          `[adapter] ANOMALY: reverse request ${methodForLog} (id=${rr.id}) under approval=never — not answering`,
        );
        this.emit("reverse_request_anomaly", {
          id: rr.id,
          method: rr.method,
        });
      },
    );
  }

  private onTurnStarted(params: unknown): void {
    const p = asRecord(params);
    if (!p || p.threadId !== this.threadId) return;
    const turnId = extractTurnId(p);
    if (!turnId) return;
    const legacyCumid =
      typeof p.clientUserMessageId === "string" ? p.clientUserMessageId : null;

    // Legacy extension only: an exact clientUserMessageId can reconcile a
    // lost response. The pinned 0.144 TurnStartedNotification does not
    // contain this field, so real-wire response loss remains ambiguous.
    if (legacyCumid && this.awaitingAcceptance.has(legacyCumid)) {
      const pending = this.awaitingAcceptance.get(legacyCumid)!;
      if (!this.myTurns.has(turnId)) {
        this.myTurns.set(turnId, {
          submissionId: pending.submissionId,
          taskId: pending.taskId,
          text: "",
          textTruncated: false,
          settled: false,
        });
      }
      this.reconciledTurnByCumid.set(legacyCumid, turnId);
      this.emit(`reconcile:${legacyCumid}`, turnId);
      return;
    }
    // Already-adopted turn (normal path) → nothing to do.
    if (this.myTurns.has(turnId)) return;

    // Real 0.144 notifications may race ahead of the turn/start response.
    // The scheduler permits one dispatch at a time, so while exactly one
    // acceptance is pending we can buffer that turn's events. This is NOT
    // response-loss reconciliation: only the later response's turn.id can
    // settle accepted; a timeout still becomes ambiguous/no-resend.
    if (this.awaitingAcceptance.size === 1) {
      const pending = this.awaitingAcceptance.values().next().value as
        | { submissionId: string; taskId: string }
        | undefined;
      if (pending) {
        this.myTurns.set(turnId, {
          submissionId: pending.submissionId,
          taskId: pending.taskId,
          text: "",
          textTruncated: false,
          settled: false,
        });
        return;
      }
    }

    // Not ours → human took the thread.
    this.humanTurns.add(turnId);
    this.scheduler?.onHumanTurnStarted(turnId);
  }

  private onDelta(params: unknown): void {
    const p = asRecord(params);
    if (!p || p.threadId !== this.threadId) return;
    const turnId = extractTurnId(p);
    if (!turnId) return;
    const tracked = this.myTurns.get(turnId);
    if (!tracked) return; // human turn deltas are none of our business
    // Pinned 0.144: delta is a plain string. Keep the old `{text}` form as
    // a narrow compatibility fallback for pre-0.144 fixtures.
    if (typeof p.delta === "string") {
      appendBoundedText(tracked, p.delta);
      return;
    }
    const legacyDelta = asRecord(p.delta);
    if (legacyDelta && typeof legacyDelta.text === "string") {
      appendBoundedText(tracked, legacyDelta.text);
    }
  }

  private onItemCompleted(params: unknown): void {
    const p = asRecord(params);
    if (!p || p.threadId !== this.threadId) return;
    const turnId = extractTurnId(p);
    if (!turnId) return;
    const tracked = this.myTurns.get(turnId);
    if (!tracked) return;
    const item = asRecord(p.item);
    if (
      item?.type === "agentMessage" &&
      item.phase === "final_answer" &&
      typeof item.text === "string"
    ) {
      tracked.finalText = boundHubReplyText(item.text);
    }
  }

  private onTurnCompleted(params: unknown): void {
    const p = asRecord(params);
    if (!p || p.threadId !== this.threadId) return;
    const turnId = extractTurnId(p);
    if (!turnId) return;

    const tracked = this.myTurns.get(turnId);
    if (tracked) {
      // L3-R8: a human interrupt forwarded while THIS agent turn was live
      // wins over completed/failed — the abort-completion the upstream
      // emits after turn/interrupt must land as interrupted_by_human
      // (structured terminal, no reply, no auto-replay). Consumed once.
      if (this.humanInterruptPending) {
        this.humanInterruptPending = false;
        if (tracked.settled) {
          this.myTurns.delete(turnId);
          this.scheduler?.onAgentTurnInterrupted(tracked.submissionId);
          return;
        }
        // Interrupt raced the still-in-flight dispatch response: buffer a
        // sentinel; settleAccepted() flushes it as interrupted_by_human.
        tracked.pendingCompletion = { ok: false, error: "__interrupted_by_human__" };
        return;
      }
      const realTurn = asRecord(p.turn);
      const legacyError = p.error;
      // A real turn/completed is successful only for status=completed and
      // error=null. Missing/unknown terminal status fails closed. Legacy
      // flat fixtures have no nested turn and retain their old error test.
      const failed = realTurn
        ? realTurn.status !== "completed" || realTurn.error != null
        : legacyError != null;
      const legacyFinalText = typeof p.finalText === "string"
        ? boundHubReplyText(p.finalText)
        : undefined;
      const result: { ok: true; replyText: string } | { ok: false; error: string } = failed
        ? {
            ok: false,
            error: this.generalizeError("turn/completed", "upstream_turn_failed"),
          }
        : {
            ok: true,
            replyText:
              tracked.finalText && tracked.finalText.length > 0
                ? tracked.finalText
                : legacyFinalText && legacyFinalText.length > 0
                  ? legacyFinalText
                  : tracked.text,
          };
      if (!tracked.settled) {
        // Completion raced ahead of the dispatch response — buffer it;
        // settleAccepted() flushes once the scheduler holds `accepted`.
        tracked.pendingCompletion = result;
        return;
      }
      this.myTurns.delete(turnId);
      this.scheduler?.onAgentTurnFinished(tracked.submissionId, result);
      return;
    }

    if (this.humanTurns.delete(turnId)) {
      this.scheduler?.onHumanTurnFinished(turnId);
      return;
    }
    // Unknown turn completing — cross-boot leftovers etc.; surface only.
    this.emit("unknown_turn_completed", turnId);
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
    this.humanTurns.delete(turnId);
    // Early-adopt may have created the entry already (with buffered
    // deltas/completion) — keep it rather than clobbering the buffers.
    if (!this.myTurns.has(turnId)) {
      this.myTurns.set(turnId, {
        submissionId: input.submissionId,
        taskId: input.taskId,
        text: "",
        textTruncated: false,
        settled: false,
      });
    }
  }

  /** Drop provisional event buffers when dispatch did not settle accepted. */
  private abandonPending(input: {
    submissionId: string;
    clientUserMessageId: string;
  }): void {
    this.awaitingAcceptance.delete(input.clientUserMessageId);
    this.reconciledTurnByCumid.delete(input.clientUserMessageId);
    for (const [turnId, tracked] of this.myTurns) {
      if (tracked.submissionId === input.submissionId && !tracked.settled) {
        this.myTurns.delete(turnId);
      }
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
// Exhaustive TYPED map (副指挥 f5e0f585): keyed on the frozen contract
// union, so adding/removing a role in A's contract makes this fail to
// compile instead of silently drifting. Runtime uses an own-property check
// so Object.prototype names cannot masquerade as frozen roles.
const VALID_ROLES: Readonly<Record<AuthenticatedSender["role"], true>> = {
  admin: true,
  owner: true,
  member: true,
  viewer: true,
  node: true,
  child: true,
};

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
  if (
    typeof role !== "string" ||
    !Object.prototype.hasOwnProperty.call(VALID_ROLES, role)
  ) return null;
  if (typeof networkId !== "string" || networkId.length === 0) return null;
  return {
    alias: typeof row.from_session === "string" && row.from_session.length > 0 ? row.from_session : "(unknown)",
    tokenId,
    role: role as AuthenticatedSender["role"],
    networkId,
  };
}
