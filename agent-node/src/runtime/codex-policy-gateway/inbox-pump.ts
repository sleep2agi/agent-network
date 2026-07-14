// RFC-030 Wave 1B L1-followup — gateway inbox pump: full result/ACK state
// machine + single production demux caller (副指挥 2306718c #2/#3).
//
// ── Result/ACK state machine (#2) ──────────────────────────────────────
// For every type='task' row, the enqueue outcome maps to EXACTLY ONE of:
//
//   accepted / duplicate       → ACK (durable-then-ack: enqueueTask only
//                                resolves after the ledger row is written
//                                synchronously inside the scheduler)
//   refused_queue_full         ┐ NOT acked — row stays in the window;
//   refused_no_owner           ├ reported as `deferred` so the caller
//   refused_shutting_down      ┘ backs off instead of hot-looping
//   refused_invalid_arg        → server-side conditional DEAD-LETTER
//   invalid principal (null /
//     forged / unknown role)   → server-side conditional DEAD-LETTER
//
// ── Dead-letter is a SERVER-side atomic op (#4) ────────────────────────
// The pump NEVER trusts row-supplied canonical_task_id and NEVER runs
// ack→fail→audit as separate fallible steps. `hooks.deadLetter` is the
// server transaction (gatewayDeadLetterInboxRow / gateway_dead_letter MCP
// tool): it re-verifies messageId↔canonical↔network mapping server-side
// and atomically acks + fails + audits (or quarantines audit-only when
// the mapping is untrusted). The gateway NEVER replies toward the display
// alias.
//
// ── Single production demux caller (#3) ────────────────────────────────
// Production consumes ONE mixed get_inbox window per cycle via
// `runGatewayInboxCycle`, preserving the server's row order. type='task'
// rows go through the formal pump; every other row goes to the ordinary
// handler, which durably injects supported content into the SAME scheduler.
// A deferred row never prevents later rows in the finite window from being
// classified, so neither class can starve the other.

import type { AgentTypedContract } from "./contract";
import { asMessageId, asTaskId } from "./contract";
import { senderFromInboxRow, type InboxRowLike } from "./bridge-adapter";
import type {
  GatewayScheduler,
  OrdinaryInboxType,
} from "./scheduler";

export interface DeadLetterRequest {
  readonly messageId: string;
  /** The pump's CLAIM — server re-verifies against its own column. */
  readonly canonicalTaskId: string | null;
  readonly networkId: string | null;
  readonly reason: "invalid_principal" | "refused_invalid_arg";
  /** Display-only; recorded for audit, never replied to. */
  readonly fromSessionDisplay: string | null;
}

export interface DeadLetterResult {
  readonly outcome: "dead_lettered" | "quarantined" | "not_found";
}

export interface InboxPumpHooks {
  /** Durable ack for an accepted/duplicate row. */
  ack(messageId: string): void | Promise<void>;
  /** SERVER-SIDE atomic conditional dead-letter (see module doc). */
  deadLetter(req: DeadLetterRequest): DeadLetterResult | Promise<DeadLetterResult>;
}

export type DeferredReason = "queue_full" | "no_owner" | "shutting_down";

export interface PumpBatchReport {
  /** Newly accepted rows (enqueued this cycle) — acked. */
  enqueued: Array<{ messageId: string; taskId: string }>;
  /** Duplicate re-deliveries — acked without a new attempt. */
  duplicates: Array<{ messageId: string; taskId: string }>;
  /** NOT acked; caller must back off before the next window. */
  deferred: Array<{ messageId: string; reason: DeferredReason }>;
  /** Handed to the server-side dead-letter op. */
  deadLettered: Array<DeadLetterRequest & { result: DeadLetterResult }>;
  /** Rows outside the Phase-1 type allowlist — left for ordinary runtime. */
  skippedNonTask: number;
}

const PHASE1_TYPE_ALLOWLIST: ReadonlySet<string> = new Set(["task"]);
const ORDINARY_TURN_TYPES: ReadonlySet<string> = new Set([
  "message",
  "reply",
  "chained_reply",
  "broadcast",
]);

export interface PumpRow extends InboxRowLike {
  content?: string | null;
}

export interface OrdinaryQuarantineRequest {
  readonly messageId: string;
  readonly reason: "invalid_principal" | "refused_invalid_arg";
}

export interface OrdinaryInboxHooks {
  ack(messageId: string): void | Promise<void>;
  /** H1 audit-only disposition; it MUST NEVER mutate a canonical task. */
  quarantine(
    request: OrdinaryQuarantineRequest,
  ): DeadLetterResult | Promise<DeadLetterResult>;
}

export type OrdinaryInboxDisposition =
  | { readonly outcome: "accepted" | "duplicate" }
  | { readonly outcome: "deferred"; readonly reason: DeferredReason }
  | { readonly outcome: "quarantined"; readonly result: DeadLetterResult };

/**
 * Durable non-task ingress used by the production ordinary handler.
 * Known content types enter the same scheduler as formal tasks and ACK only
 * after the ledger write. Invalid/unsupported rows use the server-owned
 * quarantine operation with no canonical/network/alias claim, so this path
 * can never fail or route an unrelated Hub task from row-supplied metadata.
 */
export async function injectOrdinaryInboxRow(
  row: PumpRow,
  gateway: Pick<GatewayScheduler, "injectMessage">,
  hooks: OrdinaryInboxHooks,
): Promise<OrdinaryInboxDisposition> {
  const quarantine = async (
    reason: DeadLetterRequest["reason"],
  ): Promise<OrdinaryInboxDisposition> => {
    const result = await hooks.quarantine({
      messageId: row.id,
      reason,
    });
    return { outcome: "quarantined", result };
  };

  const rowType = typeof row.type === "string" ? row.type : "";
  if (!ORDINARY_TURN_TYPES.has(rowType)) {
    return quarantine("refused_invalid_arg");
  }
  const sender = senderFromInboxRow(row);
  if (sender === null) return quarantine("invalid_principal");

  const result = await gateway.injectMessage({
    messageId: row.id,
    authenticatedSender: sender,
    type: rowType as OrdinaryInboxType,
    text: typeof row.content === "string" ? row.content : "",
  });
  switch (result.outcome) {
    case "accepted":
      await hooks.ack(row.id);
      return { outcome: result.duplicate ? "duplicate" : "accepted" };
    case "refused_queue_full":
      return { outcome: "deferred", reason: "queue_full" };
    case "refused_no_owner":
      return { outcome: "deferred", reason: "no_owner" };
    case "refused_shutting_down":
      return { outcome: "deferred", reason: "shutting_down" };
    case "refused_invalid_arg":
      return quarantine("refused_invalid_arg");
  }
}

/**
 * Consume the task rows of one get_inbox batch. Serial, FIFO order.
 * Post-condition: every type='task' row is acked, dead-lettered, or
 * explicitly deferred — nothing is silently dropped or mislabeled.
 */
export async function pumpInboxBatch(
  rows: readonly PumpRow[],
  gateway: Pick<AgentTypedContract, "enqueueTask">,
  hooks: InboxPumpHooks,
): Promise<PumpBatchReport> {
  const report: PumpBatchReport = {
    enqueued: [],
    duplicates: [],
    deferred: [],
    deadLettered: [],
    skippedNonTask: 0,
  };

  for (const row of rows) {
    const type = typeof row.type === "string" ? row.type : "";
    if (!PHASE1_TYPE_ALLOWLIST.has(type)) {
      report.skippedNonTask++;
      continue;
    }

    const canonicalClaim =
      typeof row.canonical_task_id === "string" && row.canonical_task_id.length > 0
        ? row.canonical_task_id
        : null;
    const networkId = typeof row.network_id === "string" ? row.network_id : null;

    const deadLetter = async (reason: DeadLetterRequest["reason"]) => {
      const req: DeadLetterRequest = {
        messageId: row.id,
        canonicalTaskId: canonicalClaim,
        networkId,
        reason,
        fromSessionDisplay: typeof row.from_session === "string" ? row.from_session : null,
      };
      const result = await hooks.deadLetter(req);
      report.deadLettered.push({ ...req, result });
    };

    const sender = senderFromInboxRow(row);
    if (sender === null) {
      await deadLetter("invalid_principal");
      continue;
    }

    // Initial dispatch rows are self-canonical (id == canonical); legacy
    // stamped rows without the column fall back to the row id.
    const taskId = canonicalClaim ?? row.id;
    const result = await gateway.enqueueTask({
      taskId: asTaskId(taskId),
      messageId: asMessageId(row.id),
      authenticatedSender: sender,
      text: typeof row.content === "string" ? row.content : "",
    });

    switch (result.outcome) {
      case "accepted": {
        // Durable (ledger row written synchronously before enqueueTask
        // resolves) → NOW ack.
        await hooks.ack(row.id);
        if (result.duplicate) report.duplicates.push({ messageId: row.id, taskId });
        else report.enqueued.push({ messageId: row.id, taskId });
        break;
      }
      case "refused_queue_full":
        report.deferred.push({ messageId: row.id, reason: "queue_full" });
        break;
      case "refused_no_owner":
        report.deferred.push({ messageId: row.id, reason: "no_owner" });
        break;
      case "refused_shutting_down":
        report.deferred.push({ messageId: row.id, reason: "shutting_down" });
        break;
      case "refused_invalid_arg":
        await deadLetter("refused_invalid_arg");
        break;
    }
  }

  return report;
}

// ────────────────────────────────────────────────────────────────────────
// Single production inbox cycle (#3)
// ────────────────────────────────────────────────────────────────────────

export interface GatewayInboxCycleReport extends PumpBatchReport {
  /** Non-task rows handed to the ordinary runtime handler this cycle. */
  ordinaryDelivered: number;
}

/**
 * THE production consumer for a gateway node's mixed inbox window.
 * Demux contract:
 *   type='task'                  → gateway pump (ack/dead-letter/defer)
 *   message/reply/broadcast/etc. → `ordinaryHandler` verbatim, which owns
 *                                  its own ack — the gateway must neither
 *                                  ack nor drop rows it does not consume.
 * The loop preserves CommHub FIFO across task/message/reply/broadcast while
 * still visiting later rows after a defer. Each individual row owns its
 * durable ACK/dead-letter decision before the loop advances.
 */
export async function runGatewayInboxCycle(
  rows: readonly PumpRow[],
  gateway: Pick<AgentTypedContract, "enqueueTask">,
  hooks: InboxPumpHooks,
  ordinaryHandler: (row: PumpRow) => void | Promise<void>,
): Promise<GatewayInboxCycleReport> {
  const report: GatewayInboxCycleReport = {
    enqueued: [],
    duplicates: [],
    deferred: [],
    deadLettered: [],
    skippedNonTask: 0,
    ordinaryDelivered: 0,
  };
  for (const row of rows) {
    if (typeof row.type === "string" && PHASE1_TYPE_ALLOWLIST.has(row.type)) {
      const one = await pumpInboxBatch([row], gateway, hooks);
      report.enqueued.push(...one.enqueued);
      report.duplicates.push(...one.duplicates);
      report.deferred.push(...one.deferred);
      report.deadLettered.push(...one.deadLettered);
      continue;
    }
    await ordinaryHandler(row);
    report.ordinaryDelivered += 1;
  }
  return report;
}
