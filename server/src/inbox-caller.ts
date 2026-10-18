import { db } from "./db.js";
import { getUserNetworkRole } from "./auth.js";
import { resolveNodeCaller } from "./create-node.js";
import { resolveCanonicalAlias } from "./rename.js";

type InboxCaller = {
  tokenId?: string | null;
  userId?: string | null;
  networkId?: string | null;
  nodeToken: boolean;
  identityRejected: boolean;
};

/** Inbox reads and ACKs act as the recipient, not as a dispatch target. */
export function resolveInboxCaller(alias: string, caller: InboxCaller):
  { ok: true; alias: string } | { ok: false; error: string } {
  const denied = { ok: false as const, error: "inbox_identity_mismatch" };
  if (caller.identityRejected) return denied;
  const requested = alias.trim();
  if (caller.nodeToken) {
    const node = resolveNodeCaller(caller.tokenId);
    if (node.ok) {
      if (node.networkId !== caller.networkId) return denied;
      const canonical = resolveCanonicalAlias(node.networkId, requested).alias;
      return canonical === node.alias ? { ok: true, alias: node.alias } : denied;
    }
    // Registration tokens are network-scoped human tokens, not node tokens.
    // Missing/foreign/ambiguous node identities never fall back to the issuer.
    if (node.reason !== "not_a_node_token" || !caller.tokenId) return denied;
    const token = db.get<{ name: string | null }>(
      "SELECT name FROM api_tokens WHERE token_id = ?1 AND revoked_at IS NULL", caller.tokenId,
    );
    if (!token || token.name?.startsWith("node:")) return denied;
  }
  // Preserve open-development and legacy global-token mode.
  if (!caller.userId) return { ok: true, alias: requested };
  const user = db.get<{ username: string }>("SELECT username FROM users WHERE user_id = ?1", caller.userId);
  if (user?.username === requested) return { ok: true, alias: requested };
  if (!caller.networkId) return { ok: false, error: "network_id_required" };
  const role = getUserNetworkRole(caller.userId, caller.networkId);
  if (!role) return denied;
  const canonical = resolveCanonicalAlias(caller.networkId, requested).alias;
  if (role === "owner" || role === "admin") return { ok: true, alias: canonical };
  const owned = db.get<{ node_id: string }>(
    "SELECT node_id FROM nodes WHERE alias = ?1 AND network_id = ?2 AND owner_user_id = ?3 LIMIT 1",
    canonical, caller.networkId, caller.userId,
  );
  return owned ? { ok: true, alias: canonical } : denied;
}
