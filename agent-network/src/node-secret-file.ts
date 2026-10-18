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
import { lstatSync, readFileSync } from "node:fs";
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
