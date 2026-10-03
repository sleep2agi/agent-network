/**
 * #514 (child of #502) — refuse to give a codex node a ChatGPT login that
 * another node on this host is already using.
 *
 * #1918 made the problem visible: ChatGPT refresh tokens are single-use and
 * rotate on refresh, so when one auth.json is staged into more than one
 * CODEX_HOME, whichever node refreshes first invalidates every other copy
 * ("Your access token could not be refreshed because you have since logged out
 * or signed in to another account", 401 token_revoked). But #1918 only WARNS,
 * on start, after the copy already happened. This module is the gate in front
 * of the copy, used by every path that hands a node a credential:
 *
 *   - `anet node start --copresence` staging the host ~/.codex/auth.json into a
 *     node codex-home that has none yet (a new node, a clone's first start);
 *   - `anet node codex fork` copying the SOURCE node's auth.json;
 *   - `anet node codex account install` copying a registered profile.
 *
 * 🔴 Only NEW sharing is refused. A node whose codex-home already has an
 *    auth.json is an existing node: if it shares, the #1918 warning on start
 *    says so, and `anet doctor` lists the groups — but it still starts.
 *    Refusing there would take a whole host down at once over a condition
 *    that is survivable until the next refresh.
 *
 * 🔴 Identity is the #1918 refresh-token fingerprint (8 hex of sha256), not the
 *    account id: two separate logins on one account hold different refresh
 *    chains and do not invalidate each other (measured in #1918: 19 nodes on
 *    one account held 16 distinct chains). We only ever read OTHER nodes'
 *    published fingerprint files — never their credentials.
 *
 * 🔴 Why there is also an "origin" record. A node's published fingerprint is
 *    the chain it held at its last start; after it refreshes, its copy moves on
 *    (RT0 → RT1) while the host's ~/.codex still says RT0 — a token that is
 *    already spent. Comparing the host's RT0 against "current" fingerprints
 *    alone would then let a second node take that dead copy. So whenever a
 *    credential is handed to a node we also record where it came from
 *    (`origin_fingerprint`), and holders are matched on either value.
 *    The origin record has no `fingerprint` field on purpose: #1918's index
 *    reader skips files without one, so the two record kinds can share the
 *    host index directory without being mistaken for each other.
 *
 * 🔴 The host login. Staging ~/.codex/auth.json into the FIRST node is allowed
 *    (that is how a fresh host gets a working node with zero manual steps), with
 *    a note that the host's own `codex` CLI must not use that login at the same
 *    time. The second node that would borrow it is refused. We cannot observe
 *    whether a human runs `codex` on the host, so the host is not counted as a
 *    holder by itself — the note is the documentation of that limit.
 */
import { mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  CODEX_AUTH_FINGERPRINT_FILE,
  codexFingerprintIndexDir,
  codexFingerprintIndexFile,
  fingerprintRefreshToken,
} from "./codex-auth-fingerprint";

/** The explicit, documented-as-unsafe override. Spelled once so help, messages and tests agree. */
export const ALLOW_SHARED_CODEX_LOGIN_FLAG = "--allow-shared-codex-login";

/** Per-node record of where the node's codex credential came from. */
export const CODEX_AUTH_ORIGIN_FILE = ".codex-auth-origin.json";

/** Host-index filename for a node's origin record: same directory-derived key as
 *  #1918's record, different suffix, so neither overwrites the other. */
export function codexOriginIndexFile(nodeDir: string): string {
  return codexFingerprintIndexFile(nodeDir).replace(/\.json$/, ".origin.json");
}

export type CodexLoginSource =
  | { kind: "host"; path: string }
  | { kind: "fork"; sourceAlias: string }
  | { kind: "account"; profileId: string };

export interface CodexLoginHolder {
  readonly alias: string;
  /** Canonical node directory — the identity. */
  readonly nodeDir: string;
  /** "current": its last published fingerprint; "origin": the credential it was given. */
  readonly via: "current" | "origin";
}

function canonicalDir(dir: string): string {
  try { return realpathSync(dir); } catch { return resolve(dir); }
}

/**
 * Fingerprint of an auth.json on disk, or null when there is none or it carries
 * no refresh token (an API-key login does not rotate, so sharing it is not this
 * failure). The text is hashed and dropped; nothing here returns or logs it.
 */
export function codexLoginFingerprintOfFile(authJsonPath: string): string | null {
  let text: string;
  try { text = readFileSync(authJsonPath, "utf-8"); } catch { return null; }
  return fingerprintRefreshToken(text);
}

interface RawRecord { alias?: unknown; fingerprint?: unknown; origin_fingerprint?: unknown; node_dir?: unknown }

function readJson(path: string): RawRecord | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v as RawRecord : null;
  } catch { return null; }
}

function dirExists(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export interface FindHoldersOptions {
  readonly fingerprint: string;
  /** The node being given the credential — excluded from the result. */
  readonly selfNodeDir: string;
  /** Injected for tests; production uses the host index under ~/.anet. */
  readonly indexDir?: string;
  /** `.anet/nodes` roots to scan besides the host index. Default: the parent of selfNodeDir. */
  readonly siblingRoots?: readonly string[];
}

/**
 * Every OTHER node on this host whose published fingerprint, or recorded
 * credential origin, equals `fingerprint`. Read-only: it never deletes, never
 * writes, and never opens another node's auth.json.
 *
 * A record whose node directory no longer exists describes a node that is
 * gone and is ignored (#1918's liveness rule: existence, not age).
 */
export function findCodexLoginHolders(opts: FindHoldersOptions): CodexLoginHolder[] {
  const self = canonicalDir(opts.selfNodeDir);
  const byDir = new Map<string, CodexLoginHolder>();
  const consider = (rec: RawRecord | null, fallbackDir: string | null) => {
    if (!rec) return;
    const dirRaw = typeof rec.node_dir === "string" && rec.node_dir ? rec.node_dir : fallbackDir;
    if (!dirRaw) return;
    if (!dirExists(dirRaw)) return;
    const dir = canonicalDir(dirRaw);
    if (dir === self) return;
    let via: CodexLoginHolder["via"] | null = null;
    if (rec.fingerprint === opts.fingerprint) via = "current";
    else if (rec.origin_fingerprint === opts.fingerprint) via = "origin";
    if (!via) return;
    if (byDir.has(dir)) return;
    const alias = typeof rec.alias === "string" && rec.alias ? rec.alias : basename(dir);
    byDir.set(dir, { alias, nodeDir: dir, via });
  };

  const indexDir = opts.indexDir ?? codexFingerprintIndexDir();
  let entries: string[] = [];
  try { entries = readdirSync(indexDir); } catch { /* no index yet */ }
  for (const e of entries.sort()) {
    if (!e.endsWith(".json")) continue;
    // Index records must carry their own node_dir; without one there is no
    // directory to test for liveness or to compare with self (see #1918).
    consider(readJson(join(indexDir, e)), null);
  }

  const roots = opts.siblingRoots ?? [dirname(opts.selfNodeDir)];
  for (const root of roots) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const n of names.sort()) {
      const dir = join(root, n);
      consider(readJson(join(dir, CODEX_AUTH_FINGERPRINT_FILE)), dir);
      consider(readJson(join(dir, CODEX_AUTH_ORIGIN_FILE)), dir);
    }
  }
  return [...byDir.values()].sort((a, b) => a.alias.localeCompare(b.alias) || a.nodeDir.localeCompare(b.nodeDir));
}

function describeSource(src: CodexLoginSource): string {
  if (src.kind === "host") return `the host login (${src.path})`;
  if (src.kind === "fork") return `fork source ${src.sourceAlias}'s auth.json`;
  return `registered profile codex-login:${src.profileId}`;
}

export interface StagingDecisionInput {
  /** The node that would receive the credential. */
  readonly alias: string;
  /** Its codex-home — named in the fix instruction. */
  readonly targetCodexHome: string;
  /** Fingerprint of the credential about to be handed over; null = not a rotating login. */
  readonly fingerprint: string | null;
  readonly holders: readonly CodexLoginHolder[];
  readonly source: CodexLoginSource;
  readonly allowShared: boolean;
  /** Extra "how to fix" line for this command (e.g. fork's --no-codex-login). */
  readonly extraFix?: readonly string[];
}

export type StagingDecision =
  | { readonly kind: "ok"; readonly lines: string[] }
  | { readonly kind: "refuse"; readonly lines: string[] }
  | { readonly kind: "override"; readonly lines: string[] };

/**
 * Decide whether handing this credential to this node is allowed, and the exact
 * text to print. Pure — the callers own the I/O and the exit code (1, per #2321).
 */
export function decideCodexLoginStaging(i: StagingDecisionInput): StagingDecision {
  if (!i.fingerprint) return { kind: "ok", lines: [] };
  if (i.holders.length === 0) {
    const lines = i.source.kind === "host"
      ? [
        `[anet] ${i.alias} now uses the host codex login (${i.source.path}, refresh fingerprint ${i.fingerprint}).`,
        `[anet]   One login per node: do not use this login from another node, or from \`codex\` on this host`,
        `[anet]   at the same time — refresh tokens are single-use (#514). A second node is refused.`,
      ]
      : [];
    return { kind: "ok", lines };
  }
  const who = i.holders.map((h) => h.alias).join(", ");
  const why = [
    `[anet]   ChatGPT refresh tokens are single-use and rotate on refresh: whichever node refreshes`,
    `[anet]   first invalidates every other copy ("Your access token could not be refreshed because`,
    `[anet]   you have since logged out or signed in to another account", 401 token_revoked).`,
  ];
  if (i.allowShared) {
    return {
      kind: "override",
      lines: [
        `[anet] ⚠ ${ALLOW_SHARED_CODEX_LOGIN_FLAG}: giving ${i.alias} ${describeSource(i.source)}, which is already used by: ${who} (refresh fingerprint ${i.fingerprint})`,
        ...why,
        `[anet]   You asked for this explicitly; expect these nodes to log each other out. See #514 / #1918.`,
      ],
    };
  }
  return {
    kind: "refuse",
    lines: [
      `[anet] ❌ refusing to give ${i.alias} ${describeSource(i.source)}: that login is already used by: ${who} (refresh fingerprint ${i.fingerprint})`,
      ...why,
      `[anet]   Fix — one login per node. Log this node in on its own (device auth works over SSH):`,
      `[anet]     CODEX_HOME=${i.targetCodexHome} codex login --device-auth`,
      `[anet]   and do the same for any other node that needs its own: CODEX_HOME=<that node's codex-home> codex login --device-auth`,
      ...(i.extraFix ?? []),
      `[anet]   Override (UNSAFE — the nodes will log each other out): ${ALLOW_SHARED_CODEX_LOGIN_FLAG}`,
      `[anet]   See sleep2agi/agent-network#514 and #1918.`,
    ],
  };
}

function writePrivateJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

export interface RecordOriginOptions {
  readonly nodeDir: string;
  readonly alias: string;
  readonly fingerprint: string;
  readonly source: CodexLoginSource;
  readonly indexDir?: string;
  readonly now?: Date;
}

/**
 * Record which credential a node was handed (8-hex fingerprint + where from).
 * Best effort: a failure is returned as a message, never thrown — a node must
 * not fail to start because bookkeeping failed.
 */
export function recordCodexLoginOrigin(o: RecordOriginOptions): string | null {
  const dir = canonicalDir(o.nodeDir);
  const record = {
    schema_version: 1,
    alias: o.alias,
    origin_fingerprint: o.fingerprint,
    origin: o.source.kind === "host" ? "host" : o.source.kind === "fork" ? `fork:${o.source.sourceAlias}` : `account:${o.source.profileId}`,
    node_dir: dir,
    written_at: (o.now ?? new Date()).toISOString(),
  };
  const problems: string[] = [];
  try {
    mkdirSync(o.nodeDir, { recursive: true, mode: 0o700 });
    writePrivateJson(join(o.nodeDir, CODEX_AUTH_ORIGIN_FILE), record);
  } catch (e) { problems.push((e as Error).message); }
  try {
    const idx = o.indexDir ?? codexFingerprintIndexDir();
    mkdirSync(idx, { recursive: true, mode: 0o700 });
    writePrivateJson(join(idx, codexOriginIndexFile(o.nodeDir)), record);
  } catch (e) { problems.push((e as Error).message); }
  return problems.length ? `could not record the codex login origin: ${problems.join("; ")}` : null;
}

export interface SharedLoginGroup {
  /** 8-hex refresh fingerprint — not a credential. */
  readonly fingerprint: string;
  readonly aliases: string[];
}

/**
 * For `anet doctor`: groups of ≥2 live nodes whose CURRENT published
 * fingerprint is the same. Read-only; aliases only.
 */
export function sharedCodexLoginGroups(opts: { indexDir?: string; nodeRoots?: readonly string[] } = {}): SharedLoginGroup[] {
  const byDir = new Map<string, { alias: string; fp: string }>();
  const consider = (rec: RawRecord | null, fallbackDir: string | null) => {
    if (!rec || typeof rec.fingerprint !== "string" || !rec.fingerprint) return;
    const dirRaw = typeof rec.node_dir === "string" && rec.node_dir ? rec.node_dir : fallbackDir;
    if (!dirRaw || !dirExists(dirRaw)) return;
    const dir = canonicalDir(dirRaw);
    if (byDir.has(dir)) return;
    byDir.set(dir, { alias: typeof rec.alias === "string" && rec.alias ? rec.alias : basename(dir), fp: rec.fingerprint });
  };
  const indexDir = opts.indexDir ?? codexFingerprintIndexDir();
  let entries: string[] = [];
  try { entries = readdirSync(indexDir); } catch { /* none */ }
  for (const e of entries.sort()) if (e.endsWith(".json")) consider(readJson(join(indexDir, e)), null);
  for (const root of opts.nodeRoots ?? []) {
    let names: string[] = [];
    try { names = readdirSync(root); } catch { continue; }
    for (const n of names.sort()) consider(readJson(join(root, n, CODEX_AUTH_FINGERPRINT_FILE)), join(root, n));
  }
  const groups = new Map<string, string[]>();
  for (const { alias, fp } of byDir.values()) groups.set(fp, [...(groups.get(fp) ?? []), alias]);
  return [...groups.entries()]
    .filter(([, a]) => a.length > 1)
    .map(([fingerprint, aliases]) => ({ fingerprint, aliases: aliases.sort() }))
    .sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
}

export interface EvaluateStagingOptions {
  /** The node that would receive the credential (may not exist yet, e.g. a fork target). */
  readonly nodeDir: string;
  readonly alias: string;
  readonly targetCodexHome: string;
  /** The auth.json about to be copied. Read only to hash it. */
  readonly sourceAuthPath: string;
  readonly source: CodexLoginSource;
  readonly allowShared: boolean;
  readonly extraFix?: readonly string[];
  /** Holders known without any record — a fork's source node always holds its own login. */
  readonly knownHolders?: readonly CodexLoginHolder[];
  readonly indexDir?: string;
  readonly siblingRoots?: readonly string[];
}

export type EvaluatedStaging = StagingDecision & {
  readonly fingerprint: string | null;
  readonly holders: readonly CodexLoginHolder[];
};

/**
 * Fingerprint → holders → decision, in one call, for every staging path.
 * Writes nothing; the caller records the origin once the credential has
 * actually been handed over (see recordCodexLoginOrigin).
 */
export function evaluateCodexLoginStaging(o: EvaluateStagingOptions): EvaluatedStaging {
  const fingerprint = codexLoginFingerprintOfFile(o.sourceAuthPath);
  const found = fingerprint
    ? findCodexLoginHolders({ fingerprint, selfNodeDir: o.nodeDir, indexDir: o.indexDir, siblingRoots: o.siblingRoots })
    : [];
  const self = canonicalDir(o.nodeDir);
  const byDir = new Map<string, CodexLoginHolder>();
  for (const h of [...(fingerprint ? o.knownHolders ?? [] : []), ...found]) {
    const d = canonicalDir(h.nodeDir);
    if (d === self || byDir.has(d)) continue;
    byDir.set(d, { ...h, nodeDir: d });
  }
  const holders = [...byDir.values()];
  const decision = decideCodexLoginStaging({
    alias: o.alias,
    targetCodexHome: o.targetCodexHome,
    fingerprint,
    holders,
    source: o.source,
    allowShared: o.allowShared,
    extraFix: o.extraFix,
  });
  return { ...decision, fingerprint, holders };
}

/**
 * `anet node codex fork --no-codex-login` deliberately leaves the target without
 * a credential, and home_isolated would fail on exactly that. The caller runs
 * the real check with the credential treated as present (so every OTHER rule —
 * directory mode, CommHub token, env-file token — is still evaluated) and passes
 * the result here: a pass is re-worded to say what is still owed, a failure
 * stays the failure it is.
 */
export function homeCheckPendingOwnLogin<C extends { status: string; detail: string }>(checkAssumingLogin: C, codexHome: string): C {
  if (checkAssumingLogin.status !== "pass") return checkAssumingLogin;
  return {
    ...checkAssumingLogin,
    detail: `CODEX_HOME owner-only, no codex login yet (--no-codex-login, #514) — before first start: CODEX_HOME=${codexHome} codex login --device-auth`,
  };
}

/** The step of a host stage plan that newly hands a node a login: auth.json where the node has none.
 *  A "host-newer" re-stage is an existing node and is not gated (it still gets the #1918 warning). */
export function newLoginStep<T extends { name: string; reason: string }>(plan: readonly T[]): T | undefined {
  return plan.find((s) => s.name === "auth.json" && s.reason === "missing");
}
