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
 * 🔴 WHERE THIS RUNS, and why the file exists twice.
 *    The first cut of #1918 called all of this from `agent-network/bin/cli.ts`
 *    only — the `anet node start --copresence` path. A read-only inventory of a
 *    real 35-node fleet then found that **4** nodes start that way and **31**
 *    do not: their bridges are `node …/agent-node/dist/cli.js --config …` run
 *    straight from a custom script, beside a bare `codex app-server`. Every
 *    node sharing one account was in the 31. The guard was inert exactly where
 *    it was needed, and "install the new package" did not deliver it.
 *
 *    agent-node is where both paths meet (anet's copresence route re-enters as
 *    agent-node), so the check belongs there — and it must keep working from
 *    the CLI too. The two packages cannot import each other: agent-node does
 *    not depend on `@sleep2agi/agent-network`, and `grok-build-drift.test.ts`
 *    forbids the reverse. The repo's existing answer to that is a byte-identical
 *    copy pinned by a parity test (`telemetry-source-parity.test.ts`, #1727),
 *    so this file follows it: `agent-node/src/codex-auth-fingerprint.ts` is the
 *    same bytes, and `codex-auth-fingerprint-parity.test.ts` goes red the moment
 *    one side drifts. For that to hold the module depends on nothing but node
 *    builtins — including the hash, which is the same computation as
 *    `shortHash` in `codex-lifecycle-account.ts` (pinned by a test there rather
 *    than by an import).
 *
 *    `checkCodexCredentialSharing` below is the whole operation — read, record,
 *    compare, warn — so neither caller carries logic that can drift from the
 *    other. Call sites are one line each.
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
 *    Measured on that same fleet: 19 nodes on one account held 16 distinct
 *    refresh tokens — fingerprinting the account would have lit up all 19.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Per-node record, written into the node dir next to the other state files. */
export const CODEX_AUTH_FINGERPRINT_FILE = ".codex-auth-fingerprint.json";

/** Length of the stored fingerprint. Collisions at 8 hex are ~1 in 4 billion;
 *  a false "these two share a login" warning costs a second look, while the
 *  value staying short keeps it obviously non-reversible in logs. */
export const FINGERPRINT_LENGTH = 8;

/** Access tokens measured on the reference fleet: `exp - iat` was exactly this,
 *  on 29 of 29 samples, with no jitter. Used only to phrase "how long until the
 *  shared copy dies" when we have an `exp` but no `iat`. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 864_000;

/** Same computation as `shortHash` in codex-lifecycle-account.ts. Inlined so
 *  this module stays copyable byte-for-byte into agent-node; the equivalence is
 *  pinned by a test rather than by an import. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CodexAuthFingerprintRecord {
  readonly schema_version: 1 | 2;
  readonly alias: string;
  /** sha256(refresh_token) truncated — never the token. */
  readonly fingerprint: string;
  readonly written_at: string;
  /** v2: when this copy's ACCESS token expires, ISO-8601, or null if unreadable.
   *  A timestamp, not a credential. Two nodes holding one copied file share this
   *  instant exactly — which is how "they stop together" becomes observable. */
  readonly access_expires_at?: string | null;
  /** v2: the CODEX_HOME this record was read from. Distinguishes "two copies of
   *  one credential" from "two nodes pointed at one directory", which need
   *  different fixes. */
  readonly codex_home?: string | null;
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
      return sha256Hex(c).slice(0, FINGERPRINT_LENGTH);
    }
  }
  return null;
}

/**
 * When this copy's access token expires, read out of the JWT's own payload.
 *
 * The signature is NOT verified and nothing here authenticates: we are reading
 * a timestamp the token states about itself, the same way `jwt.io` would. A
 * token that is not a JWT, or carries no numeric `exp`, yields null — unknown
 * stays unknown.
 */
export function accessTokenExpiry(authJsonText: string): Date | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(authJsonText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const root = parsed as Record<string, unknown>;
  const nested = root.tokens;
  const raw = [
    nested && typeof nested === "object" && !Array.isArray(nested)
      ? (nested as Record<string, unknown>).access_token
      : undefined,
    root.access_token,
  ].find((v) => typeof v === "string" && v.trim() !== "");
  if (typeof raw !== "string") return null;
  const parts = raw.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8")) as Record<string, unknown>;
    const exp = payload.exp;
    if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
    return new Date(exp * 1000);
  } catch {
    return null;
  }
}

export interface NodeFingerprint {
  readonly alias: string;
  /** null when the node has no auth.json, or one we could not read. */
  readonly fingerprint: string | null;
  /** When the record was written; used to say how stale a claim is. */
  readonly writtenAt?: string | null;
  /** When this copy's access token expires, if we could read it. */
  readonly accessExpiresAt?: Date | null;
  /** The CODEX_HOME this fingerprint came from, if known. */
  readonly codexHome?: string | null;
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

function humanDuration(ms: number): string {
  const abs = Math.abs(ms);
  const days = Math.floor(abs / 86_400_000);
  const hours = Math.floor((abs % 86_400_000) / 3_600_000);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  const minutes = Math.floor((abs % 3_600_000) / 60_000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

/**
 * The warning an operator sees at start. Returns [] when nothing collides —
 * callers print exactly what they get, so silence is representable and the
 * "no collision" path cannot accidentally print a scary empty banner.
 *
 * Deliberately a warning and never a refusal: every node on a host shares one
 * login today, so refusing to start would take the whole box down at once
 * over a condition that is survivable until the next refresh.
 *
 * 🔴 Two outcomes, and the wrong one is actively misleading. The default text
 *    ("whichever node refreshes first keeps working") assumes refresh WORKS.
 *    On a host that cannot reach the OAuth token endpoint — egress blocked, or
 *    a proxy that allowlists the model API and 403s everything else — nobody
 *    refreshes, and the nodes holding one copy do not degrade one at a time:
 *    they stop together the moment the shared access token expires. Field case:
 *    three nodes whose auth.json files were byte-identical, carrying one access
 *    token, all expired at the same instant.
 *
 *    We do NOT probe the network to tell these apart — a start path is the wrong
 *    place to open a socket, and a probe would answer for this moment rather
 *    than for the window that matters. We branch on evidence already in the
 *    file: an access token whose `exp` has passed is a copy that demonstrably
 *    stopped being refreshed, which is the observable the field case exhibits.
 *    When `exp` is still in the future we cannot prove reachability either way,
 *    and the default wording is the right one to print.
 */
export function sharedCredentialWarningLines(
  self: NodeFingerprint,
  colliding: readonly NodeFingerprint[],
  now: Date = new Date(),
): string[] {
  if (colliding.length === 0) return [];
  const list = colliding.map((c) => c.alias).sort().join(", ");
  const expiry = self.accessExpiresAt ?? null;
  // "Demonstrably stopped being refreshed" — the observable the unreachable
  // case exhibits. Not a claim about the network, which we do not probe.
  const stalled = !!expiry && expiry.getTime() <= now.getTime();
  // Same directory, not merely the same bytes: re-logging in "inside its
  // CODEX_HOME" would overwrite the neighbour's credential, so that advice
  // must not be printed for this shape.
  const sharedHome = !!self.codexHome && colliding.some((c) => c.codexHome === self.codexHome);

  const lines = [
    `[anet] ⚠ ${self.alias} shares its codex login with: ${list} (refresh fingerprint ${self.fingerprint})`,
  ];

  if (stalled) {
    lines.push(
      `[anet]   This copy's access token expired ${humanDuration(now.getTime() - expiry!.getTime())} ago and nothing`,
      `[anet]   refreshed it. When a host cannot reach the OAuth token endpoint, a shared login does`,
      `[anet]   not fail one node at a time — every node holding this copy stops together.`,
      `[anet]   Fix: restore egress to the token endpoint first (a proxy that allows only the model`,
      `[anet]   API will 403 it). Copying another node's auth.json is not a fix — it is what created`,
      `[anet]   the sharing.`,
    );
  } else {
    lines.push(
      `[anet]   Refresh tokens are one-time: whichever node refreshes first keeps working, and the`,
      `[anet]   others then fail with "refresh token was already used" — days later, not now.`,
    );
    if (expiry) {
      lines.push(
        `[anet]   (this copy's access token expires in ${humanDuration(expiry.getTime() - now.getTime())}, at ${expiry.toISOString()})`,
      );
    }
  }

  if (sharedHome) {
    lines.push(
      `[anet]   These nodes also share one CODEX_HOME (${self.codexHome}) — a login inside it would`,
      `[anet]   overwrite the other node's credential, so each needs its own home first.`,
    );
  } else {
    lines.push(
      `[anet]   Give this node its own login (codex login --device-auth inside its CODEX_HOME), or`,
      `[anet]   run them on separate accounts.`,
    );
  }
  lines.push(`[anet]   See sleep2agi/agent-network#1918.`);
  return lines;
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

/** Write the record 0600, atomically, so a reader never sees a half file and a
 *  crash never leaves a stale value behind under a fresh name. */
function writeRecord(path: string, record: CodexAuthFingerprintRecord): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

export interface CodexCredentialSharingCheck {
  /** This node's own directory — where its record is written. */
  readonly nodeDir: string;
  /** Shown to the operator; also how a node recognises its own record. */
  readonly alias: string;
  /** The CODEX_HOME whose auth.json this node will actually use. */
  readonly codexHome: string;
  /** Where the warning goes. Defaults to stderr. */
  readonly say?: (message: string) => void;
  /** Injected for tests; production passes nothing. */
  readonly now?: Date;
}

/**
 * The whole operation: read this node's credential, publish an 8-hex record,
 * read what the *other* nodes published, and warn if any of them is on the
 * same chain. Returns the colliding nodes so a caller can name them again if
 * codex later fails to refresh.
 *
 * 🔴 Reads the neighbours' published fingerprint files, never their
 *    credentials. A guard against credential sharing must not itself become a
 *    reason to open every node's auth.json.
 *
 * 🔴 Always recomputes. The fingerprint changes every time codex refreshes in
 *    place, so a stale record is a wrong answer; both call paths may run for
 *    one node in sequence, and whichever runs last must leave the current
 *    value, never an older one.
 *
 * Never throws and never refuses: observability must not be the reason a node
 * will not start.
 */
export function checkCodexCredentialSharing(opts: CodexCredentialSharingCheck): NodeFingerprint[] {
  const say = opts.say ?? ((m: string) => console.error(m));
  const now = opts.now ?? new Date();

  let authText: string;
  try {
    authText = readFileSync(join(opts.codexHome, "auth.json"), "utf-8");
  } catch {
    // No auth.json yet, or unreadable. Nothing to compare — the sign-in
    // blocker elsewhere already speaks to that case.
    return [];
  }

  const self: NodeFingerprint = {
    alias: opts.alias,
    fingerprint: fingerprintRefreshToken(authText),
    accessExpiresAt: accessTokenExpiry(authText),
    codexHome: opts.codexHome,
  };
  if (!self.fingerprint) return [];

  const selfDirName = basename(opts.nodeDir);
  const root = dirname(opts.nodeDir);

  // Publish ours first, so a node that starts second can see this one.
  try {
    writeRecord(join(opts.nodeDir, CODEX_AUTH_FINGERPRINT_FILE), {
      schema_version: 2,
      alias: opts.alias,
      fingerprint: self.fingerprint,
      written_at: now.toISOString(),
      access_expires_at: self.accessExpiresAt ? self.accessExpiresAt.toISOString() : null,
      codex_home: opts.codexHome,
    });
  } catch (e) {
    say(`[anet] ⚠ could not record the codex credential fingerprint: ${(e as Error).message}`);
  }

  const others: NodeFingerprint[] = [];
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { return []; }
  for (const entry of entries) {
    if (entry === selfDirName) continue;
    try {
      const raw = readFileSync(join(root, entry, CODEX_AUTH_FINGERPRINT_FILE), "utf-8");
      const parsed = JSON.parse(raw) as Partial<CodexAuthFingerprintRecord>;
      if (typeof parsed?.fingerprint !== "string") continue;
      const expires = typeof parsed.access_expires_at === "string" ? new Date(parsed.access_expires_at) : null;
      others.push({
        alias: typeof parsed.alias === "string" && parsed.alias ? parsed.alias : entry,
        fingerprint: parsed.fingerprint,
        writtenAt: typeof parsed.written_at === "string" ? parsed.written_at : null,
        // v1 records carry neither field; absent stays absent rather than
        // becoming a wrong value.
        accessExpiresAt: expires && !Number.isNaN(expires.getTime()) ? expires : null,
        codexHome: typeof parsed.codex_home === "string" ? parsed.codex_home : null,
      });
    } catch { /* no record, or unreadable — not a match, and not an error */ }
  }

  const colliding = collidingNodes(others, self);
  for (const line of sharedCredentialWarningLines(self, colliding, now)) say(line);
  return colliding;
}
