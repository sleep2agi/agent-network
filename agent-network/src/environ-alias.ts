// #180 — /proc/<pid>/environ parser for COMMHUB_ALIAS matching.
//
// Extracted into its own module so the alias-matching algorithm is
// unit-testable in isolation. Used by findMcpBridgeOrphansByAlias +
// sweepMcpOrphansForAlias in bin/cli.ts to catch MCP bridge orphans
// that renameCommand's argv-based process detection would otherwise
// miss (docker e2e run-4 lock).
//
// The environ file is NUL-separated key=val entries. We do a byte-
// exact match for `COMMHUB_ALIAS=<value>` — no substring games, no
// partial. Callers exclude self-pid + init pid.

import { readFileSync, readdirSync } from "fs";

/** Parse the environ blob (NUL-separated key=val) and return the
 *  COMMHUB_ALIAS value if present, else null. Exported for testing. */
export function parseEnvironAlias(environBlob: string): string | null {
  for (const entry of environBlob.split("\0")) {
    if (entry.startsWith("COMMHUB_ALIAS=")) {
      return entry.slice("COMMHUB_ALIAS=".length);
    }
  }
  return null;
}

/** Read /proc/<pid>/environ and return the COMMHUB_ALIAS value.
 *  Any file-read error (not-a-Linux, permission denied, race with
 *  process exit) returns null — caller must not fail-closed on that
 *  (the process is stale/gone/inaccessible, not our problem). */
export function readEnvironAlias(pid: number): string | null {
  try {
    return parseEnvironAlias(readFileSync(`/proc/${pid}/environ`).toString("utf-8"));
  } catch {
    return null;
  }
}

/** Scan /proc for pids whose COMMHUB_ALIAS env matches any of the
 *  target aliases. Linux-only (procfs); returns null on non-Linux or
 *  when /proc is unreadable — caller MUST fail-closed on null per
 *  the same #180 R2 fail-closed contract as findNodeProcessesByAlias.
 *  Self-pid + init (PID 1) are excluded. */
export function findEnvironAliasMatches(
  aliases: Iterable<string>,
  selfPid: number,
): number[] | null {
  const wanted = new Set<string>();
  for (const a of aliases) { if (a) wanted.add(a); }
  if (wanted.size === 0) return [];
  let pidDirs: string[];
  try {
    pidDirs = readdirSync("/proc").filter(n => /^\d+$/.test(n));
  } catch {
    return null;
  }
  const pids = new Set<number>();
  for (const name of pidDirs) {
    const pid = parseInt(name, 10);
    if (isNaN(pid) || pid === selfPid || pid === 1) continue;
    const alias = readEnvironAlias(pid);
    if (alias !== null && wanted.has(alias)) pids.add(pid);
  }
  return [...pids];
}
