// RFC-030 Wave 1B L1 — gateway inbox pump (Phase-1 consumption policy).
//
// The gateway consumes CommHub inbox rows (get_inbox-shaped) and turns the
// valid ones into typed enqueueTask calls. 副指挥拍板 semantics:
//
//   - Phase-1 type allowlist = ['task']. Anything else (message, reply,
//     broadcast, unknown) is NOT gateway work: it is left un-acked for
//     ordinary runtime consumption and merely counted.
//   - A type='task' row with an INVALID principal (null/forged/unknown
//     role) must NOT be silently skipped in place — a poisoned head-of-
//     queue would occupy the get_inbox LIMIT window forever and starve
//     every good row behind it. Instead it is DEAD-LETTERED:
//       * ack(id)               — removed from the pending window,
//       * markTaskFailed(...)   — the canonical task (when the row maps
//                                 to one) is visibly failed, NOT lost,
//       * audit(entry)          — structured record for the operator.
//     The gateway NEVER replies toward `from_session` for an invalid row
//     — a forged alias must not be able to elicit gateway traffic to an
//     arbitrary display name (拍板: legacy 坏行只审计/隔离, 绝不向 alias
//     回信).
//   - A valid row enqueues with taskId = canonical_task_id (stable across
//     retry/reassign) and messageId = the row's own id (delivery-attempt
//     identity), matching A freeze 90d1e58 contract semantics.
//   - Initial-dispatch rows have canonical_task_id == id; legacy stamped
//     rows without canonical_task_id fall back to id (self-canonical).

import type { AgentTypedContract, EnqueueTaskResult } from "./contract";
import { asMessageId, asTaskId } from "./contract";
import { senderFromInboxRow, type InboxRowLike } from "./bridge-adapter";

export interface DeadLetterEntry {
  readonly messageId: string;
  readonly canonicalTaskId: string | null;
  readonly reason: "invalid_principal";
  /** Display-only; recorded for the audit trail, never replied to. */
  readonly fromSessionDisplay: string | null;
  readonly networkId: string | null;
}

export interface InboxPumpHooks {
  /** Remove the row from the pending get_inbox window. */
  ack(messageId: string): void | Promise<void>;
  /** Visibly fail the canonical task so it is dead-lettered, not lost. */
  markTaskFailed(canonicalTaskId: string, reason: string): void | Promise<void>;
  /** Structured audit record for the operator log. */
  audit(entry: DeadLetterEntry): void | Promise<void>;
}

export interface PumpBatchReport {
  /** Rows enqueued into the gateway (valid principal, type=task). */
  enqueued: Array<{ messageId: string; taskId: string; result: EnqueueTaskResult }>;
  /** type=task rows dead-lettered for invalid principal. */
  deadLettered: DeadLetterEntry[];
  /** Rows outside the Phase-1 type allowlist — left for ordinary runtime. */
  skippedNonTask: number;
}

const PHASE1_TYPE_ALLOWLIST: ReadonlySet<string> = new Set(["task"]);

export interface PumpRow extends InboxRowLike {
  content?: string | null;
}

/**
 * Consume one get_inbox batch. Serial per batch (FIFO order preserved —
 * the scheduler owns concurrency). Returns a report the caller/test can
 * assert starvation-freedom on: after this returns, every type=task row
 * in the batch is either enqueued or dead-lettered — none remains to
 * clog the next LIMIT window.
 */
export async function pumpInboxBatch(
  rows: readonly PumpRow[],
  gateway: Pick<AgentTypedContract, "enqueueTask">,
  hooks: InboxPumpHooks,
): Promise<PumpBatchReport> {
  const report: PumpBatchReport = { enqueued: [], deadLettered: [], skippedNonTask: 0 };

  for (const row of rows) {
    const type = typeof row.type === "string" ? row.type : "";
    if (!PHASE1_TYPE_ALLOWLIST.has(type)) {
      report.skippedNonTask++;
      continue;
    }

    const sender = senderFromInboxRow(row);
    const canonicalTaskId =
      typeof row.canonical_task_id === "string" && row.canonical_task_id.length > 0
        ? row.canonical_task_id
        : row.id; // legacy/initial rows: self-canonical

    if (sender === null) {
      // Dead-letter: ack + visibly fail + audit. NEVER reply to the
      // display alias (see module doc).
      const entry: DeadLetterEntry = {
        messageId: row.id,
        canonicalTaskId: row.canonical_task_id ?? null,
        reason: "invalid_principal",
        fromSessionDisplay: typeof row.from_session === "string" ? row.from_session : null,
        networkId: typeof row.network_id === "string" ? row.network_id : null,
      };
      await hooks.ack(row.id);
      if (entry.canonicalTaskId) {
        // Only rows that verifiably map to a canonical task get a task-
        // level failure mark; legacy rows without the column are audit/
        // quarantine only (拍板: 无可信 task 映射的 legacy 坏行只审计).
        await hooks.markTaskFailed(
          entry.canonicalTaskId,
          "codex_gateway_invalid_principal",
        );
      }
      await hooks.audit(entry);
      report.deadLettered.push(entry);
      continue;
    }

    const result = await gateway.enqueueTask({
      taskId: asTaskId(canonicalTaskId),
      messageId: asMessageId(row.id),
      authenticatedSender: sender,
      text: typeof row.content === "string" ? row.content : "",
    });
    report.enqueued.push({ messageId: row.id, taskId: canonicalTaskId, result });
  }

  return report;
}
