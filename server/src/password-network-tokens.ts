import { db } from "./db.js";

export type KeptNetworkToken = {
  token_id: string;
  name: string;
  network_id: string;
  created_at: string;
  last_used_at: string | null;
};

/** Only user-created named network tokens. Node credentials have a different scope or binding. */
export function passwordNetworkTokens(userId: string, currentTokenId: string | null | undefined, revoke: boolean) {
  const where = `user_id = ?1 AND network_id IS NOT NULL AND scope = 'full'
    AND bound_node_id IS NULL AND revoked_at IS NULL
    AND (expires_at IS NULL OR expires_at > datetime('now'))${currentTokenId ? " AND token_id != ?2" : ""}`;
  const params = currentTokenId ? [userId, currentTokenId] : [userId];
  if (revoke) {
    return { revoked: db.run(`DELETE FROM api_tokens WHERE ${where}`, params).changes, kept: [] as KeptNetworkToken[] };
  }
  const kept = db.all<KeptNetworkToken>(
    `SELECT token_id, name, network_id, created_at, last_used_at FROM api_tokens WHERE ${where} ORDER BY created_at DESC, token_id`,
    ...params,
  );
  return { revoked: 0, kept };
}
