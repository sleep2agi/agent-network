/**
 * #529 — "why does every codex node need its own CODEX_HOME, and is mine logged in?"
 *
 * Every codex node logs in on its own, in its own CODEX_HOME:
 *   1. ChatGPT refresh tokens are single-use and rotate on refresh, so one
 *      login copied into two homes logs the other one out (#1918, #514);
 *   2. codex keeps its sessions (rollouts) per home — a shared home mixes the
 *      history of two nodes;
 *   3. `anet node stop` / `delete` find a node's processes by its CODEX_HOME,
 *      so two nodes on one home cannot be told apart.
 *
 * The cost of that rule is one `codex login` per node. This module makes the
 * cost visible instead of surprising:
 *   - `codexLoginNextStepLines`: the exact command that logs THIS node in,
 *     printed at the end of create/clone when the node will not have a login;
 *   - `codexNodeLoginStatus`: one row per codex node in a workspace for
 *     `anet node codex login-status`.
 *
 * 🔴 Never prints a token. auth.json is read, reduced to: login kind, the #1918
 *    8-hex refresh fingerprint, the #1856 16-hex account fingerprint and the
 *    e-mail claim of the id_token (no network: the JWT payload is decoded
 *    locally, the signature is not checked — this is display, not auth).
 * 🔴 Never copies anything. It only reads the auth.json of nodes in the
 *    workspace it is asked about (plus the host index of PUBLISHED fingerprints,
 *    never another workspace's auth.json).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fingerprintRefreshToken } from "./codex-auth-fingerprint";
import { resolveNodeCodexHome, looksLikeAnetNodeCodexHome } from "./codex-home-enforce";
import { accountFingerprint } from "./codex-lifecycle-account";
import { findCodexLoginHolders } from "./codex-login-share-guard";

export type CodexLoginKind = "chatgpt" | "api-key" | "none" | "unreadable";

export interface CodexLoginFacts {
  readonly loggedIn: boolean;
  readonly kind: CodexLoginKind;
  /** #1918 refresh-chain fingerprint (8 hex) — what actually collides. */
  readonly loginFingerprint: string | null;
  /** #1856 account fingerprint (sha256(account_id), 16 hex). */
  readonly accountFingerprint: string | null;
  /** `email` claim of the id_token, when present. Not a credential. */
  readonly email: string | null;
}

const NONE: CodexLoginFacts = { loggedIn: false, kind: "none", loginFingerprint: null, accountFingerprint: null, email: null };

function nonEmpty(v: unknown): v is string { return typeof v === "string" && v.trim().length > 0; }

function emailFromIdToken(idToken: unknown): string | null {
  if (!nonEmpty(idToken)) return null;
  const parts = idToken.split(".");
  if (parts.length < 2) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
    const direct = claims?.email;
    const nested = claims?.["https://api.openai.com/profile"]?.email;
    const e = nonEmpty(direct) ? direct : nonEmpty(nested) ? nested : null;
    // Only something that looks like an address; never echo an arbitrary claim.
    return e && /^[^\s@]{1,64}@[^\s@]{1,253}$/.test(e) ? e : null;
  } catch { return null; }
}

/** What an auth.json says about a login — without ever returning a token. */
export function codexLoginFactsFromText(text: string | null): CodexLoginFacts {
  if (text === null) return NONE;
  let auth: any;
  try { auth = JSON.parse(text); } catch { return { ...NONE, kind: "unreadable" }; }
  if (!auth || typeof auth !== "object") return { ...NONE, kind: "unreadable" };
  const tokens = auth.tokens && typeof auth.tokens === "object" ? auth.tokens : null;
  if (tokens && (nonEmpty(tokens.refresh_token) || nonEmpty(tokens.access_token))) {
    let acct: string | null = null;
    try { acct = accountFingerprint(auth); } catch { acct = null; }
    return {
      loggedIn: true,
      kind: "chatgpt",
      loginFingerprint: fingerprintRefreshToken(text),
      accountFingerprint: acct,
      email: emailFromIdToken(tokens.id_token),
    };
  }
  if (nonEmpty(auth.OPENAI_API_KEY)) return { ...NONE, loggedIn: true, kind: "api-key" };
  return NONE;
}

export function codexLoginFactsOfHome(codexHome: string): CodexLoginFacts {
  let text: string | null = null;
  try { text = readFileSync(join(codexHome, "auth.json"), "utf-8"); } catch { text = null; }
  return codexLoginFactsFromText(text);
}

export interface NodeConfigLike {
  runtime?: unknown;
  codexCopresence?: unknown;
  codexHome?: unknown;
  env?: unknown;
  alias?: unknown;
  node_name?: unknown;
  name?: unknown;
}

/** A node whose runtime runs codex. */
export function isCodexNodeConfig(cfg: NodeConfigLike | null | undefined): boolean {
  if (!cfg) return false;
  const rt = String(cfg.runtime ?? "");
  return rt === "codex-sdk" || rt === "codex-app-server" || rt === "codex-tui" || cfg.codexCopresence === true;
}

export type EffectiveCodexHomeSource = "config.codexHome" | "node-codex-home" | "config.env" | "environment" | "default";

/**
 * The CODEX_HOME this node's codex process will get — the same decision
 * `applyNodeCodexHome` makes on start: the node's own value; otherwise an
 * inherited CODEX_HOME unless it is another node's codex-home; otherwise
 * codex's default `~/.codex`.
 */
export function effectiveCodexHome(nodeDir: string, cfg: NodeConfigLike | null, env: Record<string, string | undefined>, home: string): { codexHome: string; source: EffectiveCodexHomeSource } {
  const r = resolveNodeCodexHome({ nodeDir, config: cfg as Record<string, unknown> | null });
  if (r.codexHome && r.source !== "none") return { codexHome: r.codexHome, source: r.source };
  const inherited = env.CODEX_HOME;
  if (nonEmpty(inherited) && !looksLikeAnetNodeCodexHome(inherited)) return { codexHome: resolve(inherited), source: "environment" };
  return { codexHome: join(home, ".codex"), source: "default" };
}

function shq(s: string): string { return /^[A-Za-z0-9_./:@%+=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`; }

export interface LoginNextStepInput {
  readonly alias: string;
  readonly codexHome: string;
  /** Does the codex-home directory exist yet? codex 0.133 refuses a CODEX_HOME that does not. */
  readonly homeExists: boolean;
  /** e.g. `anet node start <alias>`; printed as what comes after the login. */
  readonly then?: string;
}

/**
 * The one next step for a codex node without a login. Plain text, no token,
 * nothing executed. `--device-auth` is in `codex login --help` of the pinned
 * codex (agent-node depends on @openai/codex ^0.133; checked on 0.133.0).
 */
export function codexLoginNextStepLines(i: LoginNextStepInput): string[] {
  const h = shq(i.codexHome);
  const mk = i.homeExists ? "" : `mkdir -p -m 700 ${h} && `;
  return [
    `[anet] Next step — ${i.alias} has no codex login yet. Each codex node logs in on its own, in its own CODEX_HOME`,
    `[anet]   (nothing is copied from another node: refresh tokens are single-use — #514). Run:`,
    `    ${mk}CODEX_HOME=${h} codex login`,
    `[anet]   On a headless machine / over SSH use device auth instead:`,
    `    ${mk}CODEX_HOME=${h} codex login --device-auth`,
    `[anet]   Check every node: anet node codex login-status`,
    ...(i.then ? [`[anet]   Then: ${i.then}`] : []),
  ];
}

export interface CreateLoginGapInput {
  readonly nodeDir: string;
  readonly config: NodeConfigLike | null;
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  /**
   * For a co-presence node whose own codex-home has no login: would its first
   * start be allowed to stage the host login (#514 gate says "ok")? Injected so
   * this stays a pure decision; the CLI passes evaluateCodexLoginStaging.
   */
  readonly hostLoginWouldBeStaged: (hostAuthPath: string) => boolean;
}

/** null = the node will have a usable login; otherwise the CODEX_HOME to log in. */
export function codexCreateLoginGap(i: CreateLoginGapInput): { codexHome: string; homeExists: boolean } | null {
  if (!isCodexNodeConfig(i.config)) return null;
  const eff = effectiveCodexHome(i.nodeDir, i.config, i.env, i.home);
  if (codexLoginFactsOfHome(eff.codexHome).loggedIn) return null;
  if (eff.source === "node-codex-home" && i.config?.codexCopresence === true) {
    const hostAuth = join(i.home, ".codex", "auth.json");
    if (codexLoginFactsOfHome(join(i.home, ".codex")).loggedIn && i.hostLoginWouldBeStaged(hostAuth)) return null;
  }
  let homeExists = false;
  try { homeExists = statSync(eff.codexHome).isDirectory(); } catch { homeExists = false; }
  return { codexHome: eff.codexHome, homeExists };
}

export interface CodexLoginStatusRow {
  alias: string;
  node_id: string | null;
  runtime: string;
  copresence: boolean;
  codex_home: string;
  codex_home_source: EffectiveCodexHomeSource;
  logged_in: boolean;
  login_kind: CodexLoginKind;
  /** #1918 refresh-chain fingerprint (8 hex). */
  login_fingerprint: string | null;
  /** #1856 account fingerprint (16 hex). */
  account_fingerprint: string | null;
  email: string | null;
  /** Other nodes holding the SAME refresh chain — they log each other out. */
  shared_with: string[];
  /** Other nodes logged in to the same account with their OWN login — fine. */
  same_account_as: string[];
}

export interface LoginStatusOptions {
  /** `<workspace>/.anet/nodes` */
  readonly nodesRoot: string;
  readonly env: Record<string, string | undefined>;
  readonly home: string;
  /** Host index of published fingerprints (#1918); default under `home`. */
  readonly indexDir?: string;
}

function readConfig(dir: string): NodeConfigLike | null {
  try {
    const v = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** One row per codex node under `nodesRoot`. Read-only. */
export function codexNodeLoginStatus(o: LoginStatusOptions): CodexLoginStatusRow[] {
  let names: string[] = [];
  try { names = readdirSync(o.nodesRoot); } catch { return []; }
  const rows: Array<CodexLoginStatusRow & { _dir: string }> = [];
  for (const id of names.sort()) {
    const dir = join(o.nodesRoot, id);
    if (!existsSync(join(dir, "config.json"))) continue;
    const cfg = readConfig(dir);
    if (!isCodexNodeConfig(cfg)) continue;
    const eff = effectiveCodexHome(dir, cfg, o.env, o.home);
    const f = codexLoginFactsOfHome(eff.codexHome);
    const alias = [cfg?.alias, cfg?.node_name, cfg?.name].find(nonEmpty) ?? id;
    rows.push({
      _dir: dir,
      alias,
      node_id: nonEmpty((cfg as any)?.node_id) ? (cfg as any).node_id : null,
      runtime: String(cfg?.runtime ?? ""),
      copresence: cfg?.codexCopresence === true,
      codex_home: eff.codexHome,
      codex_home_source: eff.source,
      logged_in: f.loggedIn,
      login_kind: f.kind,
      login_fingerprint: f.loginFingerprint,
      account_fingerprint: f.accountFingerprint,
      email: f.email,
      shared_with: [],
      same_account_as: [],
    });
  }
  for (const r of rows) {
    const shared = new Set<string>();
    const sameAcct = new Set<string>();
    for (const other of rows) {
      if (other === r) continue;
      if (r.login_fingerprint && other.login_fingerprint === r.login_fingerprint) shared.add(other.alias);
      else if (r.account_fingerprint && other.account_fingerprint === r.account_fingerprint) sameAcct.add(other.alias);
    }
    // Nodes in OTHER workspaces on this host: only their published fingerprints (never their auth.json).
    if (r.login_fingerprint) {
      for (const h of findCodexLoginHolders({ fingerprint: r.login_fingerprint, selfNodeDir: r._dir, indexDir: o.indexDir ?? join(o.home, ".anet", "codex-auth-fingerprints"), siblingRoots: [o.nodesRoot] })) {
        if (!rows.some((x) => x !== r && resolve(x._dir) === resolve(h.nodeDir))) shared.add(`${h.alias} (${h.nodeDir})`);
      }
    }
    r.shared_with = [...shared].sort();
    r.same_account_as = [...sameAcct].sort();
  }
  return rows.map(({ _dir, ...rest }) => rest);
}

/** Human table. Never contains a token: rows carry none. */
export function formatCodexLoginStatus(rows: readonly CodexLoginStatusRow[], workspace: string): string[] {
  if (rows.length === 0) return [`[anet] no codex nodes in ${workspace}`];
  const head = ["ALIAS", "RUNTIME", "LOGGED IN", "ACCOUNT", "SHARED WITH", "CODEX_HOME"];
  const body = rows.map((r) => [
    r.alias,
    r.runtime + (r.copresence ? " (co-presence)" : ""),
    r.logged_in ? (r.login_kind === "api-key" ? "yes (api key)" : "yes") : r.login_kind === "unreadable" ? "no (auth.json unreadable)" : "no",
    r.email ?? (r.account_fingerprint ? `acct:${r.account_fingerprint}` : r.login_fingerprint ? `login:${r.login_fingerprint}` : "-"),
    r.shared_with.length ? `⚠ ${r.shared_with.join(", ")}` : "-",
    r.codex_home + (r.codex_home_source === "default" || r.codex_home_source === "environment" ? ` [${r.codex_home_source}]` : ""),
  ]);
  const w = head.map((h, c) => Math.max(h.length, ...body.map((b) => b[c].length)));
  const line = (cells: string[]) => cells.map((x, c) => (c === cells.length - 1 ? x : x.padEnd(w[c]))).join("  ");
  const out = [line(head), ...body.map(line)];
  const notLoggedIn = rows.filter((r) => !r.logged_in);
  const shared = rows.filter((r) => r.shared_with.length);
  if (shared.length) {
    out.push("");
    out.push(`[anet] ⚠ ${shared.length} node(s) share a codex login with another node — refresh tokens are single-use, so they log each other out (#1918).`);
    out.push(`[anet]   Fix: log each of them in on its own: CODEX_HOME=<that node's codex-home> codex login --device-auth`);
  }
  if (notLoggedIn.length) {
    out.push("");
    for (const r of notLoggedIn) out.push(`[anet] ${r.alias}: CODEX_HOME=${shq(r.codex_home)} codex login   (headless: add --device-auth)`);
  }
  const sameAcct = rows.filter((r) => r.same_account_as.length && !r.shared_with.length);
  if (sameAcct.length) {
    out.push("");
    out.push(`[anet] note: ${sameAcct.map((r) => r.alias).join(", ")} use the same account with separate logins — that is fine.`);
  }
  return out;
}
