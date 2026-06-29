// RFC-027 §2.5 / §4.4 D7 nit — 30d backup sweeper.
//
// stop-daemon.ts moves a deleted child's workdir to
//   <deletedRoot>/<Date.now()>-<alias>/   (chmod 700)
// This module runs periodically and physically removes those dirs once
// they're older than RETENTION_MS. "彻底删, 不留残" per RFC §2.5:
//   - fs.rm({recursive:true, force:true}) — no soft delete, no .deleted marker
//   - parses age from the dir-name prefix (Date.now() at mv time) — no
//     mtime dependency (mtime can drift; the name is canonical)
//   - logs only the dir's top-level name (`<ts>-<alias>`), NEVER any
//     file inside (secret names mustn't leak into log lines)
//
// Cron driver: caller (cli.ts) starts an interval; this module is just
// a pure async function. Test-friendly — tests pass `now` override and
// drive sweep manually.

import { readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
export const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;   // once per day

export interface SweepResult {
  purged: Array<{ name: string; age_days: number }>;
  scanned: number;
  errors: number;
}

export interface SweepDeps {
  deletedRoot?: string;       // defaults to ~/.anet/deleted
  now?: number;               // tests can pin
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  // injectable fs ops (tests can spy):
  readdir?: (path: string) => string[];
  stat?: (path: string) => { isDirectory: () => boolean };
  rmDir?: (path: string) => void;
}

/** Run one sweep pass. Pure-async, idempotent — safe to call from a
 *  setInterval driver. Returns counts so callers can log / metric. */
export function sweepDeletedOnce(deps: SweepDeps = {}): SweepResult {
  const deletedRoot = deps.deletedRoot ?? join(homedir(), ".anet", "deleted");
  const now = deps.now ?? Date.now();
  const log = deps.log ?? (() => {});
  const warn = deps.warn ?? ((m) => console.warn(m));
  const readdir = deps.readdir ?? ((p) => readdirSync(p));
  const stat = deps.stat ?? ((p) => statSync(p));
  const rmDir = deps.rmDir ?? ((p) => rmSync(p, { recursive: true, force: true }));

  const out: SweepResult = { purged: [], scanned: 0, errors: 0 };
  let entries: string[];
  try {
    entries = readdir(deletedRoot);
  } catch {
    // Dir doesn't exist yet (no deletes ever) → nothing to do.
    return out;
  }

  for (const name of entries) {
    out.scanned++;
    // Name canonical = `<ts>-<alias>`. Anything else (.tmp, log files,
    // operator-renamed dirs) we skip — don't risk purging the wrong
    // thing.
    const m = name.match(/^(\d{10,})-/);
    if (!m) continue;

    const full = join(deletedRoot, name);
    let isDir = false;
    try { isDir = stat(full).isDirectory(); } catch { /* gone */ continue; }
    if (!isDir) continue;

    const ts = Number(m[1]);
    if (!Number.isFinite(ts) || ts <= 0) continue;
    const age = now - ts;
    if (age < RETENTION_MS) continue;

    try {
      rmDir(full);
      const ageDays = Math.floor(age / 86_400_000);
      out.purged.push({ name, age_days: ageDays });
      // D7 nit: log only the canonical top-level name (ts-alias) — never
      // any file inside the purged dir. The dir is gone by now anyway;
      // logging individual filenames would risk leaking secret keys.
      log(`[deleted-sweeper] purged ${name} (age ${ageDays}d)`);
    } catch (e: any) {
      out.errors++;
      warn(`[deleted-sweeper] failed to purge ${name}: ${e?.message || e}`);
    }
  }

  return out;
}

/** Start a daily interval driver. Returns the timer so callers can
 *  clearInterval on shutdown. Safe to start twice — caller manages
 *  lifecycle (only one daemon process exists per host). */
let _sweeperTimer: ReturnType<typeof setInterval> | null = null;
export function startDeletedSweeper(deps: SweepDeps = {}): NodeJS.Timeout | null {
  if (_sweeperTimer) return _sweeperTimer;
  // Run once at startup (catches accumulated 30d+ junk from a long
  // daemon down-period), then every SWEEP_INTERVAL_MS.
  try { sweepDeletedOnce(deps); } catch { /* swallowed — already best-effort */ }
  _sweeperTimer = setInterval(() => {
    try { sweepDeletedOnce(deps); } catch { /* see above */ }
  }, SWEEP_INTERVAL_MS);
  if (typeof _sweeperTimer.unref === "function") _sweeperTimer.unref();
  return _sweeperTimer;
}

export function _stopDeletedSweeperForTest(): void {
  if (_sweeperTimer) { clearInterval(_sweeperTimer); _sweeperTimer = null; }
}
