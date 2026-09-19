/**
 * #1918 — detect two codex nodes running on the SAME login, before the
 * refresh-token chain breaks under them.
 *
 * Why this exists. The copresence start path deliberately SHARES the host's
 * `~/.codex/auth.json` into each node's CODEX_HOME (see
 * `codex-copresence-preflight.ts`, whose header explains the choice), and
 * `codexHomeStagePlan` leaves a node's own copy alone once it is newer than
 * the host's — because codex refreshes in place.
 *
 * That pair of rules is a one-way sync (host → node) around a value that
 * rotates on the NODE side, and OAuth refresh tokens are one-time:
 *
 *   node A refreshes with RT0  →  server issues RT1 to A and invalidates RT0
 *   A's RT1 never reaches the host, and never reaches node B
 *   node B still holds RT0     →  "refresh token was already used"
 *
 * So with one account on N>1 nodes, whichever node refreshes first keeps
 * working and the rest fail — days later, which is why it reads as a random
 * outage rather than a configuration mistake. Nothing in the product noticed
 * this: before #1918 `refresh_token` appeared in non-test code only inside a
 * comment.
 *
 * 🔴 This module only ever handles the token long enough to hash it. The
 *    fingerprint is `sha256(refresh_token)` truncated to 8 hex — enough to
 *    tell "same credential copy" from "different one", not enough to be a
 *    credential. Nothing here returns, logs, or persists the token itself.
 *
 * 🔴 Why this is not `accountFingerprint`. The repo already fingerprints codex
 *    credentials in `codex-lifecycle-account.ts`, but over `tokens.account_id`
 *    — "which ACCOUNT is this". That cannot answer this question: two nodes may
 *    legitimately share an account_id (same human, two separate logins) and be
 *    perfectly fine, because they hold different refresh tokens and neither
 *    invalidates the other. The refresh token is what identifies one *chain*.
 *    So: same hashing primitive (`shortHash`, reused below), different value,
 *    different question. There is no pre-existing fingerprint over the refresh
 *    token anywhere in the repo — that, and the cross-node comparison, are what
 *    is new here.
 */
import { shortHash } from "./codex-lifecycle-account.js";

/** Per-node record, written into the node dir next to the other state files. */
export const CODEX_AUTH_FINGERPRINT_FILE = ".codex-auth-fingerprint.json";

/** Length of the stored fingerprint. Collisions at 8 hex are ~1 in 4 billion;
 *  a false "these two share a login" warning costs a second look, while the
 *  value staying short keeps it obviously non-reversible in logs. */
export const FINGERPRINT_LENGTH = 8;

export interface CodexAuthFingerprintRecord {
  readonly schema_version: 1;
  readonly alias: string;
  /** sha256(refresh_token) truncated — never the token. */
  readonly fingerprint: string;
  readonly written_at: string;
}

/**
 * Hash the refresh token out of an auth.json body.
 *
 * Accepts both shapes seen in the wild: the current codex layout nests it
 * under `tokens` (`{auth_mode, tokens:{id_token, access_token, refresh_token,
 * account_id}, last_refresh}`), and older/plain bodies put `refresh_token` at
 * the top level. Anything else — unparsable, absent, empty, non-string —
 * returns null, because "we cannot tell" must not be reported as "no
 * collision".
 */
export function fingerprintRefreshToken(authJsonText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const nested = root.tokens;
  const candidates: unknown[] = [
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).refresh_token
      : undefined,
    root.refresh_token,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") {
      // Same primitive the account registry uses (`shortHash` =
      // sha256 → hex → slice), deliberately over a DIFFERENT value — see the
      // header note on account_id vs refresh token.
      return shortHash(c, FINGERPRINT_LENGTH);
    }
  }
  return null;
}

export interface NodeFingerprint {
  readonly alias: string;
  /** null when the node has no auth.json, or one we could not read. */
  readonly fingerprint: string | null;
  /** When the record was written; used to say how stale a claim is. */
  readonly writtenAt?: string | null;
}

/**
 * Other nodes holding the same credential chain as `self`.
 *
 * Records with no fingerprint are skipped rather than grouped: "unknown" is
 * not a match. Self is excluded by alias, so re-reading one's own record is
 * harmless.
 */
export function collidingNodes(
  records: readonly NodeFingerprint[],
  self: NodeFingerprint,
): NodeFingerprint[] {
  if (!self.fingerprint) return [];
  return records.filter(
    (r) => r.alias !== self.alias && !!r.fingerprint && r.fingerprint === self.fingerprint,
  );
}

/**
 * The warning an operator sees at start. Returns [] when nothing collides —
 * callers print exactly what they get, so silence is representable and the
 * "no collision" path cannot accidentally print a scary empty banner.
 *
 * Deliberately a warning and never a refusal: every node on a host shares one
 * login today, so refusing to start would take the whole box down at once
 * over a condition that is survivable until the next refresh.
 */
export function sharedCredentialWarningLines(
  self: NodeFingerprint,
  colliding: readonly NodeFingerprint[],
): string[] {
  if (colliding.length === 0) return [];
  const others = colliding.map((c) => c.alias).sort();
  const list = others.join(", ");
  return [
    `[anet] ⚠ ${self.alias} shares its codex login with: ${list} (refresh fingerprint ${self.fingerprint})`,
    `[anet]   Refresh tokens are one-time: whichever node refreshes first keeps working, and the`,
    `[anet]   others then fail with "refresh token was already used" — days later, not now.`,
    `[anet]   Fix: give this node its own login (codex login --device-auth inside its CODEX_HOME),`,
    `[anet]   or run them on separate accounts. See sleep2agi/agent-network#1918.`,
  ];
}

/**
 * Two different things both read as "codex cannot refresh", and they need
 * opposite remedies. Telling them apart is the whole value of this mapping:
 * treating a transport failure as a rotation conflict sends an operator to
 * copy someone else's auth.json, which is precisely how a shared-credential
 * chain gets created.
 */
export type CodexRefreshFailureKind =
  /** Someone else spent this refresh token first. */
  | "rotation-conflict"
  /** The token endpoint is unreachable — nobody's token is rotating. */
  | "token-endpoint-unreachable";

export interface CodexRefreshFailure {
  readonly kind: CodexRefreshFailureKind;
  readonly lines: string[];
}

/** "already used" — upstream says the token was spent. Matched loosely enough
 *  to survive a re-wording, but it must name the refresh token itself. */
const ROTATION_CONFLICT_RE =
  /refresh[_ ]token[^\n]{0,80}already been used|refresh[_ ]token was already used|could not be refreshed because[^\n]{0,80}already/i;

/** The request never got an answer: DNS, egress, proxy, TLS. Distinct from a
 *  server that answered "no". */
const TOKEN_TRANSPORT_RE =
  /failed to refresh token[^\n]{0,120}error sending request|error sending request for url[^\n]{0,120}oauth\/token/i;

/**
 * Name what actually went wrong with a codex refresh, and say what to do.
 *
 * Returns null for anything else, so callers fall through to whatever they
 * printed before — an unrelated error must pass through unchanged.
 *
 * Order matters: a reuse rejection is a server answer and is checked first; a
 * transport failure means no answer arrived at all.
 */
export function describeCodexRefreshFailure(
  text: string,
  colliding: readonly NodeFingerprint[] = [],
): CodexRefreshFailure | null {
  if (!text) return null;

  if (ROTATION_CONFLICT_RE.test(text)) {
    const who = colliding.length > 0
      ? `This node shares its codex login with: ${colliding.map((c) => c.alias).sort().join(", ")}.`
      : `Another node is very likely using the same codex login.`;
    return {
      kind: "rotation-conflict",
      lines: [
        `[anet] ❌ codex refresh rejected: this refresh token was already spent by someone else.`,
        `[anet]   ${who}`,
        `[anet]   Refresh tokens are one-time — whoever refreshed first invalidated this copy.`,
        `[anet]   Fix: log in again FOR THIS NODE, then restart ONLY the app-server; the bridge`,
        `[anet]   resumes the thread, so the session survives. Do it while the node is idle —`,
        `[anet]   restarting mid-turn loses that turn's answer. See sleep2agi/agent-network#1918.`,
      ],
    };
  }

  if (TOKEN_TRANSPORT_RE.test(text)) {
    return {
      kind: "token-endpoint-unreachable",
      lines: [
        `[anet] ❌ codex could not reach the token endpoint — the refresh request got no answer.`,
        `[anet]   This is an egress problem, not a credential problem: nobody's token is rotating.`,
        `[anet]   Fix: allow this host to reach the OAuth token endpoint (direct, or via the proxy`,
        `[anet]   allowlist — a proxy that only permits the model API will 403 this).`,
        `[anet]   🔴 Copying another node's auth.json is NOT a fix. It does not restore egress, and`,
        `[anet]   it is exactly what creates a shared-credential chain. See sleep2agi/agent-network#1918.`,
      ],
    };
  }

  return null;
}
