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
 *
 * 🔴 WHY THE READ SIDE IS HOST-WIDE, not a sibling scan.
 *    The first two cuts compared against `dirname(nodeDir)` — the other nodes
 *    under the same `.anet/nodes/` root. On the reference fleet those 35 nodes
 *    live in **27 separate workspaces**, 25 of which hold exactly one node. Of
 *    the 8 nodes in the three real shared-credential groups, a sibling scan can
 *    see **2** — a single pair that happens to share a workspace. The group that
 *    prompted all of this (three nodes whose auth.json files are byte-identical)
 *    is spread across three workspaces and was completely invisible. A guard
 *    that runs on every launch path but only looks inside its own workspace is
 *    still blind to the thing it exists to find.
 *
 *    So each node also publishes into a host-wide index under `~/.anet/`, which
 *    this repo already treats as host-scoped, cwd-independent state (the global
 *    config lives there). The sibling scan is kept as well: it costs one readdir
 *    and still works for a node whose index write failed. Records from both are
 *    merged and de-duplicated by canonical node directory.
 */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** Per-node record, written into the node dir next to the other state files. */
export const CODEX_AUTH_FINGERPRINT_FILE = ".codex-auth-fingerprint.json";

/**
 * Host-wide index of the same records — the read side's source of truth.
 *
 * Under `~/.anet/` because that is already this repo's host-scoped state
 * directory (global config lives there) and it does not move with `cwd`, which
 * is the entire point: the nodes that need to see each other are in different
 * workspaces.
 */
export function codexFingerprintIndexDir(home: string = homedir()): string {
  return join(home, ".anet", "codex-auth-fingerprints");
}

/**
 * Index filename for a node.
 *
 * 🔴 Derived from the node's DIRECTORY, never its alias. Aliases are not unique
 *    across workspaces — the reference fleet runs a node beside its own `2号`
 *    twin, and nothing stops two workspaces from using one name — so an
 *    alias-keyed file would let one node silently overwrite another's record,
 *    re-creating the very blindness this index fixes. A directory cannot be two
 *    nodes.
 *
 * 🔴 And derived from the directory rather than from `node_id`, even though the
 *    CLI has one handy: agent-node's `NODE_ID` can be empty (older configs), so
 *    a node_id key would need a fallback — and then the same node would write
 *    one filename from one launch path and a different one from the other,
 *    leaving two records that look like two nodes sharing a credential. One
 *    deterministic key from an input both call sites already have is worth more
 *    than a prettier name. `node_id` is still recorded, for humans.
 */
export function codexFingerprintIndexFile(nodeDir: string): string {
  return `${createHash("sha256").update(canonicalDir(nodeDir)).digest("hex").slice(0, 16)}.json`;
}

/** Stable spelling of a node directory, for keying and for self-exclusion.
 *  `realpathSync` when it resolves (symlinked workspaces are common), plain
 *  `resolve` otherwise — a path that does not exist yet still needs a key. */
function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** Length of the stored fingerprint. Collisions at 8 hex are ~1 in 4 billion;
 *  a false "these two share a login" warning costs a second look, while the
 *  value staying short keeps it obviously non-reversible in logs. */
export const FINGERPRINT_LENGTH = 8;

/** Access tokens measured on the reference fleet: `exp - iat` was exactly this,
 *  on 29 of 29 samples, with no jitter. Used only to phrase "how long until the
 *  shared copy dies" when we have an `exp` but no `iat`. */
export const ACCESS_TOKEN_LIFETIME_SECONDS = 864_000;

/** Past this, a published record's age is shown beside the alias. It does not
 *  suppress the warning: a node that has not started in a week still holds the
 *  shared credential. See the liveness note on `checkCodexCredentialSharing`. */
export const STALE_RECORD_NOTICE_MS = 7 * 86_400_000;

/** Same computation as `shortHash` in codex-lifecycle-account.ts. Inlined so
 *  this module stays copyable byte-for-byte into agent-node; the equivalence is
 *  pinned by a test rather than by an import. */
function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface CodexAuthFingerprintRecord {
  readonly schema_version: 1 | 2 | 3;
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
  /** v3: the node directory this record describes, canonical. Three jobs: it is
   *  the identity used to de-duplicate the index against the sibling scan and to
   *  exclude self; and it is the liveness test — if this directory is gone, the
   *  node is gone and the record must not accuse anyone. */
  readonly node_dir?: string;
  /** v3: recorded for humans reading the index by hand. Never the key: it can be
   *  absent, and a key that is sometimes absent produces two records per node. */
  readonly node_id?: string | null;
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

/**
 * Parse an instant we wrote ourselves, refusing anything ambiguous.
 *
 * 🔴 Deliberately NOT `new Date(value)`. Hub-style timestamps
 *    (`2026-09-28 12:32:25`, UTC but unmarked) are parsed by `new Date` as
 *    LOCAL time, silently, and the error is exactly the host's UTC offset —
 *    `check-hub-timestamp-ratchet.py` exists because that class of bug is
 *    structurally invisible to tests (bun pins the test process to UTC, where
 *    "parse as UTC" and "parse as local" agree). Our own records are written
 *    with `toISOString()` and always carry `Z`, so requiring an explicit
 *    timezone costs nothing here and makes a foreign, unmarked value fail
 *    loudly as null instead of becoming a wrong instant.
 */
function parseIsoInstant(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
  /** Canonical node directory — identity for de-duplication and self-exclusion. */
  readonly nodeDir?: string | null;
}

/**
 * Other nodes holding the same credential chain as `self`.
 *
 * Records with no fingerprint are skipped rather than grouped: "unknown" is
 * not a match.
 *
 * 🔴 Self is excluded by node DIRECTORY when both sides carry one, and only
 *    falls back to alias for pre-v3 records. Once the read side is host-wide,
 *    alias stops being an identity: two workspaces may each hold a node called
 *    the same thing, and excluding by name would hide a genuine collision
 *    between them — the exact failure this index was added to fix.
 */
export function collidingNodes(
  records: readonly NodeFingerprint[],
  self: NodeFingerprint,
): NodeFingerprint[] {
  if (!self.fingerprint) return [];
  return records.filter((r) => {
    if (!r.fingerprint || r.fingerprint !== self.fingerprint) return false;
    if (r.nodeDir && self.nodeDir) return r.nodeDir !== self.nodeDir;
    return r.alias !== self.alias;
  });
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
  // Age annotates, it never filters — see checkCodexCredentialSharing. A node
  // idle for a week still holds the shared copy, so the collision is real; the
  // operator just deserves to know how old the claim is before acting on it.
  const list = colliding
    .map((c) => {
      const written = parseIsoInstant(c.writtenAt);
      const age = written ? now.getTime() - written.getTime() : 0;
      return age > STALE_RECORD_NOTICE_MS
        ? `${c.alias} (record ${humanDuration(age)} old)`
        : c.alias;
    })
    .sort()
    .join(", ");
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
  /** Recorded for humans reading the index; never used as a key. Optional
   *  because agent-node's can be empty on older configs. */
  readonly nodeId?: string | null;
  /** Where the warning goes. Defaults to stderr. */
  readonly say?: (message: string) => void;
  /** Injected for tests; production passes nothing. */
  readonly now?: Date;
  /** Injected for tests; production uses the real host index under `~/.anet`. */
  readonly indexDir?: string;
}

/** Read one published record into the shape the comparison works on. Returns
 *  null when the file is absent, unparsable, or carries no fingerprint — all of
 *  which mean "not a match", never "no collision". */
function readRecord(path: string): NodeFingerprint | null {
  let parsed: Partial<CodexAuthFingerprintRecord>;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<CodexAuthFingerprintRecord>;
  } catch {
    return null;
  }
  if (typeof parsed?.fingerprint !== "string" || !parsed.fingerprint) return null;
  return {
    alias: typeof parsed.alias === "string" && parsed.alias ? parsed.alias : basename(dirname(path)),
    fingerprint: parsed.fingerprint,
    writtenAt: typeof parsed.written_at === "string" ? parsed.written_at : null,
    // v1 records carry none of these; absent stays absent rather than becoming
    // a wrong value.
    accessExpiresAt: parseIsoInstant(parsed.access_expires_at),
    codexHome: typeof parsed.codex_home === "string" ? parsed.codex_home : null,
    nodeDir: typeof parsed.node_dir === "string" ? parsed.node_dir : null,
  };
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
 * 🔴 Liveness is EXISTENCE, not age. An index record outlives the node that
 *    wrote it, and a stale one accusing a node that no longer exists is worse
 *    than silence — it teaches operators to ignore the warning. So a record
 *    whose `node_dir` is gone is dropped and its index entry deleted.
 *    Age deliberately does NOT filter: on the reference fleet two of the three
 *    nodes in the worst-affected group were not running at all, and six of 29
 *    credential files had not been touched in days, while still holding the
 *    shared copy. An age cutoff would have hidden precisely the collisions
 *    worth reporting. Age is surfaced in the warning instead, so the operator
 *    can judge how old the claim is.
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

  const selfDir = canonicalDir(opts.nodeDir);
  const self: NodeFingerprint = {
    alias: opts.alias,
    fingerprint: fingerprintRefreshToken(authText),
    accessExpiresAt: accessTokenExpiry(authText),
    codexHome: opts.codexHome,
    nodeDir: selfDir,
  };
  if (!self.fingerprint) return [];

  const indexDir = opts.indexDir ?? codexFingerprintIndexDir();
  const record: CodexAuthFingerprintRecord = {
    schema_version: 3,
    alias: opts.alias,
    fingerprint: self.fingerprint,
    written_at: now.toISOString(),
    access_expires_at: self.accessExpiresAt ? self.accessExpiresAt.toISOString() : null,
    codex_home: opts.codexHome,
    node_dir: selfDir,
    node_id: opts.nodeId ?? null,
  };

  // Publish ours first, so a node that starts second can see this one. The
  // per-node copy stays: it is the node describing itself, readable where the
  // node lives, and it is the fallback when the index write fails.
  try {
    writeRecord(join(opts.nodeDir, CODEX_AUTH_FINGERPRINT_FILE), record);
  } catch (e) {
    say(`[anet] ⚠ could not record the codex credential fingerprint: ${(e as Error).message}`);
  }
  try {
    mkdirSync(indexDir, { recursive: true, mode: 0o700 });
    writeRecord(join(indexDir, codexFingerprintIndexFile(opts.nodeDir)), record);
  } catch (e) {
    say(`[anet] ⚠ could not publish to the host codex fingerprint index: ${(e as Error).message}`);
  }

  // Host-wide first — this is the set that spans workspaces — then the sibling
  // scan, which still catches a neighbour whose index write failed. Keyed by
  // canonical node dir so one node read twice stays one node.
  const byDir = new Map<string, NodeFingerprint>();
  const consider = (found: NodeFingerprint | null, fallbackDir: string): void => {
    if (!found) return;
    const dir = found.nodeDir ? resolve(found.nodeDir) : fallbackDir;
    if (dir === selfDir) return;
    if (!byDir.has(dir)) byDir.set(dir, { ...found, nodeDir: dir });
  };

  let indexEntries: string[] = [];
  try { indexEntries = readdirSync(indexDir); } catch { /* no index yet */ }
  for (const entry of indexEntries) {
    if (!entry.endsWith(".json")) continue;
    const path = join(indexDir, entry);
    const found = readRecord(path);
    if (!found) continue;
    // 🔴 Identity in THIS loop has to be a node directory. The sibling loop
    //    derives one from the path it walked; here the only thing at hand is
    //    the index file's own path, which is not a node dir — so a record
    //    without `node_dir` would take `<index>/<hash>.json` as its identity
    //    and could neither be de-duplicated against that node's own sibling
    //    copy nor be recognised as self: a phantom extra node, i.e. a
    //    collision we invented. It would also skip the liveness test below,
    //    which needs a directory to stat.
    //    Unreachable today (v3 always writes `node_dir`, and this index is new
    //    in v3, so nothing older can be sitting in it) — hardening, not a fix.
    //    Skipping costs nothing: such a node is still visible through the
    //    sibling scan, which derives a real directory. The file is left alone
    //    rather than deleted — a record we cannot interpret is not a record we
    //    have shown to be dead.
    if (!found.nodeDir) continue;
    // Existence is the liveness test. A record pointing at a directory that is
    // gone describes a node that is gone: drop it, and clean it up now that we
    // have noticed, so the index does not grow a tail of ghosts.
    try {
      statSync(found.nodeDir);
    } catch {
      try { unlinkSync(path); } catch { /* best effort; a read-only index is still usable */ }
      continue;
    }
    consider(found, resolve(found.nodeDir));
  }

  const selfDirName = basename(opts.nodeDir);
  const root = dirname(opts.nodeDir);
  let entries: string[] = [];
  try { entries = readdirSync(root); } catch { /* node dir has no parent we can read */ }
  for (const entry of entries) {
    if (entry === selfDirName) continue;
    consider(
      readRecord(join(root, entry, CODEX_AUTH_FINGERPRINT_FILE)),
      canonicalDir(join(root, entry)),
    );
  }

  const colliding = collidingNodes([...byDir.values()], self);
  for (const line of sharedCredentialWarningLines(self, colliding, now)) say(line);
  return colliding;
}
