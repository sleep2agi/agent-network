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
import { join } from "node:path";
import { isReservedEnvKey } from "./shared/reserved-env.js";
import { nodeSecretsPath, parseSecretsEnv } from "./node-secrets.js";

/** Hub's `report_status` accepts at most this many keys; keep the emitter and
 *  the receiver on the same number or the hub will silently drop the tail. */
export const SECRET_KEYS_MAX = 50;
/** Same shape the loader accepts: uppercase env identifiers, max 64 chars. */
export const SECRET_KEY_RE = /^[A-Z_][A-Z0-9_]{0,63}$/;

function readRegularFileSafe(path: string): string | null {
  try {
    const st = lstatSync(path);
    // lstat (not stat): a symlink could point at a file this node does not own.
    if (!st.isFile() || st.isSymbolicLink()) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function collectSecretKeys(nodeDir: string | undefined | null): string[] {
  if (!nodeDir) return [];
  const keys = new Set<string>();
  const addKey = (key: string) => {
    if (!SECRET_KEY_RE.test(key)) return;
    if (isReservedEnvKey(key)) return;
    keys.add(key);
  };

  const envRaw = readRegularFileSafe(nodeSecretsPath(nodeDir));
  if (envRaw !== null) {
    try {
      const parsed = parseSecretsEnv(envRaw);
      for (const key of Object.keys(parsed.values)) addKey(key);
    } catch {
      // Ignore malformed secrets.env; never leak values or break heartbeats.
    }
  }

  // #5505 — also read key NAMES from `<nodeDir>/node-secrets.json` written by
  // Hub's independent node-secrets lane (and ChatSecretCard). Values are never
  // returned or logged.
  const jsonRaw = readRegularFileSafe(join(nodeDir, "node-secrets.json"));
  if (jsonRaw !== null) {
    try {
      const parsed = JSON.parse(jsonRaw) as { values?: unknown };
      if (parsed && typeof parsed === "object" && parsed.values && typeof parsed.values === "object" && !Array.isArray(parsed.values)) {
        for (const [key, val] of Object.entries(parsed.values as Record<string, unknown>)) {
          if (typeof val !== "string" || !val) continue;
          addKey(key);
        }
      }
    } catch {
      // Ignore malformed node-secrets.json.
    }
  }

  return [...keys].sort().slice(0, SECRET_KEYS_MAX);
}
