// RFC-030 Wave 1B L1 — sender principal resolution (副指挥拍板 2026-07-12).
//
// The AUTHORITATIVE role model for stamping inbox/tasks principal columns.
// Resolution happens at WRITE time, from the authenticated token context +
// the call's effectiveNetId — NEVER from raw token prefixes, from_session,
// args or meta. The display alias is forever display-only and cannot
// participate in authorization.
//
// Role union (closed): owner | admin | member | viewer | node | child
//   - utok (api_tokens.scope='user'): the caller's network_members.role in
//     effectiveNetId. A global system admin (users.role='admin') crossing
//     into a network they are not a member of resolves to 'admin'.
//   - plain ntok (scope='network', no child marker): 'node'. A node token
//     NEVER inherits its owner's owner/admin network role — the token is
//     the node's identity, not the human's.
//   - RFC-026 child token (api_tokens.role='child'): 'child'. That column
//     is only ever written by the child-mint path; for every other token
//     kind it is NULL and never consulted as a network role.
//   - legacy 'full' tokens / no token / anything unresolvable: null — the
//     row is stamped with NULL principal columns; ordinary inbox consumers
//     are unaffected and ONLY the codex gateway fail-closes on it.
//
// This module is deliberately standalone + dependency-injected so BOTH the
// MCP tool layer (tools.ts) and the REST layer (index.ts) share the exact
// same resolution — no site may re-implement it (grep-all-sites SOP).

export type SenderRole = "owner" | "admin" | "member" | "viewer" | "node" | "child";

export interface SenderPrincipal {
  readonly tokenId: string;
  readonly role: SenderRole;
}

/** Minimal DB surface (matches server/src/db.ts `db.get`). */
export interface PrincipalDb {
  get<T>(sql: string, ...params: unknown[]): T | null | undefined;
}

const NETWORK_ROLES = new Set(["owner", "admin", "member", "viewer"]);

/**
 * Resolve the authenticated caller's principal for a write into
 * `effectiveNetId`. Returns null (→ stamp NULL, gateway fail-closed) for
 * anything that cannot be resolved unambiguously. Never throws.
 */
export function resolveSenderPrincipal(
  db: PrincipalDb,
  opts: {
    callerTokenId: string | null | undefined;
    effectiveNetId: string | null | undefined;
  },
): SenderPrincipal | null {
  const tokenId = opts.callerTokenId;
  if (!tokenId) return null;
  try {
    const tok = db.get<{ scope: unknown; role: unknown; user_id: unknown }>(
      "SELECT scope, role, user_id FROM api_tokens WHERE token_id = ?1",
      tokenId,
    );
    if (!tok) return null;

    // RFC-026 child token: api_tokens.role='child' is a kind qualifier
    // written exclusively by the child-mint path.
    if (tok.role === "child") return { tokenId, role: "child" };

    // Plain node token: minimal node identity, never the owner's role.
    if (tok.scope === "network") return { tokenId, role: "node" };

    if (tok.scope === "user") {
      if (typeof tok.user_id !== "string" || tok.user_id.length === 0) return null;
      const netId = opts.effectiveNetId;
      if (netId) {
        const m = db.get<{ role: unknown }>(
          "SELECT role FROM network_members WHERE user_id = ?1 AND network_id = ?2",
          tok.user_id,
          netId,
        );
        if (m && typeof m.role === "string" && NETWORK_ROLES.has(m.role)) {
          return { tokenId, role: m.role as SenderRole };
        }
      }
      // Global system admin legitimately crossing networks.
      const u = db.get<{ role: unknown }>(
        "SELECT role FROM users WHERE user_id = ?1",
        tok.user_id,
      );
      if (u && u.role === "admin") return { tokenId, role: "admin" };
      return null;
    }

    // legacy 'full' scope or anything else — unresolvable, fail closed.
    return null;
  } catch {
    // Resolution failure must never break delivery; the row simply
    // carries no principal and the gateway alone refuses it.
    return null;
  }
}
