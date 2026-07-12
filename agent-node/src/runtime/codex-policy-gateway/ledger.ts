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
  | "ambiguous";

export type SubmissionOrigin = "human" | "agent";

export interface LedgerRow {
  submissionId: string;
  taskId: string | null;
  origin: SubmissionOrigin;
  fromAlias: string | null;
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
  queued: ["dispatching", "failed"],
  dispatching: ["accepted", "failed", "ambiguous"],
  accepted: ["completed", "failed"],
  completed: ["reply_pending", "replied", "failed"],
  reply_pending: ["replied", "failed"],
  replied: [],
  failed: [],
  ambiguous: [],
};

export const TERMINAL_STATES: ReadonlySet<LedgerState> = new Set([
  "replied",
  "failed",
  "ambiguous",
]);

export interface RecoveryReport {
  reconciled: LedgerRow[];
  ambiguous: LedgerRow[];
  requeued: LedgerRow[];
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
  }

  /** Insert a new submission in `received`. Throws on duplicate id. */
  record(input: {
    submissionId: string;
    origin: SubmissionOrigin;
    taskId?: string | null;
    fromAlias?: string | null;
    clientUserMessageId?: string | null;
  }): LedgerRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO gateway_ledger
           (submission_id, task_id, origin, from_alias, state,
            client_user_message_id, dispatch_attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'received', ?, 0, ?, ?)`,
      )
      .run(
        input.submissionId,
        input.taskId ?? null,
        input.origin,
        input.fromAlias ?? null,
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
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE gateway_ledger SET
           state = ?,
           turn_id = COALESCE(?, turn_id),
           reply_text = COALESCE(?, reply_text),
           error = COALESCE(?, error),
           dispatch_attempts = dispatch_attempts + ?,
           updated_at = ?
         WHERE submission_id = ?`,
      )
      .run(
        to,
        patch.turnId ?? null,
        patch.replyText ?? null,
        patch.error ?? null,
        patch.bumpDispatchAttempts ? 1 : 0,
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

  /**
   * Crash-recovery sweep (boot time).
   *
   *   - `queued` rows survive as-is (they were never sent) → `requeued`.
   *   - `dispatching` rows had a turn/start in flight when we died. We must
   *     NOT blindly resend. The caller passes `observedTurnByCumid` — a map
   *     of clientUserMessageId → turnId reconstructed from the resumed
   *     thread's events. Match found → transition to `accepted` with that
   *     turnId (`reconciled`). No match → `ambiguous` (terminal; a human or
   *     a later wave decides what to do — the gateway will not guess).
   *   - `accepted` rows keep waiting for their turn events (bridge resume
   *     path re-attaches); not touched here.
   */
  recover(observedTurnByCumid: ReadonlyMap<string, string>): RecoveryReport {
    const report: RecoveryReport = { reconciled: [], ambiguous: [], requeued: [] };
    for (const row of this.inState("queued")) {
      report.requeued.push(row);
    }
    for (const row of this.inState("dispatching")) {
      const cumid = row.clientUserMessageId;
      const turnId = cumid ? observedTurnByCumid.get(cumid) : undefined;
      if (turnId) {
        report.reconciled.push(this.transition(row.submissionId, "accepted", { turnId }));
      } else {
        report.ambiguous.push(
          this.transition(row.submissionId, "ambiguous", {
            error:
              "dispatch response lost across restart; no matching turn observed on resumed thread — not resending (would risk a duplicate turn)",
          }),
        );
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
