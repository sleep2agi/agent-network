/**
 * Local secrets store: `~/.anet/secrets.env` (every node on this machine) and
 * `<node dir>/secrets.env` (one node; the directory that holds its config.json).
 *
 * Why this exists. Before it, a node's secrets lived either in plain text in
 * config.json `env` (deprecated, printed a warning) or behind `{"_envRef":"X"}`,
 * which only works when someone exported X in the shell that started the node —
 * so the value was gone after the next restart. The owner's verdict was "现在等于
 * 没有管理". These two files are set once and read at every start.
 *
 * Precedence, lowest → highest:
 *
 *   process env  <  global secrets.env  <  node secrets.env  <  config.json `env`
 *
 * config.json `env` keys (plain or `_envRef`) are left entirely to the existing
 * injector in agent-node/src/cli.ts: a key named there is skipped here, so the
 * explicit per-node config keeps the last word and `_envRef` still resolves the
 * way it always did — except that the referenced variable can now come from a
 * secrets file instead of an `export`.
 *
 * 🔴 WHERE THIS RUNS, and why the file exists twice. The loader has to run in
 *    agent-node itself: most fleet nodes start `agent-node --config …` straight
 *    from a script, not through `anet node start` (the same finding as #1918).
 *    `anet node start` also applies it, for the runtimes it spawns directly
 *    (claude-code-cli). The two packages cannot import each other, so this file
 *    is copied byte-for-byte to agent-network/src/node-secrets.ts and
 *    agent-network/src/node-secrets-parity.test.ts keeps them equal. It imports
 *    node builtins only — that is what makes the copy possible.
 *
 * Boundaries:
 *   1. Values never leave through a return meant for display, a log line or an
 *      error message. Listing gives key, source and length only.
 *   2. A file owned by another user is refused (not loaded). A file owned by us
 *      but readable by group/other is chmod-ed to 0600 on the spot and loaded —
 *      usability first, and the same repair the rest of the repo does for
 *      config.json (#472).
 *   3. Writes: temp file (O_EXCL|O_NOFOLLOW, 0600) → fchmod 0600 → fsync →
 *      rename. fchmod makes the mode independent of the umask (0002 on this
 *      fleet's boxes would otherwise give 0664).
 *   4. Keys that would let a file hijack or break the node (PATH, NODE_OPTIONS,
 *      LD_*, ANET_*, COMMHUB_* …) are refused on write and skipped on load.
 *   5. The Codex login (auth.json / refresh token) is NOT a secret to share: its
 *      refresh token is single-use, so one copy on two nodes logs one of them
 *      out (#1918). Nothing here reads or writes it.
 */

import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, basename } from "node:path";

export const SECRETS_FILE_NAME = "secrets.env";
export const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
export const SECRET_KEY_MAX_LENGTH = 128;
export const SECRET_VALUE_MAX_BYTES = 8 * 1024;

export function globalSecretsPath(home: string): string {
  return join(home, ".anet", SECRETS_FILE_NAME);
}

export function nodeSecretsPath(nodeDir: string): string {
  return join(nodeDir, SECRETS_FILE_NAME);
}

/**
 * The node directory for a resolved config file, or null. Node secrets sit next
 * to the node's own config.json (`<root>/.anet/nodes/<id>/config.json`, whatever
 * the root is). A legacy `.anet/profiles/<alias>.json` or `.agent-node.json`
 * has no per-node directory, so such a node only gets the global file.
 */
export function nodeDirForConfig(configFilePath: string | undefined | null): string | null {
  if (!configFilePath) return null;
  return basename(configFilePath) === "config.json" ? dirname(configFilePath) : null;
}

// ─── key rules ───
// Same deny list as #2004's ENV-KEY-RULES (per-node env over the hub), plus the
// RFC-026 reserved-env set. When #2004 lands, both should come from one place.

const DENY_EXACT: ReadonlySet<string> = new Set([
  "_",
  "PATH", "PATHEXT", "HOME", "USERPROFILE", "USER", "LOGNAME", "SHELL", "PWD",
  "TMPDIR", "TMP", "TEMP", "HOSTNAME", "IFS", "LANG", "LC_ALL", "CDPATH", "PS1",
  "BASH_ENV", "ENV", "PROMPT_COMMAND", "PS4", "SHELLOPTS", "BASHOPTS",
  "PYTHONSTARTUP", "PYTHONPATH", "PYTHONHOME", "PERL5OPT", "PERL5LIB", "PERLLIB",
  "RUBYOPT", "RUBYLIB", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS",
  "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
  "ALIAS", "RUNTIME", "MODEL", "CURRENT_TASK_ID",
  "CODEX_HOME", "GROK_HOME", "CLAUDE_CONFIG_DIR", "TELEGRAM_STATE_DIR",
  "MOCK_LLM_REPLIES_FILE",
]);
const DENY_PREFIXES: readonly string[] = [
  "LD_", "DYLD_", "NODE_", "BUN_", "NPM_", "XDG_", "ANET_", "COMMHUB_",
];
const DENY_SUFFIXES: readonly string[] = ["_BINARY"];

/** null = the key may be stored; otherwise why not (never mentions a value). */
export function secretKeyProblem(key: unknown): string | null {
  if (typeof key !== "string" || !SECRET_KEY_RE.test(key)) {
    return "key must match ^[A-Z_][A-Z0-9_]*$ (upper-case letters, digits, underscore; not starting with a digit)";
  }
  if (key.length > SECRET_KEY_MAX_LENGTH) return `key is longer than ${SECRET_KEY_MAX_LENGTH} characters`;
  if (DENY_EXACT.has(key)) return `${key} is reserved: the node relies on it (setting it could stop the node from starting or hijack it)`;
  for (const p of DENY_PREFIXES) if (key.startsWith(p)) return `${p}* variables are reserved for the node runtime, its loader and its hub identity`;
  for (const s of DENY_SUFFIXES) if (key.endsWith(s)) return `*${s} variables choose which program the node runs and are reserved`;
  return null;
}

export function secretValueProblem(value: unknown): string | null {
  if (typeof value !== "string") return "value must be a string";
  if (value.length === 0) return "value is empty (use unset to remove a key)";
  if (value.includes("\0")) return "value must not contain NUL";
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > SECRET_VALUE_MAX_BYTES) return `value is ${bytes} bytes, over the ${SECRET_VALUE_MAX_BYTES} byte limit`;
  return null;
}

// ─── parse / serialize ───

export interface SecretsParseProblem { line: number; reason: string }
export interface ParsedSecrets { values: Record<string, string>; problems: SecretsParseProblem[] }

interface LineEntry { key: string; value: string }

/**
 * One line → entry, `null` for a blank/comment line, or a problem string.
 * Accepted: `KEY=value`, `export KEY=value`, `KEY="a \"quoted\" value\n"`,
 * `KEY='literal'`. Unquoted values are trimmed and taken verbatim otherwise:
 * `#` inside an unquoted value is part of the value, not a comment.
 */
function parseLine(line: string): LineEntry | null | string {
  let t = line.replace(/^\s+/, "");
  if (t === "" || t.startsWith("#")) return null;
  t = t.replace(/^export\s+/, "");
  const eq = t.indexOf("=");
  if (eq < 0) return "not a KEY=value line";
  const key = t.slice(0, eq).trim();
  const problem = secretKeyShapeProblem(key);
  if (problem) return problem;
  const rest = t.slice(eq + 1).replace(/^\s+/, "");
  const q = rest[0];
  if (q === "'" || q === "\"") {
    let value = "";
    let i = 1;
    let closed = false;
    for (; i < rest.length; i++) {
      const c = rest[i]!;
      if (c === q) { closed = true; i++; break; }
      if (q === "\"" && c === "\\" && i + 1 < rest.length) {
        const n = rest[++i]!;
        value += n === "n" ? "\n" : n === "r" ? "\r" : n === "t" ? "\t" : n;
        continue;
      }
      value += c;
    }
    if (!closed) return "unterminated quote";
    const tail = rest.slice(i).trim();
    if (tail !== "" && !tail.startsWith("#")) return "text after the closing quote";
    return { key, value };
  }
  return { key, value: rest.trim() };
}

/** Shape only (the file may hold a reserved key; the loader skips it by name). */
function secretKeyShapeProblem(key: string): string | null {
  if (!SECRET_KEY_RE.test(key)) return "key must match ^[A-Z_][A-Z0-9_]*$";
  if (key.length > SECRET_KEY_MAX_LENGTH) return `key is longer than ${SECRET_KEY_MAX_LENGTH} characters`;
  return null;
}

function splitLines(raw: string): string[] {
  return raw.replace(/^\uFEFF/, "").split(/\r?\n/);
}

export function parseSecretsEnv(raw: string): ParsedSecrets {
  const values: Record<string, string> = Object.create(null);
  const problems: SecretsParseProblem[] = [];
  splitLines(raw).forEach((line, i) => {
    const r = parseLine(line);
    if (r === null) return;
    if (typeof r === "string") { problems.push({ line: i + 1, reason: r }); return; }
    values[r.key] = r.value;
  });
  return { values, problems };
}

/** Serialize one value so parseSecretsEnv reads back exactly the same string. */
export function formatSecretValue(value: string): string {
  const plain = /^[^\s"'\\]([^\r\n]*\S)?$/.test(value);
  if (plain) return value;
  return "\"" + value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t") + "\"";
}

/** Replace (or append) KEY in the file text; comments and other lines are kept. */
export function upsertSecretLine(raw: string, key: string, value: string): string {
  const lines = raw === "" ? [] : splitLines(raw);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const out: string[] = [];
  let done = false;
  for (const line of lines) {
    const r = parseLine(line);
    if (r && typeof r === "object" && r.key === key) {
      if (!done) { out.push(`${key}=${formatSecretValue(value)}`); done = true; }
      continue;
    }
    out.push(line);
  }
  if (!done) out.push(`${key}=${formatSecretValue(value)}`);
  return out.join("\n") + "\n";
}

/** Drop every line that defines KEY. */
export function removeSecretLine(raw: string, key: string): { text: string; existed: boolean } {
  const lines = raw === "" ? [] : splitLines(raw);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let existed = false;
  const out = lines.filter((line) => {
    const r = parseLine(line);
    if (r && typeof r === "object" && r.key === key) { existed = true; return false; }
    return true;
  });
  return { text: out.length ? out.join("\n") + "\n" : "", existed };
}

// ─── read (permission policy lives here) ───

export type SecretsFileStatus = "missing" | "loaded" | "refused";

export interface SecretsFileRead {
  path: string;
  status: SecretsFileStatus;
  values: Record<string, string>;
  problems: SecretsParseProblem[];
  /** Mode before we tightened it to 0600 (group/other bits were set). */
  repairedFromMode?: number;
  /** Why a file was refused (never contains a value). */
  reason?: string;
  /** Mode as found on disk (after repair, if any). */
  mode?: number;
}

const O_NOFOLLOW = constants.O_NOFOLLOW || 0;
const O_NONBLOCK = constants.O_NONBLOCK || 0;

function emptyRead(path: string, status: SecretsFileStatus, reason?: string): SecretsFileRead {
  return { path, status, values: Object.create(null), problems: [], ...(reason ? { reason } : {}) };
}

/**
 * Read a secrets file under the permission policy:
 *   missing → status "missing" (not an error);
 *   not a regular file, or owned by another user → "refused", nothing loaded;
 *   owned by us with group/other bits → chmod 0600, then load (repairedFromMode set).
 * A symlink is followed; the checks apply to the file it points at.
 */
export function readSecretsFile(path: string, uid: number | undefined = process.getuid?.()): SecretsFileRead {
  return readChecked(path, uid).read;
}

function readChecked(path: string, uid: number | undefined): { read: SecretsFileRead; raw: string } {
  const r = readCheckedInner(path, uid);
  return "raw" in r ? r : { read: r, raw: "" };
}

function readCheckedInner(path: string, uid: number | undefined): SecretsFileRead | { read: SecretsFileRead; raw: string } {
  try { lstatSync(path); } catch (e: any) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return emptyRead(path, "missing");
    return emptyRead(path, "refused", `cannot stat (${e?.code || "error"})`);
  }
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | O_NONBLOCK); } catch (e: any) {
    if (e?.code === "ENOENT") return emptyRead(path, "missing");
    return emptyRead(path, "refused", `cannot open (${e?.code || "error"})`);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return emptyRead(path, "refused", "not a regular file");
    if (uid !== undefined && st.uid !== uid) {
      return emptyRead(path, "refused", `owned by uid ${st.uid}, not by the user running this (uid ${uid})`);
    }
    let mode = st.mode & 0o777;
    let repairedFromMode: number | undefined;
    if (process.platform !== "win32" && (mode & 0o077) !== 0) {
      try { fchmodSync(fd, 0o600); repairedFromMode = mode; mode = 0o600; } catch { /* keep loading; doctor reports the mode */ }
    }
    const raw = readFileSync(fd, "utf8");
    const parsed = parseSecretsEnv(raw);
    return {
      raw,
      read: {
        path, status: "loaded", values: parsed.values, problems: parsed.problems, mode,
        ...(repairedFromMode !== undefined ? { repairedFromMode } : {}),
      },
    };
  } finally {
    closeSync(fd);
  }
}

// ─── write ───

function readForUpdate(path: string): string {
  const { read, raw } = readChecked(path, process.getuid?.());
  if (read.status === "refused") throw new Error(`refusing to edit ${path}: ${read.reason}`);
  return raw;
}

/** temp (O_EXCL|O_NOFOLLOW, 0600) → write → fchmod 0600 → fsync → rename → fsync dir. */
export function atomicWriteSecretsFile(path: string, body: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | O_NOFOLLOW, 0o600);
    const buf = Buffer.from(body, "utf8");
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (e) {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
    try { rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
  if (process.platform !== "win32") {
    try { const dfd = openSync(dir, constants.O_RDONLY); try { fsyncSync(dfd); } finally { closeSync(dfd); } } catch {}
  }
}

export function setSecret(path: string, key: string, value: string): { created: boolean; replaced: boolean } {
  const kp = secretKeyProblem(key);
  if (kp) throw new Error(`invalid key: ${kp}`);
  const vp = secretValueProblem(value);
  if (vp) throw new Error(`invalid value: ${vp}`);
  const raw = readForUpdate(path);
  const replaced = Object.prototype.hasOwnProperty.call(parseSecretsEnv(raw).values, key);
  atomicWriteSecretsFile(path, upsertSecretLine(raw, key, value));
  return { created: raw === "" && !replaced, replaced };
}

export function unsetSecret(path: string, key: string): { existed: boolean } {
  const shape = secretKeyShapeProblem(key);
  if (shape) throw new Error(`invalid key: ${shape}`);
  const raw = readForUpdate(path);
  const { text, existed } = removeSecretLine(raw, key);
  if (existed) atomicWriteSecretsFile(path, text);
  return { existed };
}

// ─── merge ───

export type SecretSource = "global" | "node";

export interface SecretEnvPlan {
  /** Keys to put into the environment, and their values. */
  set: Record<string, string>;
  /** Where each key in `set` came from. */
  sources: Record<string, SecretSource>;
  /** Keys a file tried to set that the key rules forbid (skipped). */
  reserved: string[];
  /** Keys config.json `env` names explicitly (left to that injector). */
  shadowedByConfig: string[];
}

/**
 * process env < global < node < config.json `env`. Pure: the caller applies
 * `set` on top of its environment. `configEnvKeys` are the keys the node's
 * config.json `env` block names; those are skipped so the config injector
 * decides them exactly as before.
 */
export function planSecretEnv(opts: {
  global?: Record<string, string>;
  node?: Record<string, string>;
  configEnvKeys?: Iterable<string>;
}): SecretEnvPlan {
  const config = new Set(opts.configEnvKeys ?? []);
  const set: Record<string, string> = Object.create(null);
  const sources: Record<string, SecretSource> = Object.create(null);
  const reserved = new Set<string>();
  const shadowed = new Set<string>();
  const layers: [SecretSource, Record<string, string> | undefined][] = [["global", opts.global], ["node", opts.node]];
  for (const [source, values] of layers) {
    for (const [k, v] of Object.entries(values ?? {})) {
      if (secretKeyProblem(k)) { reserved.add(k); continue; }
      if (config.has(k)) { shadowed.add(k); continue; }
      set[k] = v;
      sources[k] = source;
    }
  }
  return { set, sources, reserved: [...reserved].sort(), shadowedByConfig: [...shadowed].sort() };
}

// ─── display (no values) ───

export interface SecretListEntry {
  key: string;
  source: SecretSource;
  /** Characters (code points) of the value in effect — never the value. */
  length: number;
  /** A node entry that overrides a global one with the same key. */
  overridesGlobal?: true;
}

function codePoints(s: string): number { let n = 0; for (const _ of s) n++; return n; }

export function listSecretEntries(global: Record<string, string>, node?: Record<string, string>): SecretListEntry[] {
  const out: SecretListEntry[] = [];
  for (const [key, v] of Object.entries(global)) {
    if (node && Object.prototype.hasOwnProperty.call(node, key)) continue;
    out.push({ key, source: "global", length: codePoints(v) });
  }
  for (const [key, v] of Object.entries(node ?? {})) {
    out.push({ key, source: "node", length: codePoints(v), ...(Object.prototype.hasOwnProperty.call(global, key) ? { overridesGlobal: true as const } : {}) });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** Operator-facing lines about one file (key names and counts only). */
export function describeSecretsRead(label: string, r: SecretsFileRead): string[] {
  const lines: string[] = [];
  if (r.status === "refused") {
    lines.push(`${label} secrets NOT loaded — ${r.path}: ${r.reason}`);
    return lines;
  }
  if (r.status === "missing") return lines;
  if (r.repairedFromMode !== undefined) {
    lines.push(`${label} secrets ${r.path} was mode ${r.repairedFromMode.toString(8).padStart(4, "0")}; tightened to 0600`);
  }
  for (const p of r.problems) lines.push(`${label} secrets ${r.path}:${p.line} skipped — ${p.reason}`);
  return lines;
}
