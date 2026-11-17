import { db } from "./db.js";

export type RulesFileTimeoutReason = "not_pulled" | "pulled_no_ack" | "not_capable";

/** Capability is an advertisement, not proof of which event was lost. Unknown
 * sessions are not called incapable. An observed pull outranks capability. */
export function rulesFileTimeoutReason(pulledAt: number | null, capable: number | null): RulesFileTimeoutReason {
  return pulledAt !== null ? "pulled_no_ack" : capable === 0 ? "not_capable" : "not_pulled";
}

/** Called only at existing expiry sites; introduces no timer or threshold. */
export function expireRulesFileRequest(requestId: string, now: number, error: string): number {
  return db.transaction(() => {
    const row = db.get<{ node_id: string; network_id: string; op: string; pulled_at: number | null }>(
      "SELECT node_id, network_id, op, pulled_at FROM node_rules_requests WHERE request_id = ?1 AND status IN ('pending', 'in_progress')", requestId,
    );
    if (!row) return 0;
    let reason: RulesFileTimeoutReason | null = null;
    if (row.op === "read" || row.op === "write") {
      const session = row.node_id.startsWith("session:")
        ? db.get<{ rules_file_capable: number | null }>("SELECT rules_file_capable FROM sessions WHERE network_id = ?1 AND alias = ?2 ORDER BY updated_at DESC LIMIT 1", row.network_id, row.node_id.slice(8))
        : db.get<{ rules_file_capable: number | null }>(
          `SELECT rules_file_capable FROM sessions WHERE network_id = ?1 AND (node_id = ?2 OR alias =
            (SELECT alias FROM nodes WHERE node_id = ?2 AND network_id = ?1)) ORDER BY updated_at DESC LIMIT 1`, row.network_id, row.node_id,
        );
      reason = rulesFileTimeoutReason(row.pulled_at, session?.rules_file_capable ?? null);
    }
    return db.run(
      "UPDATE node_rules_requests SET status = 'timeout', acked_at = ?1, error = ?2, timeout_reason = ?3 WHERE request_id = ?4 AND status IN ('pending', 'in_progress')",
      [now, error, reason, requestId],
    ).changes ?? 0;
  });
}
