/**
 * Per-node env file, board #637. Same filename as #2056 `anet node secret`:
 * `<node dir>/secrets.env`, next to that node's `config.json`.
 *
 * Only this one file is loaded. There is no machine-wide file on this path.
 *
 * Precedence at startup, highest wins:
 *   1. process env already set when agent-node starts
 *      (a key present as an empty string counts as set and is kept)
 *   2. keys named in config.json `env` (plain or `_envRef`)
 *      — left for the existing injector, not written here
 *   3. this file, fill-only, for every other well-formed key
 *
 * A missing file is not an error. A symlink, a non-regular file, a file
 * owned by someone else, or a mode other than 0600 is an error: nothing
 * from the file is applied. Reserved keys (PATH, LD_*, NODE_*, …) are
 * skipped, not applied. Logs and errors name keys and modes only.
 *
 * `ANET_NODE_SECRET_PROBE=1` is a test hook. It spawns one child that
 * inherits this process env and writes `{value, argv}` for the key named
 * by `ANET_NODE_SECRET_PROBE_KEY` to `ANET_NODE_SECRET_PROBE_OUT` (must
 * sit under the system temp dir). The value is never an argument.
 */

import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { isReservedEnvKey } from "./shared/reserved-env.js";

export const NODE_SECRETS_FILE_NAME = "secrets.env";

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
const KEY_MAX = 128;
const VALUE_MAX_BYTES = 8 * 1024;

export interface SecretsParseProblem {
  line: number;
  reason: string;
}

export function nodeSecretsPath(nodeDir: string): string {
  return join(nodeDir, NODE_SECRETS_FILE_NAME);
}

function shapeProblem(key: string): string | null {
  if (!KEY_RE.test(key)) return "key must match ^[A-Z_][A-Z0-9_]*$";
  if (key.length > KEY_MAX) return `key is longer than ${KEY_MAX} characters`;
  return null;
}

function parseLine(line: string): { key: string; value: string } | null | string {
  let t = line.replace(/^\s+/, "");
  if (t === "" || t.startsWith("#")) return null;
  t = t.replace(/^export\s+/, "");
  const eq = t.indexOf("=");
  if (eq < 0) return "not a KEY=value line";
  const key = t.slice(0, eq).trim();
  const problem = shapeProblem(key);
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

export function parseSecretsEnv(raw: string): { values: Record<string, string>; problems: SecretsParseProblem[] } {
  const values: Record<string, string> = Object.create(null);
  const problems: SecretsParseProblem[] = [];
  raw.replace(/^\uFEFF/, "").split(/\r?\n/).forEach((line, i) => {
    const parsed = parseLine(line);
    if (parsed === null) return;
    if (typeof parsed === "string") {
      problems.push({ line: i + 1, reason: parsed });
      return;
    }
    if (Buffer.byteLength(parsed.value, "utf8") > VALUE_MAX_BYTES) {
      problems.push({ line: i + 1, reason: `value is over the ${VALUE_MAX_BYTES} byte limit` });
      return;
    }
    values[parsed.key] = parsed.value;
  });
  return { values, problems };
}

function modeText(mode: number): string {
  return "0" + (mode & 0o777).toString(8);
}

export class NodeSecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeSecretsError";
  }
}

function readSecretsFile(path: string): string {
  let lst;
  try {
    lst = lstatSync(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return "";
    throw new NodeSecretsError(`env: refusing to load ${NODE_SECRETS_FILE_NAME}: ${e?.code || "unreadable"}`);
  }
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw new NodeSecretsError(`env: refusing to load ${NODE_SECRETS_FILE_NAME}: not a regular file`);
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const st = fstatSync(fd);
    const uid = process.getuid?.();
    if (!st.isFile() || st.nlink !== 1 || (uid !== undefined && st.uid !== uid)) {
      throw new NodeSecretsError(`env: refusing to load ${NODE_SECRETS_FILE_NAME}: not owned by this user`);
    }
    if (process.platform !== "win32" && (st.mode & 0o777) !== 0o600) {
      throw new NodeSecretsError(
        `env: refusing to load ${NODE_SECRETS_FILE_NAME}: mode is ${modeText(st.mode)}, want 0600`,
      );
    }
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

export interface LoadNodeSecretsOptions {
  /** Keys named in config.json `env`. Not overwritten; the injector owns them. */
  explicitConfigKeys?: readonly string[];
  log?: (line: string) => void;
}

/**
 * Fill `env` from `<nodeDir>/secrets.env`. No-op when `nodeDir` is empty
 * or the file is absent. Throws NodeSecretsError without applying anything
 * when the file is present but unsafe or unparseable.
 */
export function loadNodeSecrets(
  nodeDir: string,
  env: NodeJS.ProcessEnv,
  options: LoadNodeSecretsOptions = {},
): void {
  if (!nodeDir) return;
  const path = nodeSecretsPath(nodeDir);
  let raw = "";
  try {
    lstatSync(path);
  } catch (e: any) {
    if (e?.code === "ENOENT") return;
    throw new NodeSecretsError(`env: refusing to load ${NODE_SECRETS_FILE_NAME}: ${e?.code || "unreadable"}`);
  }
  raw = readSecretsFile(path);
  const { values, problems } = parseSecretsEnv(raw);
  if (problems.length > 0) {
    const first = problems[0]!;
    throw new NodeSecretsError(
      `env: refusing to load ${NODE_SECRETS_FILE_NAME}: line ${first.line}: ${first.reason}`,
    );
  }
  const explicit = new Set(options.explicitConfigKeys || []);
  const loaded: string[] = [];
  const keptProcess: string[] = [];
  const keptConfig: string[] = [];
  const skippedReserved: string[] = [];
  for (const key of Object.keys(values).sort()) {
    if (isReservedEnvKey(key)) {
      skippedReserved.push(key);
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      keptProcess.push(key);
      continue;
    }
    if (explicit.has(key)) {
      keptConfig.push(key);
      continue;
    }
    env[key] = values[key];
    loaded.push(key);
  }
  if (loaded.length + keptProcess.length + keptConfig.length + skippedReserved.length === 0) return;
  const parts = [
    loaded.length ? `loaded=${loaded.join(",")}` : "",
    keptProcess.length ? `kept-from-process=${keptProcess.join(",")}` : "",
    keptConfig.length ? `kept-from-config=${keptConfig.join(",")}` : "",
    skippedReserved.length ? `skipped-reserved=${skippedReserved.join(",")}` : "",
  ].filter(Boolean);
  options.log?.(`[agent-node] env: ${parts.join(" ")}`);
}

/** Test hook. Returns null when the probe is not requested. */
export function runNodeSecretProbeIfRequested(): number | null {
  if (process.env.ANET_NODE_SECRET_PROBE !== "1") return null;
  const out = process.env.ANET_NODE_SECRET_PROBE_OUT || "";
  const key = process.env.ANET_NODE_SECRET_PROBE_KEY || "";
  if (!out || out.includes("\0") || !isAbsolute(out)) {
    console.error("[agent-node] env probe: output path must be an absolute path under the temp dir");
    return 1;
  }
  const root = resolve(tmpdir());
  const dest = resolve(out);
  if (dest !== root && !dest.startsWith(root + sep)) {
    console.error("[agent-node] env probe: output path must be an absolute path under the temp dir");
    return 1;
  }
  if (key && !KEY_RE.test(key)) {
    console.error("[agent-node] env probe: key name is not an env key");
    return 1;
  }
  const script = [
    'const fs=require("node:fs");',
    "const out=process.env.ANET_NODE_SECRET_PROBE_OUT;",
    'const key=process.env.ANET_NODE_SECRET_PROBE_KEY||"";',
    "const value=key&&Object.prototype.hasOwnProperty.call(process.env,key)?process.env[key]:null;",
    "fs.writeFileSync(out, JSON.stringify({value, argv: process.argv}), {mode:0o600});",
  ].join("");
  const child = spawnSync(process.execPath, ["-e", script], {
    env: process.env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  return child.status ?? 1;
}
