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
  /** Username resolved from the authenticated token. */
  authenticatedUsername?: string | null;
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

  // A network-bound token whose name we cannot resolve to an alias (`node:`,
  // `node:   `, or a name that was never node-scoped) is the degenerate case.
  // We know it IS a node credential; we just cannot tell WHICH node. Letting it
  // claim anything is the worst available option, so refuse the claim outright
  // rather than falling through to the unbound path.
  //
  // Production always writes `node:${nodeName}`, so this costs nothing real —
  // but "we couldn't identify you, so you may call yourself anything" is
  // exactly the fail-open shape this change exists to remove.
  if (!alias && input.token.startsWith("ntok_")) {
    if (requested) {
      return {
        ok: false,
        error: "from_session_identity_mismatch",
        message: "network token has no resolvable node alias and may not claim a from_session",
        tokenAlias: "",
        requestedFromSession: requested,
      };
    }
    return { ok: true, fromSession: "api" };
  }

  // A user-token client normally does not need to repeat its identity in every
  // request. Prefer an explicit, backwards-compatible claim when present;
  // otherwise attribute the task to the authenticated username. Falling back
  // to the transport label `api` is reserved for legacy auth contexts where
  // the server genuinely has no user identity.
  if (!alias) {
    const authenticatedUsername = typeof input.authenticatedUsername === "string"
      ? input.authenticatedUsername.trim()
      : "";
    return { ok: true, fromSession: requested || authenticatedUsername || "api" };
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
