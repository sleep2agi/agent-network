// #204 preview.7 — per-node isolated cwd for grok-build-acp runtime.
//
// Why this exists (in 3 lines):
//   1. Grok CLI auto-discovers MCP servers from <cwd>/.mcp.json on spawn.
//   2. Vincent's user cwd can carry a stale .mcp.json (COMMHUB_ALIAS=<old node>).
//   3. We need Grok to find NO .mcp.json — only the ACP-injected HTTP MCP.
//
// Strategy: pass `~/.anet/nodes/<nodeKey>/grok-cwd/` as the ACP session/new
// `cwd` field. That dir mirrors the user's top-level entries via symlink
// (so LLM `Read('./README.md')` still works) but explicitly omits
// `.mcp.json` so Grok's cwd-discovery finds nothing.
//
// Extracted from inline processWithGrok block to make it testable: the
// inline path was failing Docker smoke not because the algorithm is wrong
// but because exercising it end-to-end requires a real Grok binary +
// xAI auth. A direct bun-test against this helper is faster and more
// reliable; the Docker self-test then only verifies install/boot.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  symlinkSync,
} from "fs";
import { join } from "path";
import { homedir } from "os";

export interface PrepareGrokIsolatedCwdInput {
  /** User's project cwd (typically `process.cwd()`). */
  userCwd: string;
  /** Per-node key — used to construct the isolated dir. Prefers node_id; falls back to alias. */
  nodeId?: string;
  alias?: string;
  /** Override for tests so we don't always touch `~/.anet/`. Defaults to `homedir()`. */
  home?: string;
  /** Optional logger for symlink failures (test can capture). Defaults to silent. */
  onWarn?: (msg: string) => void;
}

export interface PrepareGrokIsolatedCwdResult {
  /** The cwd to pass into ACP `session/new`. Falls back to `userCwd` on failure. */
  cwd: string;
  /** True when isolated dir was successfully prepared. */
  isolated: boolean;
  /** Number of entries symlinked this call (excludes already-existing). */
  symlinked: number;
  /** Number of entries skipped (only `.mcp.json` today). */
  skipped: number;
  /** Failure message if `isolated === false`. */
  error?: string;
}

/**
 * Idempotent: re-running with the same userCwd/nodeId is safe and cheap.
 * Existing symlinks are left as-is; we never overwrite or unlink.
 *
 * Per-entry try/catch ensures a single bad symlink (permission denied,
 * cross-device, etc.) doesn't break the whole loop — we warn and move on.
 *
 * Top-level mirroring only (no recursion). Mid-session new files in the
 * user cwd are NOT picked up until the next `prepare` call — acceptable
 * trade-off for #204 P0 (P3 follow-up: fs.watch + relink).
 */
export function prepareGrokIsolatedCwd(
  opts: PrepareGrokIsolatedCwdInput,
): PrepareGrokIsolatedCwdResult {
  const userCwd = opts.userCwd;
  const home = opts.home ?? homedir();
  const warn = opts.onWarn ?? (() => {});
  const rawKey = opts.nodeId || opts.alias || "default";
  const nodeKey = rawKey.replace(/[^A-Za-z0-9._-]/g, "_");
  const isolatedCwd = join(home, ".anet", "nodes", nodeKey, "grok-cwd");

  try {
    mkdirSync(isolatedCwd, { recursive: true });
  } catch (e: any) {
    return {
      cwd: userCwd,
      isolated: false,
      symlinked: 0,
      skipped: 0,
      error: `mkdir failed: ${e?.message || e}`,
    };
  }

  let entries: string[];
  try {
    entries = readdirSync(userCwd);
  } catch (e: any) {
    return {
      cwd: userCwd,
      isolated: false,
      symlinked: 0,
      skipped: 0,
      error: `readdir userCwd failed: ${e?.message || e}`,
    };
  }

  let symlinked = 0;
  let skipped = 0;
  for (const entry of entries) {
    if (entry === ".mcp.json") {
      skipped++;
      continue;
    }
    const src = join(userCwd, entry);
    const dst = join(isolatedCwd, entry);
    if (existsSync(dst)) continue; // idempotent — restart-safe
    try {
      const st = statSync(src);
      symlinkSync(src, dst, st.isDirectory() ? "dir" : "file");
      symlinked++;
    } catch (e: any) {
      warn(`#204 skip symlink ${entry}: ${e?.message || e}`);
    }
  }

  return { cwd: isolatedCwd, isolated: true, symlinked, skipped };
}
