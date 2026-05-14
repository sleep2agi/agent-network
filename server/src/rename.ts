// ── #84: node rename — Server surface (RFC-010 §4) ──
//
// The server side of the rename 2PC. PHASE 1 (prepare) reserves the new alias
// in the isolated rename_txn table without touching the sessions registry, so
// it is fully rollback-safe (abort just marks the row aborted). PHASE 2
// (commit) atomically switches sessions.alias + nodes.alias old→new and is the
// non-rollbackable point — past commit, recovery is forward-fix only.
//
// Step 1 spec resolution (通信龙-confirmed, #84): the rename_txn row IS the
// audit log (RFC §4 risk #5 alias_rename_log = `WHERE status='committed'`),
// and rename touches api_tokens only cosmetically — the token binds
// user_id+network_id, never the alias, so there is no per-alias binding to
// migrate. This corrects RFC-010 §4 P3's draft "copy utok/ntok binding" line.

import { randomUUID } from "crypto";
import { db } from "./db";
import { getUserNetworkRole, getNetworkMembers } from "./auth";
import { pushEvent } from "./push";

export interface RenameResult {
  ok: boolean;
  txn_id?: string;
  error?: string;
}

function hasWriteAccess(userId: string, networkId: string): boolean {
  const role = getUserNetworkRole(userId, networkId);
  return !!role && role !== "viewer";
}

// PHASE 1 P3 — create a prepared rename_txn row reserving new_alias.
// CAS guard (RFC §4 risk #3 TOCTOU): new_alias must be free both in the
// sessions registry AND among in-flight prepared rename_txn rows.
export function prepareRename(
  userId: string, networkId: string, oldAlias: string, newAlias: string,
): RenameResult {
  if (!hasWriteAccess(userId, networkId)) return { ok: false, error: "no write access to this network" };
  if (!oldAlias || !newAlias) return { ok: false, error: "old and new alias required" };
  if (oldAlias === newAlias) return { ok: false, error: "old and new alias are identical" };

  // old-alias must exist as a session in this network
  const oldSession = db.get<any>(
    "SELECT 1 FROM sessions WHERE network_id = ?1 AND alias = ?2", networkId, oldAlias);
  if (!oldSession) return { ok: false, error: `node "${oldAlias}" not found in this network` };

  // new-alias must not be taken — in sessions OR reserved by another prepared txn
  const newInSessions = db.get<any>(
    "SELECT 1 FROM sessions WHERE network_id = ?1 AND alias = ?2", networkId, newAlias);
  if (newInSessions) return { ok: false, error: `alias "${newAlias}" already in use` };
  const newPrepared = db.get<any>(
    "SELECT txn_id FROM rename_txn WHERE network_id = ?1 AND new_alias = ?2 AND status = 'prepared'",
    networkId, newAlias);
  if (newPrepared) return { ok: false, error: `alias "${newAlias}" already reserved by an in-flight rename` };

  const txnId = `rtxn_${randomUUID().replace(/-/g, "")}`;
  db.run(
    "INSERT INTO rename_txn (txn_id, network_id, old_alias, new_alias, status) VALUES (?1, ?2, ?3, ?4, 'prepared')",
    [txnId, networkId, oldAlias, newAlias]);
  return { ok: true, txn_id: txnId };
}

// PHASE 2 C1 — atomically switch sessions.alias + nodes.alias old→new, mark
// the txn committed. Cosmetic: api_tokens.name label node:<old>→node:<new>
// (idempotent, NOT rollback-critical — the token binds user_id+network_id).
// inbox/tasks/completions keep the old alias (RFC §4 risk #5 — history is
// immutable; queries join rename_txn to show "old → now new").
export function commitRename(userId: string, txnId: string): RenameResult {
  const txn = db.get<any>("SELECT * FROM rename_txn WHERE txn_id = ?1", txnId);
  if (!txn) return { ok: false, error: "rename transaction not found" };
  if (txn.status === "committed") return { ok: true, txn_id: txnId }; // idempotent
  if (txn.status === "aborted") return { ok: false, error: "rename transaction was aborted" };
  if (!hasWriteAccess(userId, txn.network_id)) return { ok: false, error: "no write access to this network" };

  // Defense-in-depth: new-alias still free in sessions (prepare already CAS'd,
  // but a parallel direct registration could have raced in).
  const conflict = db.get<any>(
    "SELECT 1 FROM sessions WHERE network_id = ?1 AND alias = ?2", txn.network_id, txn.new_alias);
  if (conflict) return { ok: false, error: `alias "${txn.new_alias}" was taken since prepare` };

  db.run(
    "UPDATE sessions SET alias = ?1, updated_at = datetime('now') WHERE network_id = ?2 AND alias = ?3",
    [txn.new_alias, txn.network_id, txn.old_alias]);
  db.run(
    "UPDATE nodes SET alias = ?1, updated_at = datetime('now') WHERE network_id = ?2 AND alias = ?3",
    [txn.new_alias, txn.network_id, txn.old_alias]);
  db.run(
    "UPDATE api_tokens SET name = ?1 WHERE network_id = ?2 AND name = ?3",
    [`node:${txn.new_alias}`, txn.network_id, `node:${txn.old_alias}`]);
  db.run(
    "UPDATE rename_txn SET status = 'committed', committed_at = datetime('now') WHERE txn_id = ?1",
    [txnId]);

  // RFC-010 §4.2.1 C4 — broadcast node.renamed SSE. (#84 实施补漏: the Server
  // surface originally missed C4; N站马's dashboard slice needs this event.)
  // Envelope per RFC §3.4: alias = NEW (the post-event truth); data carries
  // old/new + surfaces + history_policy. `type` is also set for consumers that
  // switch on .type (the existing SSE convention). Pushed to both the old- and
  // new-alias streams since the SSE layer is per-session-name (no network-wide
  // broadcast primitive) — whoever watched either name gets the rename.
  const renamedEvent: Record<string, unknown> = {
    type: "node.renamed",
    event: "node.renamed",
    txn_id: txnId,
    alias: txn.new_alias,
    network_id: txn.network_id,
    data: {
      old_alias: txn.old_alias,
      new_alias: txn.new_alias,
      surfaces_updated: ["config", "tmux", "commhub", "dashboard", "batch_prefix", "session_resume"],
      history_policy: "preserve",
    },
  };
  pushEvent(txn.old_alias, renamedEvent, txn.network_id);
  pushEvent(txn.new_alias, renamedEvent, txn.network_id);

  // Also push to every network member's user channel. The dashboard subscribes
  // to /events/<username> (a user channel), NOT the per-node-alias streams — so
  // without this it would never receive node.renamed (#84 SSE channel fix:
  // N站马 confirmed the dashboard listens on the user channel). All members get
  // it, not just the owner, since any member's dashboard should reflect the rename.
  for (const member of getNetworkMembers(txn.network_id)) {
    if (member.username) pushEvent(member.username, renamedEvent, txn.network_id);
  }

  return { ok: true, txn_id: txnId };
}

// PHASE 1 rollback — mark a prepared rename_txn aborted, freeing new_alias.
// Idempotent; refuses to abort an already-committed txn.
export function abortRename(userId: string, txnId: string): RenameResult {
  const txn = db.get<any>("SELECT * FROM rename_txn WHERE txn_id = ?1", txnId);
  if (!txn) return { ok: false, error: "rename transaction not found" };
  if (txn.status === "committed") return { ok: false, error: "rename already committed, cannot abort" };
  if (txn.status === "aborted") return { ok: true, txn_id: txnId }; // idempotent
  if (!hasWriteAccess(userId, txn.network_id)) return { ok: false, error: "no write access to this network" };
  db.run(
    "UPDATE rename_txn SET status = 'aborted', aborted_at = datetime('now') WHERE txn_id = ?1",
    [txnId]);
  return { ok: true, txn_id: txnId };
}
