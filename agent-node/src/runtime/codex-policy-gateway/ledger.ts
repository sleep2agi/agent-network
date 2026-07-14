// RFC-030 Wave 1B — durable SQLite ledger for gateway submissions.
//
// State machine (§ dispatch requirement 3):
//
//   received → queued → dispatching → accepted(turnId) → completed
//                                                       ↘ reply_pending → replied
//   any non-terminal state may also go → failed
//   dispatching → ambiguous   (dispatch response lost + cannot reconcile)
//
// Rules encoded here, enforced at transition time:
//   - Transitions outside the table below THROW (programmer error / replay
//     corruption) — the ledger is the arbiter, not the caller.
//   - A submission stuck in `dispatching` at recovery time must NOT be
//     blindly re-dispatched: the turn/start may or may not have reached the
//     server. Recovery either reconciles it against observed thread events
//     (matching clientUserMessageId → accepted) or marks it `ambiguous`.
//   - `ambiguous`, `replied` and `failed` are terminal.
//
// Durability: every transition is a synchronous SQLite write. The concrete
// binding is injected (see sqlite-driver.ts) so tests run against :memory:
// and production picks bun:sqlite / node:sqlite (>=22.13, per A′ decision).

import type { SqliteLike } from "./sqlite-driver";

export type LedgerState =
  | "received"
  | "queued"
  | "dispatching"
  | "accepted"
  | "completed"
  | "reply_pending"
  | "replied"
  | "failed"
  | "ambiguous"
  /** Human pressed the emergency interrupt while an agent task held the
   *  thread (Phase-1 TUI policy). Terminal; MUST NOT be auto-replayed. */
  | "interrupted_by_human"
  /** Agent cancelled its own queued task (cancelQueuedTask) before it was
   *  dispatched. Terminal. Distinct from `failed` so getTaskState maps to
   *  contract `cancelled/cancelledBy:'agent'` (副指挥 P1 roundtrip). */
  | "cancelled";

export type SubmissionOrigin = "human" | "agent";

export type GatewayDeliveryStatus = "replied" | "failed" | "cancelled";
export type GatewayDeliveryCode =
  | "completed"
  | "dispatch_failed"
  | "dispatch_outcome_unknown"
  | "turn_failed"
  | "empty_final_answer"
  | "interrupted_by_human"
  | "cancelled_by_agent"
  | "recovery_payload_invalid";

export interface LedgerRow {
  submissionId: string;
  taskId: string | null;
  origin: SubmissionOrigin;
  fromAlias: string | null;
  /** Durable formal-task payload needed to restore rows known never sent. */
  requestText: string | null;
  /** Original CommHub inbox type. `task` is the only reply-bearing kind. */
  inboundType: "task" | "message" | "reply" | "chained_reply" | "broadcast";
  /** Whether this submission must close a canonical CommHub task. */
  expectsReply: boolean;
  /** Independent reliable-delivery state for success/failure/cancel outcomes. */
  outboundDelivery: "none" | "pending" | "delivered" | "quarantined";
  deliveryStatus: GatewayDeliveryStatus | null;
  deliveryCode: GatewayDeliveryCode | null;
  deliveryText: string | null;
  deliveryAttempts: number;
  terminalAt: number | null;
  deliveryUpdatedAt: number | null;
  deliveredAt: number | null;
  deliveryRefusalCode: string | null;
  state: LedgerState;
  turnId: string | null;
  clientUserMessageId: string | null;
  replyText: string | null;
  error: string | null;
  dispatchAttempts: number;
  createdAt: number;
  updatedAt: number;
}

/** Legal state transitions. Key = from, values = allowed to. */
const LEGAL: Record<LedgerState, LedgerState[]> = {
  received: ["queued", "failed"],
  queued: ["dispatching", "failed", "cancelled"],
  dispatching: ["accepted", "failed", "ambiguous"],
  accepted: ["completed", "failed", "ambiguous", "interrupted_by_human"],
  completed: ["reply_pending", "replied", "failed"],
  reply_pending: ["replied", "failed"],
  replied: [],
  failed: [],
  ambiguous: [],
  interrupted_by_human: [],
  cancelled: [],
};

export const TERMINAL_STATES: ReadonlySet<LedgerState> = new Set([
  "replied",
  "failed",
  "ambiguous",
  "interrupted_by_human",
  "cancelled",
]);

const EXECUTION_TERMINAL_STATES: ReadonlySet<LedgerState> = new Set([
  "completed",
  "replied",
  "failed",
  "ambiguous",
  "interrupted_by_human",
  "cancelled",
]);

export interface RecoveryReport {
  reconciled: LedgerRow[];
  ambiguous: LedgerRow[];
  requeued: LedgerRow[];
  replyPending: LedgerRow[];
}

export class GatewayLedger {
  private db: SqliteLike;

  constructor(db: SqliteLike) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateway_ledger (
        submission_id           TEXT PRIMARY KEY,
        task_id                 TEXT,
        origin                  TEXT NOT NULL CHECK (origin IN ('human','agent')),
        from_alias              TEXT,
        request_text            TEXT,
        inbound_type            TEXT NOT NULL DEFAULT 'task',
        expects_reply           INTEGER NOT NULL DEFAULT 1,
        outbound_delivery       TEXT NOT NULL DEFAULT 'none',
        delivery_status         TEXT,
        delivery_code           TEXT,
        delivery_text           TEXT,
        delivery_attempts       INTEGER NOT NULL DEFAULT 0,
        terminal_at             INTEGER,
        delivery_updated_at     INTEGER,
        delivered_at            INTEGER,
        delivery_refusal_code   TEXT,
        state                   TEXT NOT NULL,
        turn_id                 TEXT,
        client_user_message_id  TEXT,
        reply_text              TEXT,
        error                   TEXT,
        dispatch_attempts       INTEGER NOT NULL DEFAULT 0,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gateway_ledger_state
        ON gateway_ledger(state);
      CREATE INDEX IF NOT EXISTS idx_gateway_ledger_cumid
        ON gateway_ledger(client_user_message_id);
    `);
    // Forward-only additive migration for ledgers created by B before the
    // production recovery path persisted the formal task payload.
    const columns = this.db
      .prepare(`PRAGMA table_info(gateway_ledger)`)
      .all() as Array<Record<string, unknown>>;
    if (!columns.some((column) => column.name === "request_text")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN request_text TEXT`);
    }
    if (!columns.some((column) => column.name === "inbound_type")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN inbound_type TEXT NOT NULL DEFAULT 'task'`);
    }
    if (!columns.some((column) => column.name === "expects_reply")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN expects_reply INTEGER NOT NULL DEFAULT 1`);
    }
    if (!columns.some((column) => column.name === "outbound_delivery")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN outbound_delivery TEXT NOT NULL DEFAULT 'none'`);
    }
    if (!columns.some((column) => column.name === "delivery_status")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN delivery_status TEXT`);
    }
    if (!columns.some((column) => column.name === "delivery_code")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN delivery_code TEXT`);
    }
    if (!columns.some((column) => column.name === "delivery_text")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN delivery_text TEXT`);
    }
    if (!columns.some((column) => column.name === "delivery_attempts")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN delivery_attempts INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.some((column) => column.name === "terminal_at")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN terminal_at INTEGER`);
    }
    if (!columns.some((column) => column.name === "delivery_updated_at")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN delivery_updated_at INTEGER`);
    }
    if (!columns.some((column) => column.name === "delivered_at")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN delivered_at INTEGER`);
    }
    if (!columns.some((column) => column.name === "delivery_refusal_code")) {
      this.db.exec(`ALTER TABLE gateway_ledger ADD COLUMN delivery_refusal_code TEXT`);
    }
  }

  /** Insert a new submission in `received`. Throws on duplicate id. */
  record(input: {
    submissionId: string;
    origin: SubmissionOrigin;
    taskId?: string | null;
    fromAlias?: string | null;
    requestText?: string | null;
    inboundType?: LedgerRow["inboundType"];
    expectsReply?: boolean;
    clientUserMessageId?: string | null;
  }): LedgerRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO gateway_ledger
           (submission_id, task_id, origin, from_alias, request_text,
            inbound_type, expects_reply, outbound_delivery, state,
            client_user_message_id, dispatch_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'none', 'received', ?, 0, ?, ?)`,
      )
      .run(
        input.submissionId,
        input.taskId ?? null,
        input.origin,
        input.fromAlias ?? null,
        input.requestText ?? null,
        input.inboundType ?? "task",
        input.expectsReply === false ? 0 : 1,
        input.clientUserMessageId ?? null,
        now,
        now,
      );
    return this.get(input.submissionId)!;
  }

  /**
   * Transition `submissionId` to `to`. Validates against the current
   * persisted state (not caller memory) and the legality table. Optional
   * patch fields land atomically with the state change.
   */
  transition(
    submissionId: string,
    to: LedgerState,
    patch: {
      turnId?: string;
      replyText?: string;
      error?: string;
      bumpDispatchAttempts?: boolean;
      outbound?: {
        status: GatewayDeliveryStatus;
        code: GatewayDeliveryCode;
        text: string;
      };
    } = {},
  ): LedgerRow {
    const row = this.get(submissionId);
    if (!row) throw new Error(`ledger: unknown submission ${submissionId}`);
    const allowed = LEGAL[row.state] ?? [];
    if (!allowed.includes(to)) {
      throw new Error(
        `ledger: illegal transition ${row.state} → ${to} (submission ${submissionId})`,
      );
    }
    if (patch.outbound) {
      if (!row.expectsReply) {
        throw new Error(`ledger: ordinary submission cannot create an outbound outcome (${submissionId})`);
      }
      if (patch.outbound.text.length === 0) {
        throw new Error(`ledger: outbound outcome text must be non-empty (${submissionId})`);
      }
      if (patch.outbound.text.length > MAX_HUB_REPLY_TEXT_LENGTH) {
        throw new Error(`ledger: outbound outcome text exceeds Hub contract (${submissionId})`);
      }
      const expectedStatus = deliveryStatusForCode(patch.outbound.code);
      if (patch.outbound.status !== expectedStatus) {
        throw new Error(
          `ledger: delivery code ${patch.outbound.code} requires status ${expectedStatus}`,
        );
      }
    }
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE gateway_ledger SET
           state = ?,
           turn_id = COALESCE(?, turn_id),
           reply_text = COALESCE(?, reply_text),
           error = COALESCE(?, error),
           dispatch_attempts = dispatch_attempts + ?,
           outbound_delivery = CASE WHEN ? = 1 THEN 'pending' ELSE outbound_delivery END,
           delivery_status = COALESCE(?, delivery_status),
           delivery_code = COALESCE(?, delivery_code),
           delivery_text = COALESCE(?, delivery_text),
           terminal_at = CASE WHEN ? = 1 THEN COALESCE(terminal_at, ?) ELSE terminal_at END,
           delivery_updated_at = CASE WHEN ? = 1 THEN ? ELSE delivery_updated_at END,
           updated_at = ?
         WHERE submission_id = ?`,
      )
      .run(
        to,
        patch.turnId ?? null,
        patch.replyText ?? null,
        patch.error ?? null,
        patch.bumpDispatchAttempts ? 1 : 0,
        patch.outbound ? 1 : 0,
        patch.outbound?.status ?? null,
        patch.outbound?.code ?? null,
        patch.outbound?.text ?? null,
        EXECUTION_TERMINAL_STATES.has(to) ? 1 : 0,
        now,
        patch.outbound ? 1 : 0,
        now,
        now,
        submissionId,
      );
    return this.get(submissionId)!;
  }

  get(submissionId: string): LedgerRow | null {
    const raw = this.db
      .prepare(`SELECT * FROM gateway_ledger WHERE submission_id = ?`)
      .get(submissionId) as Record<string, unknown> | null | undefined;
    return raw ? toRow(raw) : null;
  }

  /**
   * Latest attempt for a LOGICAL task (freeze 90d1e58: same taskId across
   * retry attempts, one row per messageId/attempt). Ordered by created_at
   * then submission_id for stability.
   */
  getLatestByTaskId(taskId: string): LedgerRow | null {
    const raw = this.db
      .prepare(
        `SELECT * FROM gateway_ledger WHERE task_id = ? ORDER BY created_at DESC, submission_id DESC LIMIT 1`,
      )
      .get(taskId) as Record<string, unknown> | null | undefined;
    return raw ? toRow(raw) : null;
  }

  /** Look up by the clientUserMessageId we stamped on turn/start. */
  getByClientUserMessageId(cumid: string): LedgerRow | null {
    const raw = this.db
      .prepare(`SELECT * FROM gateway_ledger WHERE client_user_message_id = ?`)
      .get(cumid) as Record<string, unknown> | null | undefined;
    return raw ? toRow(raw) : null;
  }

  /** All rows in a given state, FIFO by created_at then id (stable). */
  inState(state: LedgerState): LedgerRow[] {
    const raws = this.db
      .prepare(
        `SELECT * FROM gateway_ledger WHERE state = ? ORDER BY created_at ASC, submission_id ASC`,
      )
      .all(state) as Record<string, unknown>[];
    return raws.map(toRow);
  }

  /** All canonical task outcomes still awaiting the #440 delivery sink. */
  outboundPending(): LedgerRow[] {
    const raws = this.db
      .prepare(
        `SELECT * FROM gateway_ledger
         WHERE expects_reply = 1 AND outbound_delivery = 'pending'
         ORDER BY created_at ASC, submission_id ASC`,
      )
      .all() as Record<string, unknown>[];
    return raws.map(toRow);
  }

  /**
   * Mark a canonical outcome delivered without erasing its terminal meaning.
   * Successful `reply_pending` rows advance to `replied`; failed/ambiguous/
   * cancelled rows retain their state so the frozen getTaskState contract
   * keeps reporting the correct outcome after delivery.
   */
  markOutboundDelivered(submissionId: string): LedgerRow {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE gateway_ledger SET
           state = CASE WHEN state = 'reply_pending' THEN 'replied' ELSE state END,
           outbound_delivery = 'delivered',
           delivered_at = ?,
           delivery_updated_at = ?
         WHERE submission_id = ? AND expects_reply = 1 AND outbound_delivery = 'pending'
           AND delivery_status IS NOT NULL AND delivery_code IS NOT NULL AND delivery_text IS NOT NULL`,
      )
      .run(now, now, submissionId) as { changes?: number | bigint };
    if (Number(result.changes ?? 0) !== 1) {
      throw new Error(`ledger: outbound outcome is not pending (submission ${submissionId})`);
    }
    return this.get(submissionId)!;
  }

  noteOutboundAttempt(submissionId: string): LedgerRow {
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE gateway_ledger SET delivery_attempts = delivery_attempts + 1, delivery_updated_at = ?
         WHERE submission_id = ? AND outbound_delivery = 'pending'`,
      )
      .run(now, submissionId) as { changes?: number | bigint };
    if (Number(result.changes ?? 0) !== 1) {
      throw new Error(`ledger: outbound outcome is not pending (submission ${submissionId})`);
    }
    return this.get(submissionId)!;
  }

  markOutboundQuarantined(submissionId: string, refusalCode: string): LedgerRow {
    if (!/^[a-z0-9_]{1,64}$/.test(refusalCode)) {
      throw new Error("ledger: invalid stable delivery refusal code");
    }
    const now = Date.now();
    const result = this.db
      .prepare(
        `UPDATE gateway_ledger SET
           outbound_delivery = 'quarantined', delivery_refusal_code = ?,
           delivery_updated_at = ?
         WHERE submission_id = ? AND outbound_delivery = 'pending'`,
      )
      .run(refusalCode, now, submissionId) as { changes?: number | bigint };
    if (Number(result.changes ?? 0) !== 1) {
      throw new Error(`ledger: outbound outcome is not pending (submission ${submissionId})`);
    }
    return this.get(submissionId)!;
  }

  /** Recovery-only: atomically make an already-terminal canonical row drainable. */
  private ensureOutboundPending(submissionId: string): LedgerRow {
    const row = this.get(submissionId);
    if (!row || !row.expectsReply) {
      throw new Error(`ledger: cannot recover outbound outcome (${submissionId})`);
    }
    const delivery = recoveryDeliveryFor(row);
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE gateway_ledger SET
           outbound_delivery = 'pending', delivery_status = ?, delivery_code = ?,
           delivery_text = ?, delivery_updated_at = ?
         WHERE submission_id = ? AND expects_reply = 1 AND outbound_delivery = 'none'`,
      )
      .run(delivery.status, delivery.code, delivery.text, now, submissionId);
    return this.get(submissionId)!;
  }

  /**
   * Crash-recovery sweep (boot time).
   *
   *   - `received`/`queued` rows were never sent → `requeued`; assembly
   *     restores them only when the durable payload is present.
   *   - `dispatching` rows had a turn/start in flight when we died. We must
   *     NOT blindly resend. The caller passes `observedTurnByCumid` — a map
   *     of clientUserMessageId → turnId reconstructed from the resumed
   *     thread's events. Match found → transition to `accepted` with that
   *     turnId (`reconciled`). No match → `ambiguous` (terminal; a human or
   *     a later wave decides what to do — the gateway will not guess).
   *   - `accepted` rows cannot be safely reconstructed from Codex 0.144
   *     because Phase 1 has no history query/replay primitive. They become
   *     terminal `ambiguous`, never a blind resend or an infinite fake-live.
   *   - `completed` rows are advanced to `reply_pending`; their answer was
   *     already durably recorded and can be delivered by the H1 sink.
   */
  recover(observedTurnByCumid: ReadonlyMap<string, string>): RecoveryReport {
    // Snapshot first: rows transitioned below must not be reclassified by a
    // later loop in this same recovery pass.
    const receivedAtBoot = this.inState("received");
    const queuedAtBoot = this.inState("queued");
    const dispatchingAtBoot = this.inState("dispatching");
    const acceptedAtBoot = this.inState("accepted");
    const completedAtBoot = this.inState("completed");
    const replyPendingAtBoot = this.inState("reply_pending");
    const terminalOutcomeAtBoot = [
      ...this.inState("failed"),
      ...this.inState("ambiguous"),
      ...this.inState("interrupted_by_human"),
      ...this.inState("cancelled"),
    ];
    const report: RecoveryReport = {
      reconciled: [],
      ambiguous: [],
      requeued: [],
      replyPending: [],
    };
    for (const row of receivedAtBoot) {
      report.requeued.push(this.transition(row.submissionId, "queued"));
    }
    for (const row of queuedAtBoot) {
      report.requeued.push(row);
    }
    for (const row of dispatchingAtBoot) {
      const cumid = row.clientUserMessageId;
      const turnId = cumid ? observedTurnByCumid.get(cumid) : undefined;
      if (turnId) {
        report.reconciled.push(this.transition(row.submissionId, "accepted", { turnId }));
      } else {
        report.ambiguous.push(
          this.transition(row.submissionId, "ambiguous", {
            error: DELIVERY.dispatchUnknown.text,
            ...(row.expectsReply ? { outbound: DELIVERY.dispatchUnknown } : {}),
          }),
        );
      }
    }
    for (const row of acceptedAtBoot) {
      report.ambiguous.push(
        this.transition(row.submissionId, "ambiguous", {
          error: DELIVERY.dispatchUnknown.text,
          ...(row.expectsReply ? { outbound: DELIVERY.dispatchUnknown } : {}),
        }),
      );
    }
    for (const row of completedAtBoot) {
      if (row.expectsReply) {
        const completion = completedDelivery(row.replyText ?? "");
        report.replyPending.push(completion.ok
          ? this.transition(row.submissionId, "reply_pending", {
              outbound: completion.delivery,
            })
          : this.transition(row.submissionId, "failed", {
              error: completion.delivery.text,
              outbound: completion.delivery,
            }));
      } else {
        this.transition(row.submissionId, "replied");
      }
    }
    for (const row of replyPendingAtBoot) {
      if (row.expectsReply && row.outboundDelivery === "none") {
        if ((row.replyText ?? "").length === 0) {
          report.replyPending.push(
            this.transition(row.submissionId, "failed", {
              error: DELIVERY.emptyFinalAnswer.text,
              outbound: DELIVERY.emptyFinalAnswer,
            }),
          );
        } else {
          report.replyPending.push(this.ensureOutboundPending(row.submissionId));
        }
      }
    }
    for (const row of terminalOutcomeAtBoot) {
      if (row.expectsReply && row.outboundDelivery === "none") {
        report.replyPending.push(this.ensureOutboundPending(row.submissionId));
      }
    }
    return report;
  }
}

// ────────────────────────────────────────────────────────────────────────────

function toRow(raw: Record<string, unknown>): LedgerRow {
  return {
    submissionId: String(raw.submission_id),
    taskId: raw.task_id === null || raw.task_id === undefined ? null : String(raw.task_id),
    origin: raw.origin as SubmissionOrigin,
    fromAlias:
      raw.from_alias === null || raw.from_alias === undefined ? null : String(raw.from_alias),
    requestText:
      raw.request_text === null || raw.request_text === undefined ? null : String(raw.request_text),
    inboundType: (raw.inbound_type ?? "task") as LedgerRow["inboundType"],
    expectsReply: Number(raw.expects_reply ?? 1) === 1,
    outboundDelivery: (raw.outbound_delivery ?? "none") as LedgerRow["outboundDelivery"],
    deliveryStatus:
      raw.delivery_status === null || raw.delivery_status === undefined
        ? null
        : (String(raw.delivery_status) as GatewayDeliveryStatus),
    deliveryCode:
      raw.delivery_code === null || raw.delivery_code === undefined
        ? null
        : (String(raw.delivery_code) as GatewayDeliveryCode),
    deliveryText:
      raw.delivery_text === null || raw.delivery_text === undefined
        ? null
        : String(raw.delivery_text),
    deliveryAttempts: Number(raw.delivery_attempts ?? 0),
    terminalAt:
      raw.terminal_at === null || raw.terminal_at === undefined
        ? null
        : Number(raw.terminal_at),
    deliveryUpdatedAt:
      raw.delivery_updated_at === null || raw.delivery_updated_at === undefined
        ? null
        : Number(raw.delivery_updated_at),
    deliveredAt:
      raw.delivered_at === null || raw.delivered_at === undefined
        ? null
        : Number(raw.delivered_at),
    deliveryRefusalCode:
      raw.delivery_refusal_code === null || raw.delivery_refusal_code === undefined
        ? null
        : String(raw.delivery_refusal_code),
    state: raw.state as LedgerState,
    turnId: raw.turn_id === null || raw.turn_id === undefined ? null : String(raw.turn_id),
    clientUserMessageId:
      raw.client_user_message_id === null || raw.client_user_message_id === undefined
        ? null
        : String(raw.client_user_message_id),
    replyText:
      raw.reply_text === null || raw.reply_text === undefined ? null : String(raw.reply_text),
    error: raw.error === null || raw.error === undefined ? null : String(raw.error),
    dispatchAttempts: Number(raw.dispatch_attempts ?? 0),
    createdAt: Number(raw.created_at),
    updatedAt: Number(raw.updated_at),
  };
}

export const DELIVERY = {
  dispatchFailed: {
    status: "failed",
    code: "dispatch_failed",
    text: "Gateway could not start this task.",
  },
  dispatchUnknown: {
    status: "failed",
    code: "dispatch_outcome_unknown",
    text: "Gateway could not confirm whether this task started; it was not replayed.",
  },
  turnFailed: {
    status: "failed",
    code: "turn_failed",
    text: "Gateway could not complete this task.",
  },
  emptyFinalAnswer: {
    status: "failed",
    code: "empty_final_answer",
    text: "Gateway received no final answer for this task.",
  },
  interrupted: {
    status: "cancelled",
    code: "interrupted_by_human",
    text: "The human owner interrupted this task.",
  },
  cancelled: {
    status: "cancelled",
    code: "cancelled_by_agent",
    text: "This queued task was cancelled before it started.",
  },
  recoveryInvalid: {
    status: "failed",
    code: "recovery_payload_invalid",
    text: "Gateway recovery rejected an incomplete durable task record.",
  },
  completed: {
    status: "replied",
    code: "completed",
  },
} as const satisfies Record<string, {
  status: GatewayDeliveryStatus;
  code: GatewayDeliveryCode;
  text?: string;
}>;

function deliveryStatusForCode(code: GatewayDeliveryCode): GatewayDeliveryStatus {
  if (code === "completed") return "replied";
  if (code === "interrupted_by_human" || code === "cancelled_by_agent") return "cancelled";
  return "failed";
}

export const MAX_HUB_REPLY_TEXT_LENGTH = 10_000;
export const TRUNCATED_REPLY_MARKER = "\n\n[Gateway truncated output to 10000 characters.]";

export function boundHubReplyText(replyText: string): string {
  if (replyText.length <= MAX_HUB_REPLY_TEXT_LENGTH) return replyText;
  let end = MAX_HUB_REPLY_TEXT_LENGTH - TRUNCATED_REPLY_MARKER.length;
  const before = replyText.charCodeAt(end - 1);
  const after = replyText.charCodeAt(end);
  if (
    before >= 0xd800 && before <= 0xdbff &&
    after >= 0xdc00 && after <= 0xdfff
  ) {
    end -= 1;
  }
  return replyText.slice(0, end) + TRUNCATED_REPLY_MARKER;
}

export function completedDelivery(replyText: string):
  | { readonly ok: true; readonly delivery: { status: "replied"; code: "completed"; text: string } }
  | { readonly ok: false; readonly delivery: typeof DELIVERY.emptyFinalAnswer } {
  if (replyText.length === 0) {
    return { ok: false, delivery: DELIVERY.emptyFinalAnswer };
  }
  return {
    ok: true,
    delivery: { ...DELIVERY.completed, text: boundHubReplyText(replyText) },
  };
}

function recoveryDeliveryFor(row: LedgerRow): {
  status: GatewayDeliveryStatus;
  code: GatewayDeliveryCode;
  text: string;
} {
  switch (row.state) {
    case "reply_pending":
    case "completed":
      return completedDelivery(row.replyText ?? "").delivery;
    case "ambiguous":
      return DELIVERY.dispatchUnknown;
    case "interrupted_by_human":
      return DELIVERY.interrupted;
    case "cancelled":
      return DELIVERY.cancelled;
    case "failed":
      return DELIVERY.turnFailed;
    default:
      throw new Error(`ledger: no recoverable outbound outcome for state ${row.state}`);
  }
}
