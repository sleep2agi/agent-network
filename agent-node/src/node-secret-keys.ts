/**
 * #1474 (#909) — report the **names** of the keys a node actually has, never
 * their values.
 *
 * Why this exists: the client has a per-node secrets panel that was a
 * simulation (`simulateSecretSave`) with no transport behind it, and the Hub has
 * no idea which node has which env key. Before building any write channel we
 * need the read side, and the read side must be safe by construction:
 *
 *   * only the key NAMES leave this module — values are parsed and dropped here;
 *   * the file is read exactly like the loader reads it (regular file, no
 *     symlink); a symlink or a non-regular file reports nothing instead of
 *     following it;
 *   * reserved keys (PATH, LD_*, NODE_*, …) are skipped because they are not
 *     secrets and their presence says nothing about the node's configuration;
 *   * the list is sorted and capped so a pathological file cannot grow
 *     `report_status` without bound.
 *
 * A missing file is not an error: many nodes have no `secrets.env`.
 */
import { lstatSync, readFileSync } from "node:fs";
import { isReservedEnvKey } from "./shared/reserved-env.js";
import { nodeSecretsPath, parseSecretsEnv } from "./node-secrets.js";

/** Hub's `report_status` accepts at most this many keys; keep the emitter and
 *  the receiver on the same number or the hub will silently drop the tail. */
export const SECRET_KEYS_MAX = 50;
/** Same shape the loader accepts: uppercase env identifiers, max 64 chars. */
export const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

export function collectSecretKeys(nodeDir: string | undefined | null): string[] {
  if (!nodeDir) return [];
  let raw: string;
  try {
    const path = nodeSecretsPath(nodeDir);
    const st = lstatSync(path);
    // lstat (not stat): a symlink could point at a file this node does not own.
    if (!st.isFile() || st.isSymbolicLink()) return [];
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let parsed: ReturnType<typeof parseSecretsEnv>;
  try {
    parsed = parseSecretsEnv(raw);
  } catch {
    return [];
  }
  const keys = new Set<string>();
  for (const key of Object.keys(parsed.values)) {
    if (!SECRET_KEY_RE.test(key)) continue;
    if (isReservedEnvKey(key)) continue;
    keys.add(key);
  }
  return [...keys].sort().slice(0, SECRET_KEYS_MAX);
}
