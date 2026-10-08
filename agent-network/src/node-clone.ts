/**
 * #509 — `anet node clone <src> <new>` (and `anet node create <new> --from <src>`).
 *
 * Why this exists: the only way to "copy a node" used to be `cp -r` of its
 * directory. That copies `config.json` verbatim — the same `node_id` and the
 * same `ntok_` — so one Hub identity is now held by two processes. Both
 * subscribe, both receive the same task, the task runs twice and two replies
 * race. And `anet node create <new> --from <src>` parsed `--from` and then
 * dropped it on the floor, building a default node instead.
 *
 * A clone copies the node's *settings* and nothing that identifies it:
 *
 *   copied       runtime, model, tools, permission flags, prompts, commhub
 *                channel, non-secret env, rules file / skills / .mcp.json
 *                (only when the clone gets its own --workdir; otherwise the
 *                two nodes share that workdir and nothing needs copying),
 *                and the non-credential parts of a per-node codex-home.
 *   regenerated  node_id, alias, ntok_ (registered with the Hub by the same
 *                POST /api/auth/node-token `anet node create` uses), the
 *                claude-code-cli session id, grok co-presence sockets,
 *                codexProjectDir.
 *   skipped      token, every session/thread id, logs, pidfiles, lifecycle
 *                locks, inbox/goal state, channel bot credentials, codex
 *                auth.json (one login shared by two nodes breaks on the first
 *                refresh — #1918), copresence identity files, and the values
 *                of secret env entries (key names are kept, as envRef).
 *
 * Everything in this file is side-effect free except `runNodeClone`, which
 * takes the Hub registration and the profile writer as parameters so tests
 * can run it against a temp directory with a mocked Hub.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { planPlainSecretEnvRewrites } from "./claude-vendor-env";
import { rewriteTrustedProjects } from "./codex-lifecycle-fork";
import { atomicWritePrivateFile } from "./private-state";
import { serializeProfileForConfigJson } from "./profile-serialize";

// ── argv ────────────────────────────────────────────────────────────────

export interface CloneArgs {
  source: string;
  target: string;
  /** Raw --workdir as typed (resolved later against cwd). */
  workdir?: string;
  model?: string;
  start: boolean;
}

export type CloneArgsResult = { ok: true; args: CloneArgs } | { ok: false; error: string } | { ok: false; help: true };

export const NODE_CLONE_USAGE = `anet node clone <source> <new-name> [--workdir <dir>] [--model <id>] [--start]
anet node create <new-name> --from <source> [--workdir <dir>] [--model <id>] [--start]

  Make a new node with the same settings as <source>, under a NEW identity.
  The clone is registered with the Hub as its own node (new node_id + token);
  it never shares the source's identity, session, login or logs.

  Copied:      runtime, model, tools, permission flags, prompts, non-secret env,
               rules file / skills / .mcp.json (with --workdir)
  Regenerated: node_id, token, session id, co-presence sockets
  Not copied:  token, sessions/threads, logs, inbox, channel bot credentials,
               codex auth.json, secret env values (key names are kept)

  --workdir <dir>  Put the clone in another project directory (created if
                   missing; path must be ASCII). Default: the source's project
                   directory (the current one), sharing its rules file/skills.
  --model <id>     Use a different model than the source.
  --start          Start the clone right after creating it.

  Never copy a node directory with cp -r: the copy keeps the same node_id and
  token, so the Hub delivers every task to both processes and it runs twice.`;

/** Flags `anet node create` accepts that make no sense for a clone. */
const CREATE_ONLY_FLAGS: Record<string, string> = {
  "--runtime": "a clone keeps the source's runtime",
  "--resume": "a clone never adopts a session",
  "--resume-latest": "a clone never adopts a session",
  "--session": "a clone never adopts a session",
  "--copresence": "co-presence is copied from the source",
  "--env": "env is copied from the source (edit the clone's config.json afterwards)",
  "--channel": "channels are copied from the source",
  "--tools": "tools are copied from the source",
  "--batch": "--batch is a separate wizard",
};

/**
 * Parse the tokens after the verb.
 *   mode "clone":       [<source>, <new>, ...flags]
 *   mode "create-from": [<new>, ...flags]  with a required --from <source>
 */
export function parseCloneArgs(tokens: readonly string[], mode: "clone" | "create-from"): CloneArgsResult {
  const positional: string[] = [];
  let workdir: string | undefined;
  let model: string | undefined;
  let from: string | undefined;
  let start = false;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "--help" || t === "-h") return { ok: false, help: true };
    if (!t.startsWith("--")) { positional.push(t); continue; }
    const [flag, inline] = t.includes("=") ? [t.slice(0, t.indexOf("=")), t.slice(t.indexOf("=") + 1)] : [t, undefined];
    const takeValue = (): string | null => {
      if (inline !== undefined) return inline;
      const v = tokens[i + 1];
      if (v === undefined || v.startsWith("--")) return null;
      i += 1;
      return v;
    };
    if (flag === "--start") { start = true; continue; }
    if (flag === "--workdir" || flag === "--model" || (flag === "--from" && mode === "create-from")) {
      const v = takeValue();
      if (v === null || !v.trim()) return { ok: false, error: `${flag} needs a value` };
      if (flag === "--workdir") workdir = v;
      else if (flag === "--model") model = v.trim();
      else from = v;
      continue;
    }
    if (CREATE_ONLY_FLAGS[flag]) return { ok: false, error: `${flag} cannot be used when cloning: ${CREATE_ONLY_FLAGS[flag]}` };
    return { ok: false, error: `unknown option ${flag} (allowed: --workdir, --model, --start${mode === "create-from" ? ", --from" : ""})` };
  }
  if (model !== undefined && /\s/.test(model)) return { ok: false, error: `--model must not contain whitespace` };
  if (mode === "clone") {
    if (positional.length !== 2) return { ok: false, error: "expected exactly two names: <source> <new-name>" };
    return { ok: true, args: { source: positional[0]!, target: positional[1]!, workdir, model, start } };
  }
  if (!from) return { ok: false, error: "--from <source> is required" };
  if (positional.length !== 1) return { ok: false, error: "expected exactly one name: <new-name>" };
  return { ok: true, args: { source: from, target: positional[0]!, workdir, model, start } };
}

// ── refusals ────────────────────────────────────────────────────────────

/** Project rule: node working directories are ASCII (aliases may be Chinese, directories not). */
export function isAsciiPath(p: string): boolean {
  return /^[\x20-\x7e]*$/.test(p);
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface RefusalInput {
  sourceId: string;
  sourceProfile: Record<string, any>;
  target: string;
  sourceNodeDir: string;
  targetNodeDir: string;
  /** Present only when --workdir was given; absolute. */
  explicitWorkdir?: string;
}

/** Every reason to stop before touching the Hub or the disk. null = go. */
export function cloneRefusal(i: RefusalInput): string | null {
  const names = [i.sourceId, i.sourceProfile.node_name, i.sourceProfile.alias, i.sourceProfile.name].filter(Boolean);
  if (names.includes(i.target)) return `the new name "${i.target}" is the source node's own name — pick a different one`;
  if (i.explicitWorkdir !== undefined && !isAsciiPath(i.explicitWorkdir)) {
    return `--workdir ${JSON.stringify(i.explicitWorkdir)} contains non-ASCII characters; node working directories must be ASCII (the node name itself may be Chinese). Pick an English path, e.g. --workdir ~/my-agent-2`;
  }
  const src = resolve(i.sourceNodeDir);
  const dst = resolve(i.targetNodeDir);
  if (isInside(dst, src) || (i.explicitWorkdir !== undefined && isInside(resolve(i.explicitWorkdir), src))) {
    return `refusing to clone into the source node's own directory (${src})`;
  }
  if (existsSync(dst)) return `${dst} already exists — refusing to overwrite (pick another name, or anet node delete it first)`;
  const runtime = String(i.sourceProfile.runtime || "");
  if (runtime === "opencode-cli" || runtime === "opencode") {
    return `cloning an opencode-cli node is not supported yet: its runtime binding and vendor login live outside the node config. Create it instead: anet node create ${i.target} --runtime opencode-cli`;
  }
  if (i.sourceProfile.role === "host_supervisor") {
    return `"${i.sourceId}" is a host daemon (role=host_supervisor); one per host — use anet daemon init instead of cloning it`;
  }
  return null;
}

// ── profile plan ────────────────────────────────────────────────────────

export interface LedgerItem { item: string; note?: string }
export interface CloneLedger {
  copied: LedgerItem[];
  regenerated: LedgerItem[];
  skipped: LedgerItem[];
  /** env keys whose value is a secret: the clone references `ref`, which the user must set. */
  secrets: { key: string; ref: string }[];
}

export function emptyLedger(): CloneLedger {
  return { copied: [], regenerated: [], skipped: [], secrets: [] };
}

/** Settings carried over verbatim. Anything not listed here or below is NOT copied. */
const COPY_FIELDS = [
  "anet_version", "runtime", "model", "tools", "hub", "network_id",
  "systemPrompt", "team", "role", "codexBin", "codexVersion", "codexCopresence", "codexCopresenceFullAccess",
  "opencodeMode", "grokCopresence",
] as const;

/** Handled explicitly (regenerated or skipped with a reason). */
const SKIP_FIELDS: Record<string, string> = {
  token: "node token is per node; the clone gets its own from the Hub",
  session: "session belongs to the source",
  sessionId: "session belongs to the source",
  resume: "session belongs to the source",
  resumeAlias: "session belongs to the source",
  grokSession: "grok session belongs to the source",
  grokCliSession: "grok session belongs to the source",
  codexThreadId: "codex thread belongs to the source (to carry history use: anet node codex fork)",
  codexAppServerUrl: "app-server endpoint is per node; assigned at first start",
  codexAppServerPort: "app-server port is per node; assigned at first start",
  codexRecoveryVerification: "recovery record of the source",
  codexRecoveryBackup: "recovery record of the source",
  codexHome: "explicit CODEX_HOME of the source (its login); the clone gets its own codex-home",
};
const IDENTITY_FIELDS = new Set(["node_id", "node_name", "name", "alias", "grokLeaderSocket", "grokAttachSocket", "codexProjectDir"]);

const SECRET_KEY_RX = /(_TOKEN|_KEY|_SECRET|AUTH|PASSWORD)$/i;
const SECRET_VALUE_RX = /^(sk-|utok_|ntok_|atok_|ak-|gsk_|key-|Bearer\s)/i;

export interface PlanInput {
  sourceProfile: Record<string, any>;
  target: string;
  newNodeId: string;
  /** Absolute project directory the clone will live in. */
  targetWorkdir: string;
  modelOverride?: string;
  /** New claude-code-cli session id. */
  newSession: () => string;
  /** grok co-presence socket fields for the new node id (grokBuildCliCreationFields). */
  grokFields?: (nodeId: string) => Record<string, unknown>;
}

/** Build the clone's profile (no token yet) and the ledger of what happened to each field. */
export function planCloneProfile(p: PlanInput, ledger: CloneLedger = emptyLedger()): { profile: Record<string, any>; ledger: CloneLedger } {
  const src = p.sourceProfile;
  const out: Record<string, any> = {};
  for (const f of COPY_FIELDS) {
    if (src[f] === undefined || src[f] === null || src[f] === "") continue;
    out[f] = structuredClone(src[f]);
    ledger.copied.push({ item: f });
  }
  if (p.modelOverride) {
    out.model = p.modelOverride;
    const i = ledger.copied.findIndex((x) => x.item === "model");
    if (i >= 0) ledger.copied.splice(i, 1);
    ledger.regenerated.push({ item: "model", note: `set by --model (source: ${src.model ?? "default"})` });
  }

  out.node_id = p.newNodeId;
  out.node_name = p.target;
  out.alias = p.target;
  ledger.regenerated.push({ item: "node_id", note: p.newNodeId });
  ledger.regenerated.push({ item: "alias", note: p.target });
  ledger.regenerated.push({ item: "token", note: "new ntok_ from the Hub" });

  // flags = permission settings. Copied, minus anything that looks like a credential.
  const flags: Record<string, any> = {};
  for (const [k, v] of Object.entries(src.flags && typeof src.flags === "object" ? src.flags : {})) {
    if (typeof v === "string" && SECRET_VALUE_RX.test(v)) { ledger.skipped.push({ item: `flags.${k}`, note: "looks like a credential" }); continue; }
    flags[k] = structuredClone(v);
  }
  out.flags = flags;
  ledger.copied.push({ item: "flags", note: Object.keys(flags).join(", ") || "(none)" });

  // channels: commhub is the network itself; others carry per-node bot credentials.
  const channels: string[] = [];
  for (const ch of Array.isArray(src.channels) ? src.channels : []) {
    if (typeof ch === "string" && ch.includes("commhub")) channels.push(ch);
    else ledger.skipped.push({ item: `channel ${ch}`, note: "bot credentials are per node — re-add with: anet channel add" });
  }
  out.channels = channels.length ? channels : ["server:commhub"];
  ledger.copied.push({ item: "channels", note: out.channels.join(", ") });

  // env: plain values copied; secrets become an envRef named for the NEW node, value never copied.
  const env: Record<string, any> = {};
  const short = p.newNodeId.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 16);
  for (const [k, v] of Object.entries(src.env && typeof src.env === "object" ? src.env : {})) {
    const isRef = v && typeof v === "object" && typeof (v as any)._envRef === "string";
    const looksSecret = typeof v === "string"
      && planPlainSecretEnvRewrites({ env: { [k]: v }, nodeId: p.newNodeId }).length > 0;
    if (isRef || looksSecret || (typeof v === "string" && SECRET_KEY_RX.test(k))) {
      const ref = `${k}_${short}`.toUpperCase();
      env[k] = { _envRef: ref };
      ledger.secrets.push({ key: k, ref });
      continue;
    }
    if (typeof v === "string") { env[k] = v; continue; }
    ledger.skipped.push({ item: `env.${k}`, note: "unrecognised value shape" });
  }
  out.env = env;
  const plainEnv = Object.keys(env).filter((k) => typeof env[k] === "string");
  if (plainEnv.length) ledger.copied.push({ item: "env", note: plainEnv.join(", ") });
  if (ledger.secrets.length) ledger.skipped.push({ item: "secret env values", note: `${ledger.secrets.map((s) => s.key).join(", ")} — key names kept, values NOT copied` });

  // Regenerated per-runtime identity.
  const runtime = String(src.runtime || "");
  if (runtime === "claude-code-cli") {
    out.session = p.newSession();
    ledger.regenerated.push({ item: "session", note: "fresh Claude Code session" });
  }
  if (src.grokCopresence === true && p.grokFields) {
    Object.assign(out, p.grokFields(p.newNodeId));
    ledger.regenerated.push({ item: "grok co-presence sockets", note: "derived from the new node_id" });
  }
  if (typeof src.codexProjectDir === "string" && src.codexProjectDir) {
    out.codexProjectDir = p.targetWorkdir;
    ledger.regenerated.push({ item: "codexProjectDir", note: p.targetWorkdir });
  }

  for (const [k, v] of Object.entries(src)) {
    if ((COPY_FIELDS as readonly string[]).includes(k) || IDENTITY_FIELDS.has(k)) continue;
    if (k === "flags" || k === "channels" || k === "env" || k === "anet_version") continue;
    if (v === undefined || v === null || v === "") continue;
    if (k === "session" && runtime === "claude-code-cli") { continue; }
    ledger.skipped.push({ item: k, note: SKIP_FIELDS[k] ?? "not a known setting — not copied" });
  }
  return { profile: out, ledger };
}

// ── files ───────────────────────────────────────────────────────────────

/** Files a codex-home may carry to the clone. Never auth.json, never .anet-copresence.env. */
export const CODEX_HOME_COPY = ["config.toml", "AGENTS.md", "version.json"] as const;
export const CODEX_HOME_COPY_DIRS = ["skills"] as const;

/** Workdir-level settings copied only when the clone gets its own --workdir. */
export const WORKDIR_COPY_FILES = ["CLAUDE.md", "AGENTS.md"] as const;
export const WORKDIR_COPY_DIRS = [".claude/skills", ".agents/skills", ".grok/skills", ".opencode/skill", ".opencode/skills"] as const;

const NODE_DIR_SKIP_NOTES: Record<string, string> = {
  ".env": "secret values (see secrets below)",
  logs: "logs belong to the source",
  ".pid": "process state",
  ".lifecycle-owner.json": "process state",
  ".lifecycle-lock": "process state",
  "goals.json": "scheduled goals belong to the source",
  channels: "channel bot credentials are per node",
  "copresence-identity.json": "co-presence identity of the source",
  "opencode-attach.sh": "attach script of the source",
  "codex-bridge.log": "bridge output of the source",
};

const SECRET_FILE_RX = /^(\.env.*|.*\.pem|.*\.key|id_.*|auth\.json|credentials.*|.*\.p12|.*\.pfx|\.npmrc|\.netrc|\.git-credentials)$/i;
const TOML_LITERAL_SECRET_RX = /^\s*[A-Za-z0-9_.-]*(token|api_key|apikey|secret|password|bearer)[A-Za-z0-9_.-]*\s*=\s*["']/im;

/** Recursive copy that never follows symlinks and never copies credential-looking files. Returns files copied. */
export function copyTreeSafe(from: string, to: string, skipped: LedgerItem[], label: string): number {
  let n = 0;
  const walk = (a: string, b: string, rel: string) => {
    mkdirSync(b, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(a)) {
      const sa = join(a, name), sb = join(b, name), r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(sa);
      if (st.isSymbolicLink()) { skipped.push({ item: `${label}/${r}`, note: "symlink — not followed" }); continue; }
      if (st.isDirectory()) { walk(sa, sb, r); continue; }
      if (!st.isFile()) continue;
      if (SECRET_FILE_RX.test(name)) { skipped.push({ item: `${label}/${r}`, note: "credential file" }); continue; }
      copyFileSync(sa, sb);
      chmodSync(sb, st.mode & 0o777 & ~0o022);
      n += 1;
    }
  };
  walk(from, to, "");
  return n;
}

/** Strip values from env/headers of every MCP server; drop the commhub entry (regenerated at start). */
export function sanitizeMcpJson(raw: string): { text: string; blanked: string[] } {
  const cfg = JSON.parse(raw);
  const blanked: string[] = [];
  const servers = cfg && typeof cfg.mcpServers === "object" && cfg.mcpServers ? cfg.mcpServers : {};
  delete servers.commhub;
  for (const [name, s] of Object.entries<any>(servers)) {
    for (const field of ["env", "headers"]) {
      if (s && typeof s[field] === "object" && s[field]) {
        for (const k of Object.keys(s[field])) { s[field][k] = ""; blanked.push(`${name}.${field}.${k}`); }
      }
    }
  }
  return { text: JSON.stringify(cfg, null, 2) + "\n", blanked };
}

export interface CopyFilesInput {
  sourceNodeDir: string;
  targetNodeDir: string;
  sourceWorkdir: string;
  targetWorkdir: string;
}

/** Copy the whitelisted on-disk settings. The target node dir must already exist. */
export function copyCloneFiles(i: CopyFilesInput, ledger: CloneLedger): void {
  const sameWorkdir = resolve(i.sourceWorkdir) === resolve(i.targetWorkdir);

  // 1. Per-node directory: a whitelist (codex-home settings); everything else is listed as skipped.
  if (existsSync(i.sourceNodeDir)) {
    for (const name of readdirSync(i.sourceNodeDir).sort()) {
      if (name === "config.json") continue; // written fresh
      if (name === "codex-home") continue; // below
      if (name.startsWith(".") && name.endsWith(".tmp")) continue;
      const note = NODE_DIR_SKIP_NOTES[name]
        ?? (/\.(sock|socket)$/.test(name) ? "socket of the source" : "runtime state of the source");
      ledger.skipped.push({ item: name, note });
    }
    const srcHome = join(i.sourceNodeDir, "codex-home");
    if (existsSync(srcHome) && lstatSync(srcHome).isDirectory()) {
      const dstHome = join(i.targetNodeDir, "codex-home");
      mkdirSync(dstHome, { recursive: true, mode: 0o700 });
      chmodSync(dstHome, 0o700);
      for (const f of CODEX_HOME_COPY) {
        const from = join(srcHome, f);
        if (!existsSync(from) || !lstatSync(from).isFile()) continue;
        let body = readFileSync(from, "utf-8");
        if (f === "config.toml") {
          if (TOML_LITERAL_SECRET_RX.test(body)) { ledger.skipped.push({ item: "codex-home/config.toml", note: "contains a literal credential — not copied" }); continue; }
          if (!sameWorkdir) body = rewriteTrustedProjects(body, resolve(i.sourceWorkdir), resolve(i.targetWorkdir)).text;
        }
        writeFileSync(join(dstHome, f), body, { mode: 0o600 });
        chmodSync(join(dstHome, f), 0o600);
        ledger.copied.push({ item: `codex-home/${f}` });
      }
      for (const d of CODEX_HOME_COPY_DIRS) {
        const from = join(srcHome, d);
        if (existsSync(from) && lstatSync(from).isDirectory()) {
          const n = copyTreeSafe(from, join(dstHome, d), ledger.skipped, `codex-home/${d}`);
          ledger.copied.push({ item: `codex-home/${d}/`, note: `${n} file(s)` });
        }
      }
      for (const name of readdirSync(srcHome).sort()) {
        if ((CODEX_HOME_COPY as readonly string[]).includes(name) || (CODEX_HOME_COPY_DIRS as readonly string[]).includes(name)) continue;
        const note = name === "auth.json"
          ? "codex login is per node — sharing one breaks on the first token refresh (#1918)"
          : name === ".anet-copresence.env" ? "carries the source's CommHub token" : "codex session/cache state of the source";
        ledger.skipped.push({ item: `codex-home/${name}`, note });
      }
    }
  }

  // 2. Workdir-level settings: shared when the clone stays in the same project, copied otherwise.
  if (sameWorkdir) {
    ledger.copied.push({ item: "rules file / skills / .mcp.json", note: "shared — same workdir as the source" });
    return;
  }
  for (const f of WORKDIR_COPY_FILES) {
    const from = join(i.sourceWorkdir, f), to = join(i.targetWorkdir, f);
    if (!existsSync(from) || !lstatSync(from).isFile()) continue;
    if (existsSync(to)) { ledger.skipped.push({ item: f, note: "already present in the target workdir — left as is" }); continue; }
    copyFileSync(from, to);
    ledger.copied.push({ item: f, note: "rules file" });
  }
  for (const d of WORKDIR_COPY_DIRS) {
    const from = join(i.sourceWorkdir, ...d.split("/")), to = join(i.targetWorkdir, ...d.split("/"));
    if (!existsSync(from) || !lstatSync(from).isDirectory()) continue;
    if (existsSync(to)) { ledger.skipped.push({ item: `${d}/`, note: "already present in the target workdir — left as is" }); continue; }
    const n = copyTreeSafe(from, to, ledger.skipped, d);
    ledger.copied.push({ item: `${d}/`, note: `${n} skill file(s)` });
  }
  const mcpFrom = join(i.sourceWorkdir, ".mcp.json"), mcpTo = join(i.targetWorkdir, ".mcp.json");
  if (existsSync(mcpFrom) && lstatSync(mcpFrom).isFile()) {
    if (existsSync(mcpTo)) ledger.skipped.push({ item: ".mcp.json", note: "already present in the target workdir — left as is" });
    else {
      try {
        const { text, blanked } = sanitizeMcpJson(readFileSync(mcpFrom, "utf-8"));
        writeFileSync(mcpTo, text, { mode: 0o600 });
        ledger.copied.push({ item: ".mcp.json", note: blanked.length ? `env/header values blanked: ${blanked.join(", ")}` : "MCP servers" });
      } catch { ledger.skipped.push({ item: ".mcp.json", note: "not valid JSON — not copied" }); }
    }
  }
}

// ── orchestration ───────────────────────────────────────────────────────

export interface RunCloneInput {
  sourceId: string;
  /** Raw source config.json (as stored, before normalisation). */
  sourceProfile: Record<string, any>;
  target: string;
  sourceNodeDir: string;
  sourceWorkdir: string;
  targetWorkdir: string;
  /** True when the user passed --workdir. */
  explicitWorkdir: boolean;
  modelOverride?: string;
  newNodeId: () => string;
  newSession: () => string;
  grokFields?: (nodeId: string) => Record<string, unknown>;
  /** Hub registration — returns the new node's ntok_. Same endpoint `anet node create` uses. */
  register: (profile: Record<string, any>) => Promise<string>;
  /** Write config.json into targetNodeDir (the CLI passes its create writer). */
  persist: (profile: Record<string, any>, targetNodeDir: string) => void;
}

export type RunCloneResult =
  | { ok: true; profile: Record<string, any>; ledger: CloneLedger; targetNodeDir: string }
  | { ok: false; stage: "refused" | "register" | "write"; error: string };

export async function runNodeClone(i: RunCloneInput): Promise<RunCloneResult> {
  const targetNodeDir = join(i.targetWorkdir, ".anet", "nodes", i.target);
  const refusal = cloneRefusal({
    sourceId: i.sourceId,
    sourceProfile: i.sourceProfile,
    target: i.target,
    sourceNodeDir: i.sourceNodeDir,
    targetNodeDir,
    explicitWorkdir: i.explicitWorkdir ? i.targetWorkdir : undefined,
  });
  if (refusal) return { ok: false, stage: "refused", error: refusal };

  const { profile, ledger } = planCloneProfile({
    sourceProfile: i.sourceProfile,
    target: i.target,
    newNodeId: i.newNodeId(),
    targetWorkdir: i.targetWorkdir,
    modelOverride: i.modelOverride,
    newSession: i.newSession,
    grokFields: i.grokFields,
  });
  if (profile.node_id === i.sourceProfile.node_id) return { ok: false, stage: "refused", error: "generated node_id equals the source's" };

  // Hub first, disk second (same order as `anet node codex fork`): a failed registration leaves nothing behind.
  let token: string;
  try {
    token = await i.register(profile);
  } catch (e: any) {
    return { ok: false, stage: "register", error: e?.message ?? String(e) };
  }
  if (!token || token === i.sourceProfile.token) return { ok: false, stage: "register", error: "Hub returned no new token" };
  profile.token = token;

  try {
    mkdirSync(join(i.targetWorkdir, ".anet", "nodes"), { recursive: true });
    i.persist(profile, targetNodeDir);
    copyCloneFiles({ sourceNodeDir: i.sourceNodeDir, targetNodeDir, sourceWorkdir: i.sourceWorkdir, targetWorkdir: i.targetWorkdir }, ledger);
  } catch (e: any) {
    try { rmSync(targetNodeDir, { recursive: true, force: true }); } catch { /* best effort */ }
    return { ok: false, stage: "write", error: e?.message ?? String(e) };
  }
  return { ok: true, profile, ledger, targetNodeDir };
}

/** Test/default writer: the same config.json whitelist `anet node create` persists, mode 0600. */
export function defaultClonePersist(profile: Record<string, any>, targetNodeDir: string): void {
  atomicWritePrivateFile(join(targetNodeDir, "config.json"), JSON.stringify(serializeProfileForConfigJson(profile, profile), null, 2) + "\n");
}

// ── output ──────────────────────────────────────────────────────────────

/** The summary table printed after a clone. Never prints a token or a secret value. */
export function formatCloneSummary(r: { source: string; target: string; profile: Record<string, any>; ledger: CloneLedger; targetNodeDir: string; sourceNodeId?: string }): string {
  const L: string[] = [];
  L.push(`[anet] Cloned "${r.source}" → "${r.target}"`);
  L.push(`[anet]   node_id: ${r.sourceNodeId ?? "?"} → ${r.profile.node_id}   (distinct Hub identity)`);
  L.push(`[anet]   dir:     ${r.targetNodeDir}`);
  const section = (title: string, items: LedgerItem[]) => {
    L.push("");
    L.push(`  ${title} (${items.length})`);
    for (const it of items) L.push(`    - ${it.item}${it.note ? `  — ${it.note}` : ""}`);
  };
  section("copied", r.ledger.copied);
  section("regenerated", r.ledger.regenerated);
  section("skipped", r.ledger.skipped);
  if (r.ledger.secrets.length) {
    L.push("");
    L.push(`  secrets to set before start (values were NOT copied):`);
    for (const s of r.ledger.secrets) L.push(`    ${s.key} → add  ${s.ref}=<value>  to ${join(r.targetNodeDir, ".env")} (mode 600), or export ${s.ref}`);
  }
  if (r.ledger.skipped.some((s) => s.item === "codex-home/auth.json")) {
    L.push("");
    L.push(`  codex login: the clone does not reuse the source's auth.json. One login per node: log it in first,`);
    L.push(`    CODEX_HOME=${join(r.targetNodeDir, "codex-home")} codex login --device-auth`);
    L.push(`  Otherwise its first start stages this host's ~/.codex login — and refuses (exit 1) if another`);
    L.push(`  node already uses that login (refresh tokens are single-use — #514, #1918).`);
    L.push(`  For a registered account: anet node codex account install ${r.target} --source codex-login:<profile-id>`);
  }
  return L.join("\n");
}

/** realpath that tolerates a missing path (resolves the nearest existing parent). */
export function realpathLoose(p: string): string {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch {
    const parts = abs.split(sep);
    for (let n = parts.length - 1; n > 0; n--) {
      const head = parts.slice(0, n).join(sep) || sep;
      try { return join(realpathSync(head), ...parts.slice(n)); } catch { /* go up */ }
    }
    return abs;
  }
}
