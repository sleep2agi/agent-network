/**
 * #2056 (#909) — `anet node secret` reads the node's own `secrets.env`.
 *
 * This file only ever exposes the **names** of the keys the node will load.
 * Values are parsed and dropped in `readNodeSecretKeys`; every function here
 * returns names or a count, never a value.
 *
 * Why a small local reader instead of importing agent-node's loader: the `anet`
 * CLI lives in the agent-network package, which does not depend on agent-node
 * (same split as `os-user.ts`). The on-disk contract is shared by #637's
 * loader in agent-node: `<node dir>/secrets.env`, 0600, one `KEY=VALUE` per
 * line, reserved keys ignored.
 *
 * Safety rules, same as the node-side collector:
 *   * `lstat` — symlinks and non-regular files report nothing instead of
 *     following a path this node may not own;
 *   * reserved keys (PATH / LD_* / NODE_* …) are not secrets;
 *   * names are sorted and capped so a pathological file cannot flood output.
 */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isReservedEnvKey } from "./shared/reserved-env.js";

export const SECRET_KEYS_FILE = "secrets.env";
export const NODE_SECRET_KEYS_MAX = 50;
const KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function nodeSecretFilePath(nodeDir: string): string {
  return join(nodeDir, SECRET_KEYS_FILE);
}

export type NodeSecretKeysRead =
  | { kind: "ok"; keys: string[] }
  | { kind: "missing" }
  | { kind: "unsafe"; reason: string };

/** Names only. Never returns values, and never throws. */
export function readNodeSecretKeys(nodeDir: string): NodeSecretKeysRead {
  let raw: string;
  let st: ReturnType<typeof lstatSync>;
  try {
    const path = nodeSecretFilePath(nodeDir);
    st = lstatSync(path);
    if (st.isSymbolicLink()) return { kind: "unsafe", reason: "secrets.env is a symlink; not following it" };
    if (!st.isFile()) return { kind: "unsafe", reason: "secrets.env is not a regular file" };
    raw = readFileSync(path, "utf8");
  } catch (e: any) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { kind: "missing" };
    return { kind: "unsafe", reason: `cannot read secrets.env: ${e?.code ?? e?.message ?? "unknown"}` };
  }
  const keys = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    if (isReservedEnvKey(key)) continue;
    keys.add(key);
  }
  return { kind: "ok", keys: [...keys].sort().slice(0, NODE_SECRET_KEYS_MAX) };
}

/** File mode warning: the loader refuses a secrets.env that is not 0600, so the
 *  CLI should say so instead of printing a list the node will silently skip. */
export function nodeSecretFileModeWarning(nodeDir: string): string | null {
  try {
    const st = lstatSync(nodeSecretFilePath(nodeDir));
    if (!st.isFile()) return null;
    const mode = st.mode & 0o777;
    if (mode === 0o600) return null;
    return `secrets.env is mode ${mode.toString(8).padStart(3, "0")}; the node loader only applies 0600 (run: chmod 600 <path>)`;
  } catch {
    return null;
  }
}

export type NodeSecretWriteResult =
  | { kind: "ok"; changed: boolean }
  | { kind: "rejected"; reason: string };

/** Replace the value of one key, or append it. Line-based so comments and the
 *  operator's own ordering survive; only the matching line is rewritten.
 *
 *  The value arrives from the caller (CLI reads stdin) — it is never logged,
 *  never echoed, and never put in an error message. */
export function writeNodeSecret(nodeDir: string, key: string, value: string): NodeSecretWriteResult {
  const bad = validateKeyValue(key, value);
  if (bad) return bad;
  const read = readForEdit(nodeDir);
  if (read.kind === "unsafe") return { kind: "rejected", reason: read.reason };
  const lines = read.kind === "ok" ? [...read.lines] : [];
  const rendered = `${key}=${quoteIfNeeded(value)}`;
  const hits = lines.map((line, index) => (lineKey(line) === key ? index : -1)).filter(i => i >= 0);
  if (hits.length === 0) {
    lines.push(rendered);
  } else {
    // Keep the operator's position; collapse duplicates (the loader would take
    // the last one, which makes "why is my value ignored" impossible to see).
    lines[hits[0]] = rendered;
    for (const index of hits.slice(1).reverse()) lines.splice(index, 1);
  }
  const wrote = writeAll(nodeDir, lines);
  return wrote ?? { kind: "ok", changed: true };
}

function lineKey(line: string): string | null {
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  const candidate = line.slice(0, eq).trim();
  return KEY_RE.test(candidate) ? candidate : null;
}

/** Drop the key's line(s). Returns changed=false when the key was not present. */
export function removeNodeSecret(nodeDir: string, key: string): NodeSecretWriteResult {
  const check = validateKeyValue(key, "x");
  if (check) return check;
  const read = readForEdit(nodeDir);
  if (read.kind === "unsafe") return { kind: "rejected", reason: read.reason };
  if (read.kind === "missing") return { kind: "ok", changed: false };
  let changed = false;
  const out = read.lines.filter(line => {
    const eq = line.indexOf("=");
    if (eq <= 0) return true;
    if (line.slice(0, eq).trim() !== key) return true;
    changed = true;
    return false;
  });
  if (!changed) return { kind: "ok", changed: false };
  const wrote = writeAll(nodeDir, out);
  if (wrote) return wrote;
  return { kind: "ok", changed: true };
}

function validateKeyValue(key: string, value: string): { kind: "rejected"; reason: string } | null {
  if (!KEY_RE.test(key)) return { kind: "rejected", reason: "key must match ^[A-Z_][A-Z0-9_]{0,63}$" };
  if (isReservedEnvKey(key)) return { kind: "rejected", reason: `${key} is a reserved key, not a secret` };
  if (value.includes("\n") || value.includes("\r") || value.includes("\0")) {
    return { kind: "rejected", reason: "value must be a single line (no newline / NUL)" };
  }
  if (value.length > 8192) return { kind: "rejected", reason: "value is longer than 8192 bytes" };
  return null;
}

/** Keep simple values unquoted so the file stays readable; quote anything with
 *  spaces or shell-significant characters the loader would otherwise trim. */
function quoteIfNeeded(value: string): string {
  if (value === "") return "";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function readForEdit(nodeDir: string): { kind: "ok"; lines: string[] } | { kind: "missing" } | { kind: "unsafe"; reason: string } {
  try {
    const path = nodeSecretFilePath(nodeDir);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) return { kind: "unsafe", reason: "secrets.env is a symlink; refusing to write through it" };
    if (!st.isFile()) return { kind: "unsafe", reason: "secrets.env is not a regular file" };
    const raw = readFileSync(path, "utf8");
    const lines = raw.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return { kind: "ok", lines };
  } catch (e: any) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return { kind: "missing" };
    return { kind: "unsafe", reason: `cannot read secrets.env: ${e?.code ?? e?.message ?? "unknown"}` };
  }
}

/** Write via a sibling temp file + rename, so a crash cannot leave a half file.
 *  The temp file is created 0600 and the final chmod is 0600 as well. */
function writeAll(nodeDir: string, lines: string[]): { kind: "rejected"; reason: string } | null {
  try {
    mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
    const target = nodeSecretFilePath(nodeDir);
    const tmp = `${target}.tmp-${process.pid}`;
    try { unlinkSync(tmp); } catch {}
    const fd = openSync(tmp, "w", 0o600);
    try {
      const body = lines.length ? `${lines.join("\n")}\n` : "";
      writeSync(fd, body);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, target);
    return null;
  } catch (e: any) {
    return { kind: "rejected", reason: `cannot write secrets.env: ${e?.code ?? e?.message ?? "unknown"}` };
  }
}
