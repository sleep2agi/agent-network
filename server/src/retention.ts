// Round-2/4 review ② — retention sweep + incremental VACUUM.
//
// Background maintenance for the commhub database. Multi-tenant
// public-facing hubs (e.g. <hub-domain>) write to high-frequency tables
// on every heartbeat (agent_telemetry, task_events, completions) — left
// unswept these grow unbounded, slow down indexed scans, and bloat the
// on-disk footprint. SQLite never reclaims freed pages without VACUUM,
// so a row delete by itself doesn't shrink the file.
//
// This module exposes:
//   - sweepRetention(cfg): one-shot sweep across high-growth tables
//   - startRetentionSweeper(): wires a 1-hour setInterval, fires once
//     at startup with an immediate (non-blocking) sweep
//
// Defaults are conservative — long-tail debugging traces survive a
// week. Operators can override per env (COMMHUB_RETENTION_*_DAYS) for
// hot hubs.
//
// Run isolated tests against retention.test.ts:
//   COMMHUB_DB=/tmp/test-retention.db bun test src/retention.test.ts

import { db } from "./db.js";

export type RetentionConfig = {
  // High-frequency telemetry; default = 7 days.
  // Heartbeat is ~30s → 50 agents × 86400 s/day ÷ 30 s = 144000 rows/day.
  // At 7d that's ~1M rows. Indexed scans stay fast; raw disk = a few MB.
  telemetryDays: number;
  // Task state-change audit; default = 30 days.
  // One row per status transition. Useful for incident forensics.
  taskEventsDays: number;
  // Acked inbox; default = 7 days post-ack.
  // Once acked the row is no longer hot — keep a week for debugging.
  // Unacked rows are NEVER swept (could be in-flight delivery).
  ackedInboxDays: number;
  // Completed/cancelled/failed tasks; default = 30 days.
  // Active tasks (created/delivered/acked/running/replied less than
  // 30 days old) are NEVER swept.
  terminalTasksDays: number;
  // Audit log; default = 90 days.
  // Longer retention because audit_log is a security artifact.
  auditLogDays: number;
};

export type SweepResult = {
  startedAt: string;
  durationMs: number;
  deletes: {
    agent_telemetry: number;
    task_events: number;
    inbox: number;
    tasks: number;
    audit_log: number;
  };
  vacuum: {
    walCheckpointPagesMoved: number | null;
    incrementalFreedPages: number | null;
    errored: boolean;
  };
};

const DEFAULTS: RetentionConfig = {
  telemetryDays: 7,
  taskEventsDays: 30,
  ackedInboxDays: 7,
  terminalTasksDays: 30,
  auditLogDays: 90,
};

function readEnvDays(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  // Negative = disable that table's sweep entirely (operator opt-out).
  // NaN / non-finite falls back to default — guard against fat-fingered env.
  if (!Number.isFinite(n)) return fallback;
  return n;
}

export function readRetentionConfig(): RetentionConfig {
  return {
    telemetryDays: readEnvDays("COMMHUB_RETENTION_TELEMETRY_DAYS", DEFAULTS.telemetryDays),
    taskEventsDays: readEnvDays("COMMHUB_RETENTION_TASK_EVENTS_DAYS", DEFAULTS.taskEventsDays),
    ackedInboxDays: readEnvDays("COMMHUB_RETENTION_INBOX_ACKED_DAYS", DEFAULTS.ackedInboxDays),
    terminalTasksDays: readEnvDays("COMMHUB_RETENTION_TASKS_TERMINAL_DAYS", DEFAULTS.terminalTasksDays),
    auditLogDays: readEnvDays("COMMHUB_RETENTION_AUDIT_DAYS", DEFAULTS.auditLogDays),
  };
}

function sweepOne(
  sql: string,
  params: (string | number)[],
  days: number,
): number {
  // days < 0 → operator opt-out for this table; skip the DELETE.
  // days === 0 is a legitimate "sweep everything older than now"
  // (effectively a TRUNCATE); we honour it.
  if (days < 0) return 0;
  try {
    const res = db.run(sql, params);
    return res.changes ?? 0;
  } catch (e: any) {
    console.log(`[commhub retention] sweep failed: ${e?.message ?? e}`);
    return 0;
  }
}

export function sweepRetention(cfg: RetentionConfig = readRetentionConfig()): SweepResult {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const telemetry = sweepOne(
    `DELETE FROM agent_telemetry WHERE created_at < datetime('now', ?1)`,
    [`-${cfg.telemetryDays} days`],
    cfg.telemetryDays,
  );
  const taskEvents = sweepOne(
    `DELETE FROM task_events WHERE created_at < datetime('now', ?1)`,
    [`-${cfg.taskEventsDays} days`],
    cfg.taskEventsDays,
  );
  // Only sweep ACKED inbox rows — unacked may be in-flight delivery
  // for an agent that's offline but coming back. Acked rows have
  // served their purpose and exist only for debugging.
  const inbox = sweepOne(
    `DELETE FROM inbox WHERE acked = 1 AND created_at < datetime('now', ?1)`,
    [`-${cfg.ackedInboxDays} days`],
    cfg.ackedInboxDays,
  );
  // Terminal-task sweep — split into two DELETEs:
  //
  // (a) "safe terminals": cancelled / failed / expired / (theoretical)
  //     completed have no chain-ancestor risk and are safe to reap
  //     unconditionally past the horizon. NOTE: as of this writing
  //     'completed' is dead code — no code path sets it (every reply
  //     uses 'replied'/'failed'/'cancelled' via send_reply or
  //     chainReplyToParent). Kept in the IN-list as a forward guard:
  //     if someone introduces a 'completed' write later, the sweep
  //     picks it up without code changes.
  //
  // (b) "replied" — was excluded entirely in the original PR, which
  //     missed the goal: every fulfilled task lives at 'replied'
  //     status, so the tasks table's MAIN GROWTH SOURCE would never
  //     be reclaimed. Reviewer caught this. Fix: child-ref-aware
  //     delete — reap an old replied row ONLY IF no other task
  //     references it as parent_task_id. A row with no children is
  //     not a chain ancestor and is safe to drop.
  //
  // **Time field** (both DELETEs): use COALESCE(completed_at, created_at).
  // Terminal status means the server set `completed_at` at the
  // reply/fail/cancel moment. Sweeping on `created_at` alone would
  // reap a task created 60d ago but completed today the instant it
  // entered terminal state — zero post-terminal retention. The
  // COALESCE falls back to created_at for legacy rows that pre-date
  // the completed_at column (back-compat).
  const tasksSafeTerminal = sweepOne(
    `DELETE FROM tasks
     WHERE status IN ('completed', 'cancelled', 'failed', 'expired')
       AND COALESCE(completed_at, created_at) < datetime('now', ?1)`,
    [`-${cfg.terminalTasksDays} days`],
    cfg.terminalTasksDays,
  );
  const tasksRepliedChildSafe = sweepOne(
    `DELETE FROM tasks
     WHERE status = 'replied'
       AND COALESCE(completed_at, created_at) < datetime('now', ?1)
       AND NOT EXISTS (
         SELECT 1 FROM tasks AS child
         WHERE child.parent_task_id = tasks.task_id
       )`,
    [`-${cfg.terminalTasksDays} days`],
    cfg.terminalTasksDays,
  );
  const tasks = tasksSafeTerminal + tasksRepliedChildSafe;
  const auditLog = sweepOne(
    `DELETE FROM audit_log WHERE created_at < datetime('now', ?1)`,
    [`-${cfg.auditLogDays} days`],
    cfg.auditLogDays,
  );

  // VACUUM:
  //   - wal_checkpoint(TRUNCATE): trims the WAL file. Works on every
  //     SQLite DB regardless of auto_vacuum setting. Useful after
  //     big DELETEs so the WAL doesn't stay bloated until the next
  //     natural checkpoint.
  //   - incremental_vacuum: ONLY reclaims main-DB pages on databases
  //     created with `PRAGMA auto_vacuum = INCREMENTAL`. On legacy
  //     DBs (the default mode 0) this is a no-op and the main file
  //     does NOT shrink — freed pages stay in the freelist for
  //     future inserts. Operators who want disk reclamation on old
  //     DBs must run a one-time blocking `VACUUM` themselves (out of
  //     scope for the sweeper, which deliberately stays non-
  //     blocking).
  let walCheckpointPagesMoved: number | null = null;
  let incrementalFreedPages: number | null = null;
  let errored = false;
  try {
    // wal_checkpoint(TRUNCATE) returns a row { busy, log, checkpointed }.
    // We expose `log` (page count moved into the main DB) for ops visibility.
    const checkpoint = db.get<{ busy: number; log: number; checkpointed: number }>(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    );
    walCheckpointPagesMoved = checkpoint?.log ?? null;
  } catch (e: any) {
    console.log(`[commhub retention] wal_checkpoint failed: ${e?.message ?? e}`);
    errored = true;
  }
  try {
    // incremental_vacuum is a no-op on databases not created with
    // PRAGMA auto_vacuum = INCREMENTAL. For existing prod DBs that
    // weren't, the operator would have to run a full one-time VACUUM
    // to migrate — out of scope for the sweeper.
    const freelistBefore = db.get<{ freelist_count: number }>("PRAGMA freelist_count");
    db.exec("PRAGMA incremental_vacuum");
    const freelistAfter = db.get<{ freelist_count: number }>("PRAGMA freelist_count");
    incrementalFreedPages =
      (freelistBefore?.freelist_count ?? 0) - (freelistAfter?.freelist_count ?? 0);
  } catch (e: any) {
    console.log(`[commhub retention] incremental_vacuum failed: ${e?.message ?? e}`);
    errored = true;
  }

  return {
    startedAt,
    durationMs: Date.now() - t0,
    deletes: {
      agent_telemetry: telemetry,
      task_events: taskEvents,
      inbox,
      tasks,
      audit_log: auditLog,
    },
    vacuum: { walCheckpointPagesMoved, incrementalFreedPages, errored },
  };
}

// Used by index.ts to wire the periodic sweeper. Returns the timer so
// callers can stop it in tests / shutdown.
export function startRetentionSweeper(
  intervalMs = 60 * 60 * 1000, // 1 hour
  cfg?: RetentionConfig,
): ReturnType<typeof setInterval> {
  const sweep = () => {
    try {
      const r = sweepRetention(cfg);
      const totalDeletes =
        r.deletes.agent_telemetry +
        r.deletes.task_events +
        r.deletes.inbox +
        r.deletes.tasks +
        r.deletes.audit_log;
      if (totalDeletes > 0 || r.vacuum.errored) {
        console.log(
          `[commhub retention] swept in ${r.durationMs}ms — ` +
            `telemetry=${r.deletes.agent_telemetry} events=${r.deletes.task_events} ` +
            `inbox=${r.deletes.inbox} tasks=${r.deletes.tasks} audit=${r.deletes.audit_log} ` +
            `walPages=${r.vacuum.walCheckpointPagesMoved} freedPages=${r.vacuum.incrementalFreedPages}`,
        );
      }
    } catch (e: any) {
      console.log(`[commhub retention] sweep top-level failed: ${e?.message ?? e}`);
    }
  };
  // Fire once on startup so a long-running hub eventually catches up
  // even if it's restarted just after the previous sweep. setImmediate
  // (vs synchronous) keeps server startup from blocking on the sweep.
  setImmediate(sweep);
  return setInterval(sweep, intervalMs);
}
