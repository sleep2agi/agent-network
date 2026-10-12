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
  // Old clients can register a session without ever creating a nodes row.
  // That name is already in use. Sessions have no owner column, so only
  // an administrator or the unique active node-token holder may refresh it.
  // A general token renamed by a heartbeat is not holder evidence (epoch 1).
  if (!row && db.get("SELECT resume_id FROM sessions WHERE network_id=?1 AND alias=?2 LIMIT 1", network, alias)) {
    const actor = db.get<{ role: string; hub_role: string }>(
      `SELECT nm.role, u.role AS hub_role FROM network_members nm JOIN users u ON u.user_id=nm.user_id
       WHERE nm.network_id=?1 AND nm.user_id=?2`, network, user);
    const admin = actor && (actor.role === "owner" || actor.role === "admin" || actor.hub_role === "admin");
    const holders = db.all<{ user_id: string }>(
      `SELECT DISTINCT user_id FROM api_tokens WHERE network_id=?1 AND name=?2 AND scope='network'
       AND bound_node_id IS NULL AND node_identity_epoch IN (0,2) AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > datetime('now'))`, network, `node:${alias}`);
    if (!admin && (holders.length !== 1 || holders[0].user_id !== user)) throw Error("node_owner_mismatch");
  }
  if (!row && db.get(`SELECT token_id FROM api_tokens WHERE network_id=?1 AND name=?2
    AND user_id<>?3 AND node_identity_epoch=2 AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > datetime('now')) LIMIT 1`, network, `node:${alias}`, user)) {
    throw Error("node_owner_mismatch");
  }
  return nodeId ?? row?.node_id;
}
