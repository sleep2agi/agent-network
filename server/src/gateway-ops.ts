// RFC-030 Wave 1B L1-followup #4 (副指挥 2306718c) — server-side ATOMIC
// conditional dead-letter for the codex gateway inbox pump.
//
// The pump (agent-node) must NOT trust the row-supplied canonical_task_id
// and must NOT sequence ack → fail → audit as separate fallible calls (an
// exception between them loses the task silently). This op is the single
// server-side transaction the production pump calls instead:
//
//   VERIFY (inside the transaction):
//     inbox row exists, un-acked, in the CALLER'S network, and — when the
//     caller supplies a canonicalTaskId — the server's own
//     inbox.canonical_task_id matches it AND the tasks row exists in the
//     same network.
//   THEN, atomically:
//     verified mapping  → ack + tasks.status='failed' (unless already
//                         terminal) + task_events audit  → "dead_lettered"
//     no / untrusted mapping → ack + audit_log quarantine ONLY (no task
//                         mutation — 拍板: 无可信映射只隔离审计)
//                                                        → "quarantined"
//     row not found / foreign network / already acked → NO-OP
//                                                        → "not_found"
//
// The gateway NEVER replies toward from_session for any of these — a
// forged display alias cannot elicit gateway traffic (拍板, unchanged).

import { db, logAudit, logTaskEvent } from "./db.js";

export type DeadLetterOutcome =
  | { outcome: "dead_lettered"; canonicalTaskId: string }
  | { outcome: "quarantined"; reason: "no_mapping" | "mapping_mismatch" | "task_missing" }
  | { outcome: "not_found" };

const TERMINAL_TASK_STATUSES = new Set(["replied", "failed", "cancelled", "expired"]);

export function gatewayDeadLetterInboxRow(args: {
  messageId: string;
  /** Caller's CLAIM — verified against the server's own column, never trusted. */
  canonicalTaskId: string | null;
  networkId: string;
  reason: string;
  actor: string;
}): DeadLetterOutcome {
  return db.transaction<DeadLetterOutcome>(() => {
    const row = db.get<{
      id: string;
      canonical_task_id: string | null;
      network_id: string | null;
      from_session: string | null;
    }>(
      `SELECT id, canonical_task_id, network_id, from_session
       FROM inbox WHERE id = ?1 AND acked = 0`,
      args.messageId,
    );
    // Not found / already consumed / FOREIGN NETWORK → strict no-op. The
    // network check is part of the WHERE-not-match path: a gateway in
    // network A can never ack/fail rows of network B.
    if (!row || (row.network_id ?? null) !== args.networkId) {
      return { outcome: "not_found" };
    }

    const serverCanonical = row.canonical_task_id ?? null;
    const claim = args.canonicalTaskId ?? null;

    const quarantine = (reason: "no_mapping" | "mapping_mismatch" | "task_missing"): DeadLetterOutcome => {
      db.run("UPDATE inbox SET acked = 1 WHERE id = ?1", [args.messageId]);
      logAudit(
        null,
        args.actor,
        "gateway_dead_letter_quarantine",
        "inbox",
        args.messageId,
        `reason=${args.reason}; mapping=${reason}; server_canonical=${serverCanonical ?? "null"}; claim=${claim ?? "null"}`,
        undefined,
        args.networkId,
      );
      return { outcome: "quarantined", reason };
    };

    // No trusted mapping at all → quarantine (audit-only, no task touch).
    if (serverCanonical === null) return quarantine("no_mapping");
    // Caller's claim contradicts the server's truth → the claim is
    // untrusted BY DESIGN; the server column wins, but a contradiction is
    // itself suspicious → quarantine + audit, no task mutation.
    if (claim !== null && claim !== serverCanonical) return quarantine("mapping_mismatch");

    const task = db.get<{ task_id: string; status: string; network_id: string | null }>(
      "SELECT task_id, status, network_id FROM tasks WHERE task_id = ?1",
      serverCanonical,
    );
    if (!task || (task.network_id ?? null) !== args.networkId) {
      return quarantine("task_missing");
    }

    // Verified mapping — the ONE atomic dead-letter: ack + fail + audit.
    db.run("UPDATE inbox SET acked = 1 WHERE id = ?1", [args.messageId]);
    if (!TERMINAL_TASK_STATUSES.has(task.status)) {
      db.run(
        "UPDATE tasks SET status = 'failed', result = ?2, completed_at = datetime('now') WHERE task_id = ?1",
        [serverCanonical, `codex_gateway_dead_letter: ${args.reason}`.slice(0, 500)],
      );
      logTaskEvent(serverCanonical, task.status, "failed", args.actor, `gateway dead-letter: ${args.reason}`);
    } else {
      // Terminal task stays untouched; the ack + audit still land.
      logTaskEvent(serverCanonical, task.status, task.status, args.actor, `gateway dead-letter (task already terminal): ${args.reason}`);
    }
    return { outcome: "dead_lettered", canonicalTaskId: serverCanonical };
  });
}
