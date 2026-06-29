// RFC-027 §2.3 race-free invariant — shared helper for the inbox-
// enqueue lifecycle guard.
//
// PR1.1 (#346) added an `assertNodeActive` helper inside the
// registerTools() closure and applied it at the 6 INSERT INTO inbox
// sites in server/src/tools.ts. PR1.1 review (通信龙 #346 ack) caught
// that the closure scope made the helper unreachable from REST
// handlers in server/src/index.ts — POST /api/task (:1631) and
// POST /api/broadcast (:1706) are dashboard's "Dispatch" entry
// points and bypassed the guard, leaving the §2.3 race open on the
// REST path.
//
// PR1.2a (#346 follow-up) extracts the helper to this module so both
// the MCP tools and the REST handlers can import the same code path,
// per [[feedback_grep_all_sites_before_apply_guard]]: any SQL-level
// guard's helper lives at module scope so every write site
// (MCP + REST + internal db.ts helpers) can use it.
//
// Behaviour:
//   - no nodes row for the alias → ok:true (brand-new alias allowed;
//     could be the first INSERT for a child about to register)
//   - lifecycle_state = 'active' OR NULL (pre-RFC-027 row) → ok:true
//   - anything else (stopping / stopped / stop_failed / deleting) →
//     ok:false + structured `node_not_active` reply
//
// COALESCE on the WHERE keeps NULL-network inbox rows / legacy nodes
// rows correctly scoped (PR1 SF-5 lineage).

import { db } from "./db.js";

export type LifecycleGuardResult =
  | { ok: true }
  | { ok: false; error: "node_not_active"; lifecycle_state: string; alias: string };

export function assertNodeActive(
  sessionAlias: string,
  networkId: string | null,
): LifecycleGuardResult {
  if (!sessionAlias) return { ok: true };
  const row = db.get<{ lifecycle_state: string | null }>(
    networkId
      ? `SELECT lifecycle_state FROM nodes WHERE alias = ?1 AND COALESCE(network_id, ?2) = ?2 LIMIT 1`
      : `SELECT lifecycle_state FROM nodes WHERE alias = ?1 LIMIT 1`,
    ...(networkId ? [sessionAlias, networkId] : [sessionAlias]),
  );
  if (!row) return { ok: true };
  const st = row.lifecycle_state ?? "active";
  if (st === "active") return { ok: true };
  return { ok: false, error: "node_not_active", lifecycle_state: st, alias: sessionAlias };
}
