import { db } from "./db.js";

// Call inside the caller's transaction. Serialize registration and issuance for
// this alias on PG; SQLite already serializes writes on its single connection.
export function lockNodeAlias(network: string, alias: string, nodeId?: string): void {
  if (db.dialect !== "postgres") return;
  db.get("SELECT pg_advisory_xact_lock(hashtext(?1))", JSON.stringify([network, "alias", alias]));
  if (nodeId) db.get("SELECT pg_advisory_xact_lock(hashtext(?1))", JSON.stringify([network, "id", nodeId]));
}

export function legacyNodeHolder(user: string, network: string, alias: string, nodeId: string): boolean {
  return !!db.get(`SELECT token_id FROM api_tokens WHERE user_id=?1 AND network_id=?2
    AND name=?3 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > datetime('now'))
    AND (bound_node_id=?4 OR (bound_node_id IS NULL AND node_identity_epoch=0)) LIMIT 1`,
    user, network, `node:${alias}`, nodeId);
}

/** Resolve a name-only refresh to the existing identity, never claim its owner. */
export function checkNodeTokenClaim(user: string, network: string, alias: string, nodeId?: string): string | undefined {
  lockNodeAlias(network, alias, nodeId);
  const rows = db.all<{node_id: string; owner_user_id: string | null}>(
    "SELECT node_id, owner_user_id FROM nodes WHERE network_id=?1 AND alias=?2", network, alias);
  if (rows.length > 1 || rows.some(row => nodeId && row.node_id !== nodeId)) throw Error("node_owner_mismatch");
  const row = rows[0];
  // Explicit-ID ownerless claims retain auth.ts's node_owner_unclaimed error;
  // name-only requests need holder evidence before resolving to that ID.
  if (row && (row.owner_user_id ? row.owner_user_id !== user : !nodeId && !legacyNodeHolder(user, network, alias, row.node_id))) {
    throw Error("node_owner_mismatch");
  }
  if (!row && db.get(`SELECT token_id FROM api_tokens WHERE network_id=?1 AND name=?2
    AND user_id<>?3 AND node_identity_epoch=2 AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT 1`, network, `node:${alias}`, user)) {
    throw Error("node_owner_mismatch");
  }
  return nodeId ?? row?.node_id;
}
