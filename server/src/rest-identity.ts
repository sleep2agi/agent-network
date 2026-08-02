// REST from_session identity binding.
//
// Both transports resolve the same `api_tokens` row through resolveToken, and
// auth.ts already states the invariant:
//
//   "Network-bound node tokens are an identity boundary: they must not spoof
//    another node via from_session."
//
// tools.ts enforced it for MCP (defaultFrom + fromIdentityMismatchReply).
// POST /api/task did not — it took `body.from` verbatim, so any node holding
// its own ntok_ could claim another node's alias. That value is stored on the
// task row and, once sender labels reach the copresence TUIs, rendered to a
// human as an attribution.
//
// This is the same decision expressed as a pure function so every credential
// kind is a directly constructible test input rather than a hand-assembled
// Request (the #503 convention in this codebase).

export interface RestIdentityInput {
  /** Raw bearer token, only its prefix matters (`ntok_` = network-bound). */
  token: string;
  /** `api_tokens.name`; for node tokens it is `node:<alias>`. */
  tokenName: string | null | undefined;
  /** Caller-supplied `body.from`. */
  requestedFrom: unknown;
}

export type RestIdentityResult =
  | { ok: true; fromSession: string }
  | {
      ok: false;
      error: "from_session_identity_mismatch";
      message: string;
      tokenAlias: string;
      requestedFromSession: string;
    };

/** Alias a token is bound to, or null when it is not node-scoped. */
export function nodeAliasForToken(token: string, tokenName: string | null | undefined): string | null {
  if (!token.startsWith("ntok_")) return null;
  if (typeof tokenName !== "string" || !tokenName.startsWith("node:")) return null;
  const alias = tokenName.slice("node:".length).trim();
  return alias || null;
}

export function resolveRestFromSession(input: RestIdentityInput): RestIdentityResult {
  const alias = nodeAliasForToken(input.token, input.tokenName);
  const requested = typeof input.requestedFrom === "string" ? input.requestedFrom.trim() : "";

  // Not a node token: unchanged behaviour. The Dashboard legitimately posts as
  // its logged-in user; tightening that is a separate change with its own
  // compatibility surface.
  if (!alias) {
    return { ok: true, fromSession: requested || "api" };
  }

  // Node token claiming somebody else — refuse rather than silently rewrite,
  // so a misconfigured caller is visible instead of quietly relabelled.
  if (requested && requested !== alias) {
    return {
      ok: false,
      error: "from_session_identity_mismatch",
      message: "network token from_session does not match token-bound node alias",
      tokenAlias: alias,
      requestedFromSession: requested,
    };
  }

  // Node token, no claim or a matching one: bind to the token's own alias.
  return { ok: true, fromSession: alias };
}
