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
//   - sweepRetention(cfg): one-shot sweep across high-growth tables.
//     **Async** since #2614: deletes run in bounded chunks with an event-loop
//     yield between batches, so a big backlog no longer freezes the hub for
//     ~10 seconds once an hour.
//   - startRetentionSweeper(): wires a 1-hour setInterval, fires once
//     at startup with an immediate (non-blocking) sweep, and refuses to
//     start a second pass while one is still running.
//
// Defaults are conservative — long-tail debugging traces survive a
// week. Operators can override per env (COMMHUB_RETENTION_*_DAYS) for
// hot hubs.
//
// Run isolated tests against retention.test.ts:
//   COMMHUB_DB=/tmp/test-retention.db bun test src/retention.test.ts

import { db } from "./db.js";
import { sweepNodeRequestContent, type NodeRequestSweepResult } from "./node-request-retention.js";

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
  // node_rules_requests: file bytes purged by age / after read, rows deleted
  // after 30 days. Fixed policy (privacy, not disk) — no env opt-out.
  // #2614 —— 分批统计：总共跑了多少批 DELETE，哪张表因为 maxTableMs 被截断。
  batches: number;
  /** 整轮里单批最长耗时（毫秒）。生产上这条数字 = 「一次 sweep 最长阻塞多久」。 */
  maxBatchMs: number;
  /** 各阶段耗时（毫秒）：多张表 + vacuum。生产上「15 秒里谁花的」靠它，不靠猜。 */
  phases: Record<string, number>;
  truncated: string[];
  nodeRequests: NodeRequestSweepResult;
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

// #2614 —— 分批扫（chunked sweep）。
//
// 事故现场（2026-10-26 生产 `.161`）：每小时一次 `swept in 10588ms`，那 10 秒里
// 事件循环完全静默 —— `/health` 超时、在飞从 387 堆到 807、RSS 冲到 4.5 GB。
// 根因不是「删得多」，而是**一次 DELETE 把整批行放在一个语句里，中间不让出事件循环**。
//
// 修法（与 `.167` 的 terminal_events 回填同形）：
//   1. 每批只删 chunkRows 行，用 `DELETE … WHERE rowid IN (SELECT rowid FROM t WHERE <谓词> LIMIT n)`
//      —— 谓词有索引时这是索引范围扫描（O(n)）；没有索引时它退化成一次全扫，
//      所以「谓词必须有索引」是这条路径的前提（见下面的三条实测）；
//   2. 每批之间 `await` 一次 setTimeout(0)，把控制权交还事件循环；
//   3. 删的这段时间关掉 WAL 自动 checkpoint，本轮的 checkpoint 收敛到末尾那一次
//      TRUNCATE（否则 checkpoint 会落进任意一批，把 90ms 的批次顶到 4 秒）；
//   4. 单表最多跑 MAX_TABLE_MS，超了就停下并记日志（下一轮继续）。
//
// 三条实测（都在 1.09 GB 生产副本上）：
//   · 一次删完                                        3.1s / 单块 2686ms
//   · 分批 + rowid 游标（副本里谓词**没有**索引）      5.3s / 单块 258ms
//   · 分批 + rowid 游标（生产，谓词**有**索引）        → 单块 4716ms 🔴 打回
//     `ORDER BY rowid` 让优化器放弃 created_at 索引，为了凑够一批从 rowid=0 扫全表；
//     只删 266 行花了 4.7 秒（`.168` 上线第一拍的真实日志）。
//   · 分批 + 索引驱动 LIMIT（现状，生产副本）          1.8s / 单块 249ms
// ⇒ 教训：**副本的 schema 也必须与生产一致**，否则「按副本优化」会变成新的全表扫。
// 总耗时略增是有意的取舍：**可被打断优先于最快跑完**。
const DEFAULT_CHUNK_ROWS = 2000;
/** 每次 sweep 最多回收多少空闲页（≈4 KB/页）。见下面的 incremental_vacuum 注释。 */
const INCREMENTAL_VACUUM_PAGES = 200;
const MAX_TABLE_MS = 10 * 60 * 1000;

/** 启动后第一次 sweep 的延迟；默认 180 秒（见 startRetentionSweeper 里的实测）。 */
function readFirstSweepDelayMs(): number {
  const raw = process.env.COMMHUB_RETENTION_FIRST_DELAY_MS;
  if (raw === undefined || raw.trim() === "") return 180_000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 180_000;
}

function readChunkRows(): number {
  const raw = process.env.COMMHUB_RETENTION_CHUNK_ROWS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_CHUNK_ROWS;
  // 上限只是防手滑（把「分批」配成一次删完就没有意义了），
  // 真要大吞吐应该调小而不是调大 —— 这条盯的是最长阻塞，不是总时长。
  return Math.min(50_000, Math.floor(n));
}

/** 当前连接的 WAL 自动 checkpoint 页数；非 SQLite 或读不到 → null（不改）。 */
function readWalAutoCheckpoint(): number | null {
  if (db.dialect !== "sqlite") return null;
  try {
    const row = db.get<{ wal_autocheckpoint: number }>("PRAGMA wal_autocheckpoint");
    return typeof row?.wal_autocheckpoint === "number" ? row.wal_autocheckpoint : null;
  } catch {
    return null;
  }
}

function setWalAutoCheckpoint(pages: number): void {
  if (db.dialect !== "sqlite") return;
  try {
    db.exec(`PRAGMA wal_autocheckpoint = ${Math.max(0, Math.floor(pages))}`);
  } catch (e: any) {
    console.log(`[commhub retention] wal_autocheckpoint=${pages} failed: ${e?.message ?? e}`);
  }
}

function yieldToLoop(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export type TableSweepResult = {
  deleted: number;
  batches: number;
  /** 这张表这轮花了多久（毫秒）—— 生产上排查「15 秒里到底谁花的」靠它。 */
  ms: number;
  /** 单批最长耗时（毫秒）—— 生产上「一次 sweep 最长阻塞多久」就是这个数。 */
  maxBatchMs: number;
  /** 单表跑满 maxTableMs 被截断；剩余行下一轮继续（不吞掉、不假装完成）。 */
  truncated: boolean;
};

async function sweepTable(
  table: string,
  where: string,
  param: string,
  days: number,
  chunkRows: number,
): Promise<TableSweepResult> {
  // days < 0 → operator opt-out for this table; skip the DELETE.
  // days === 0 is a legitimate "sweep everything older than now"
  // (effectively a TRUNCATE); we honour it.
  if (days < 0) return { deleted: 0, batches: 0, maxBatchMs: 0, ms: 0, truncated: false };
  // PostgreSQL: 单条 DELETE + autovacuum 本来就按批回收，且报文里报的 10 秒停顿
  // 出在 SQLite 侧（`#2614` 的生产现场是 SQLite）。这里不引入 rowid（pg 没有），
  // 保持原样，避免在没观测到问题的方言上改语义。
  if (db.dialect !== "sqlite") {
    try {
      const res = db.run(`DELETE FROM ${table} WHERE ${where}`, [param]);
      return { deleted: res.changes ?? 0, batches: 1, maxBatchMs: 0, ms: 0, truncated: false };
    } catch (e: any) {
      console.log(`[commhub retention] sweep failed (${table}): ${e?.message ?? e}`);
      return { deleted: 0, batches: 0, maxBatchMs: 0, ms: 0, truncated: false };
    }
  }
  const startedMs = Date.now();
  const tTable0 = performance.now();
  let deleted = 0;
  let batches = 0;
  let maxBatchMs = 0;
  try {
    for (;;) {
      const batchT0 = performance.now();
      // 用**单调前进的 rowid 游标**取一批候选行，再按 rowid 删除。
      //
      // 为什么不是 `DELETE ... WHERE rowid IN (SELECT rowid FROM t WHERE <pred> LIMIT n)`：
      // `created_at < ?` 没有覆盖全表的索引，每批的子查询都退化成一次覆盖索引扫描
      // （EXPLAIN: `SCAN agent_telemetry USING COVERING INDEX idx_agent_telemetry_ip_time`）。
      // 于是「每批都从表头扫一遍」，总代价 = 批数 × 表大小 —— 在 1.09 GB 生产副本上
      // 实测：68k 行积压从一次删完的 2.7 秒劣化到 17 秒，单批仍能到 4.6 秒。
      // 加上 `rowid > 游标 ORDER BY rowid LIMIT n` 后计划变成
      // `SEARCH ... USING INTEGER PRIMARY KEY (rowid>?)`：每批只从游标往后读，
      // 整轮总代价 ≈ 一次全表扫描 + 删除本身。
      const rows = db.all<{ r: number }>(
        `SELECT rowid AS r FROM ${table} WHERE ${where} LIMIT ?2`,
        param,
        chunkRows,
      );
      if (rows.length === 0) return { deleted, batches, maxBatchMs, ms: Math.round(performance.now() - tTable0), truncated: false };
      const ids = rows.map((r) => r.r);
      const placeholders = ids.map((_, i) => `?${i + 1}`).join(",");
      const res = db.run(`DELETE FROM ${table} WHERE rowid IN (${placeholders})`, ids);
      deleted += res.changes ?? 0;
      batches += 1;
      maxBatchMs = Math.max(maxBatchMs, performance.now() - batchT0);
      // 这一批没取满 ⇒ 已经没有更多符合条件的行了，收工。
      if (rows.length < chunkRows) return { deleted, batches, maxBatchMs, ms: Math.round(performance.now() - tTable0), truncated: false };
      if (Date.now() - startedMs > MAX_TABLE_MS) {
        console.log(
          `[commhub retention] ${table}: stopped after ${batches} batches / ${deleted} rows ` +
            `(>${Math.round(MAX_TABLE_MS / 60000)}min); remaining rows continue next sweep`,
        );
        return { deleted, batches, maxBatchMs, ms: Math.round(performance.now() - tTable0), truncated: true };
      }
      // 让出事件循环：这是 #2614 的全部要点 —— 停顿的可感知单位是「单批」。
      await yieldToLoop();
    }
  } catch (e: any) {
    console.log(`[commhub retention] sweep failed (${table}): ${e?.message ?? e}`);
    return { deleted, batches, maxBatchMs, ms: Math.round(performance.now() - tTable0), truncated: false };
  }
}

export async function sweepRetention(cfg: RetentionConfig = readRetentionConfig()): Promise<SweepResult> {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const chunkRows = readChunkRows();

  // #2614 —— 分批删期间关掉 WAL 自动 checkpoint，把 checkpoint 收敛到本轮末尾那一次
  // 显式 wal_checkpoint(TRUNCATE)（本来就有的）。
  //
  // 为什么：自动 checkpoint 是**连接级、每 1000 页触发**的，它会落进任意一批里。
  // 在 1.09 GB 的生产副本上实测（68k 行积压、批大小 2000）：
  //   自动 checkpoint 开 → 批次中位数 301ms，**最慢一批 4365ms**（分批白做）
  //   自动 checkpoint 关 → 批次中位数  89ms，最慢一批  242ms
  // 也就是说「分批」必须配「自己决定何时 checkpoint，而不是让 SQLite 在你删到一半时决定」。
  const autoCheckpointBefore = readWalAutoCheckpoint();
  if (autoCheckpointBefore !== null) setWalAutoCheckpoint(0);
  let telemetry: TableSweepResult;
  let taskEvents: TableSweepResult;
  let inbox: TableSweepResult;
  let tasksSafeTerminal: TableSweepResult;
  let tasksRepliedChildSafe: TableSweepResult;
  let auditLog: TableSweepResult;
  try {

    telemetry = await sweepTable(
      "agent_telemetry",
      `created_at < datetime('now', ?1)`,
      `-${cfg.telemetryDays} days`,
      cfg.telemetryDays,
      chunkRows,
    );
    taskEvents = await sweepTable(
      "task_events",
      `created_at < datetime('now', ?1)`,
      `-${cfg.taskEventsDays} days`,
      cfg.taskEventsDays,
      chunkRows,
    );
    // Only sweep ACKED inbox rows — unacked may be in-flight delivery
    // for an agent that's offline but coming back. Acked rows have
    // served their purpose and exist only for debugging.
    inbox = await sweepTable(
      "inbox",
      `acked = 1 AND created_at < datetime('now', ?1)`,
      `-${cfg.ackedInboxDays} days`,
      cfg.ackedInboxDays,
      chunkRows,
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
    tasksSafeTerminal = await sweepTable(
      "tasks",
      `status IN ('completed', 'cancelled', 'failed', 'expired')
         AND COALESCE(completed_at, created_at) < datetime('now', ?1)`,
      `-${cfg.terminalTasksDays} days`,
      cfg.terminalTasksDays,
      chunkRows,
    );
    tasksRepliedChildSafe = await sweepTable(
      "tasks",
      `status = 'replied'
         AND COALESCE(completed_at, created_at) < datetime('now', ?1)
         AND NOT EXISTS (
           SELECT 1 FROM tasks AS child
           WHERE child.parent_task_id = tasks.task_id
         )`,
      `-${cfg.terminalTasksDays} days`,
      cfg.terminalTasksDays,
      chunkRows,
    );
    auditLog = await sweepTable(
      "audit_log",
      `created_at < datetime('now', ?1)`,
      `-${cfg.auditLogDays} days`,
      cfg.auditLogDays,
      chunkRows,
    );
  } finally {
    if (autoCheckpointBefore !== null) setWalAutoCheckpoint(autoCheckpointBefore);
  }
  const tasksDeleted = tasksSafeTerminal.deleted + tasksRepliedChildSafe.deleted;

  const nodeRequests = sweepNodeRequestContent();

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
  //   Both are SQLite PRAGMAs; on PostgreSQL autovacuum does this job and
  //   the two counters stay null (RFC-039 S3).
  let walCheckpointPagesMoved: number | null = null;
  let incrementalFreedPages: number | null = null;
  let errored = false;
  const sqliteVacuum = db.dialect === "sqlite";
  if (sqliteVacuum) {
    // wal_checkpoint(TRUNCATE) returns a row { busy, log, checkpointed }.
    // We expose `log` (page count moved into the main DB) for ops visibility.
    //
    // #2614 —— 重试 3 次：本轮刚跑完一批 `db.all` 时，同连接上可能还有未重置的
    // 读语句，`wal_checkpoint` 会直接报 `database table is locked`（SQLITE_LOCKED，
    // 不是 BUSY）。这是**瞬时**的：让出一次事件循环再试就好。别把它记成 errored
    // —— 那会让「本轮 vacuum 是否出错」这个字段说谎。
    let lastErr: any = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const checkpoint = db.get<{ busy: number; log: number; checkpointed: number }>(
          "PRAGMA wal_checkpoint(TRUNCATE)",
        );
        walCheckpointPagesMoved = checkpoint?.log ?? null;
        lastErr = null;
        break;
      } catch (e: any) {
        lastErr = e;
        await yieldToLoop();
      }
    }
    if (lastErr) {
      console.log(`[commhub retention] wal_checkpoint failed after 3 attempts: ${lastErr?.message ?? lastErr}`);
      errored = true;
    }
  }
  if (sqliteVacuum) try {
    // incremental_vacuum is a no-op on databases not created with
    // PRAGMA auto_vacuum = INCREMENTAL. For existing prod DBs that
    // weren't, the operator would have to run a full one-time VACUUM
    // to migrate — out of scope for the sweeper.
    const freelistBefore = db.get<{ freelist_count: number }>("PRAGMA freelist_count");
    // #2614 —— 必须带页数上限。`PRAGMA incremental_vacuum`（不带参数）会**一次回收
    // 全部空闲页**：生产 `.169` 上线时那一拍整轮 15.3s，其中大部分是这个语句
    // （它走 db.exec，不进 slow-sql 日志，所以第一眼看不见）。
    // 每小时回 200 页（≈800 KB）足够跟上增长，又不会变成一次长阻塞；剩下的下次继续。
    db.exec(`PRAGMA incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`);
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
      agent_telemetry: telemetry.deleted,
      task_events: taskEvents.deleted,
      inbox: inbox.deleted,
      tasks: tasksDeleted,
      audit_log: auditLog.deleted,
    },
    // #2614 —— 分批可见性：批次数与「被 maxTableMs 截断的表」
    batches:
      telemetry.batches + taskEvents.batches + inbox.batches +
      tasksSafeTerminal.batches + tasksRepliedChildSafe.batches + auditLog.batches,
    // 生产上「一次 sweep 最长阻塞多久」= 这个数字（#2614 的验收看它）
    phases: {
      telemetry: telemetry.ms,
      events: taskEvents.ms,
      inbox: inbox.ms,
      tasks: tasksSafeTerminal.ms + tasksRepliedChildSafe.ms,
      audit: auditLog.ms,
    },
    maxBatchMs: Math.round(Math.max(
      telemetry.maxBatchMs, taskEvents.maxBatchMs, inbox.maxBatchMs,
      tasksSafeTerminal.maxBatchMs, tasksRepliedChildSafe.maxBatchMs, auditLog.maxBatchMs,
    )),
    truncated: [
      ["agent_telemetry", telemetry],
      ["task_events", taskEvents],
      ["inbox", inbox],
      ["tasks(safe)", tasksSafeTerminal],
      ["tasks(replied)", tasksRepliedChildSafe],
      ["audit_log", auditLog],
    ].filter(([, r]) => (r as TableSweepResult).truncated).map(([n]) => n as string),
    nodeRequests,
    vacuum: { walCheckpointPagesMoved, incrementalFreedPages, errored },
  };
}

// Used by index.ts to wire the periodic sweeper. Returns the timer so
// callers can stop it in tests / shutdown.
export function startRetentionSweeper(
  intervalMs = 60 * 60 * 1000, // 1 hour
  cfg?: RetentionConfig,
  firstDelayMs = readFirstSweepDelayMs(),
): ReturnType<typeof setInterval> {
  // 防重入：一轮 sweep 现在会跨多个 tick（每批之间让出事件循环）。若上一轮还没
  // 跑完就再来一轮，两轮会同时删同一批行 —— 白做功，还会把写锁争用放大。
  let running = false;
  const sweep = async () => {
    if (running) {
      console.log("[commhub retention] previous sweep still running — skipping this tick");
      return;
    }
    running = true;
    try {
      const r = await sweepRetention(cfg);
      const totalDeletes =
        r.deletes.agent_telemetry +
        r.deletes.task_events +
        r.deletes.inbox +
        r.deletes.tasks +
        r.deletes.audit_log;
      const nr = r.nodeRequests;
      if (totalDeletes > 0 || nr.purged > 0 || nr.deleted > 0 || nr.timedOut > 0 || r.vacuum.errored) {
        console.log(
          `[commhub retention] swept in ${r.durationMs}ms (${r.batches} batches, max ${r.maxBatchMs}ms) — ` +
            `phases ${Object.entries(r.phases).map(([k, v]) => `${k}=${v}ms`).join(" ")} · ` +
            `telemetry=${r.deletes.agent_telemetry} events=${r.deletes.task_events} ` +
            `inbox=${r.deletes.inbox} tasks=${r.deletes.tasks} audit=${r.deletes.audit_log} ` +
            `nodeReqPurged=${nr.purged} nodeReqDeleted=${nr.deleted} nodeReqTimedOut=${nr.timedOut} ` +
            `walPages=${r.vacuum.walCheckpointPagesMoved} freedPages=${r.vacuum.incrementalFreedPages}` +
            (r.truncated.length ? ` truncated=${r.truncated.join(",")}` : ""),
        );
      }
    } catch (e: any) {
      console.log(`[commhub retention] sweep top-level failed: ${e?.message ?? e}`);
    } finally {
      running = false;
    }
  };
  // Fire once after startup so a long-running hub eventually catches up.
  //
  // #2614（第二轮）—— 不再 setImmediate。2026-10-27 18:11 的启动实测：
  // ``` 
  // [commhub stall] loop idle ~14085ms (served 614)      ← 重连风暴 + 启动工作
  // [commhub retention] swept in 15693ms (max 957ms) — telemetry=3320 行/13928ms
  // ```
  // 同一批删除在稳态是 0.24ms/行，在启动那一分钟是 4.2ms/行（慢 17 倍）——
  // 不是删除变慢了，是它在和重连风暴抢 CPU/WAL。而这一分钟的阻塞最容易被误记成
  // “retention 又卡了”。默认延后 180 秒（可用 COMMHUB_RETENTION_FIRST_DELAY_MS 覆盖，0=立即）。
  //
  // 为什么是 180 而不是 60（.173 上线后实测修正）：
  // ``` 
  // 18:55:24 boot
  // 18:55:38 stall 20.6s (served 812)   ← 重连风暴
  // 18:56:24 retention（+60s） swept 3894ms, max 1238ms, telemetry=2964 行/2935ms = 0.99ms/行
  // 18:56:26 stall 2.7s · 18:57:28 stall 3.4s · 18:57:31 stall 2.6s   ← 风暴 2 分钟还没排空
  // ```
  // 稳态同一批删除是 0.24ms/行 ⇒ 60 秒时风暴仍在，max 单批被推到 1.2 秒（越过 1 秒慢 SQL 阈值）。
  if (firstDelayMs > 0) setTimeout(() => { void sweep(); }, firstDelayMs);
  else setImmediate(() => { void sweep(); });
  return setInterval(() => { void sweep(); }, intervalMs);
}
