import { db } from "./db.js";
import { resolveNodeCaller } from "./create-node.js";

/** Active credentials belonging to an immutable node, including verified legacy unbound tokens. */
export function activeNodeTokenIds(nodeId: string, networkId: string): string[] {
  const node = db.get<{ alias: string }>("SELECT alias FROM nodes WHERE node_id=?1 AND network_id=?2", nodeId, networkId);
  if (!node) return [];
  const tokens = db.all<{ token_id: string }>(
    `SELECT token_id FROM api_tokens WHERE network_id=?1 AND scope='network' AND revoked_at IS NULL
       AND (bound_node_id=?2 OR (bound_node_id IS NULL AND name=?3)) ORDER BY token_id`,
    networkId, nodeId, `node:${node.alias}`,
  );
  return tokens.filter(token => {
    const caller = resolveNodeCaller(token.token_id);
    return caller.ok && caller.kind === "node" && caller.nodeId === nodeId && caller.networkId === networkId;
  }).map(token => token.token_id);
}

/** Preserve the dispatch-time freeze; old requests without it use verified node identity. */
export function revokeNodeTokens(nodeId: string, networkId: string, frozenTokenId: string | null): void {
  let ids: string[];
  if (frozenTokenId) {
    const token = db.get<{ bound_node_id: string | null }>(
      "SELECT bound_node_id FROM api_tokens WHERE token_id=?1 AND network_id=?2 AND scope='network' AND revoked_at IS NULL",
      frozenTokenId, networkId,
    );
    // An immutable binding remains sufficient for revocation even after its node row was removed.
    const caller = token && !token.bound_node_id ? resolveNodeCaller(frozenTokenId) : null;
    ids = token?.bound_node_id === nodeId || (caller?.ok && caller.kind === "node" && caller.nodeId === nodeId && caller.networkId === networkId)
      ? [frozenTokenId] : activeNodeTokenIds(nodeId, networkId);
  } else {
    ids = activeNodeTokenIds(nodeId, networkId);
  }
  for (const id of ids) db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1 AND network_id=?2 AND revoked_at IS NULL", [id, networkId]);
}
