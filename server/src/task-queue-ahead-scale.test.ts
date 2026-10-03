// #500 follow-up to #2325 —— queue_depth at production scale. SQLite only (the plan assertions are SQLite's
// EXPLAIN QUERY PLAN; the result-equality side runs on PostgreSQL in task-queue-ahead-http.test.ts via test2123).
//
// The .100 release drill on a read-only copy of a production-shaped DB (306 sessions, 57k tasks, ~31k stuck in
// `acked` for weeks, ~900 `running`, only ~1.9k created in the last 24 h) measured full /api/status at p50 66–77 ms
// against 8–9 ms on .99: the queue_depth GROUP BY went through idx_tasks_status and walked every open-status row
// ever written to keep a 24 h window. This file seeds that shape and pins:
//   1. the plans: the whole-table queue_depth query and the per-send open-task count never use idx_tasks_status;
//      the whole-table one is driven by the covering idx_tasks_created_queue (no task-row lookups), the alias list
//      and the per-send count by idx_tasks_to_created;
//   2. the cost, relative only (no absolute ms, so a slow runner can't fail it): the queue_depth statement is at most
//      half the #2325 statement measured on the same DB in the same loop, and a full /api/status read (cache
//      bypassed) with queue_depth is at most 50 % slower than the same read with it switched off (= the pre-#2325
//      read), alternated request by request on the same server;
//   3. the counts are still right at that scale (stale `acked` rows are outside the 24 h window).
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/task-queue-ahead-scale.test.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PG = !!process.env.COMMHUB_TEST_PG_URL;
const DIR = mkdtempSync(join(tmpdir(), "anet-queue-scale-"));
if (!PG) process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";

const NODES = 306;
const STUCK_ACKED = 31_000;   // older than 24 h, never terminal
const STUCK_RUNNING = 900;    // older than 24 h
const OLD_DONE = 23_400;      // replied / failed / expired, older than 24 h
const RECENT = 1_900;         // created in the last 24 h
const OPEN_EVERY = 30;        // 3 in every OPEN_EVERY recent tasks are still open (~190 of 1.9k; see the cost test)
const HOT = "scale-node-7";   // most stuck rows land on this one (the per-send plan must not care)
const N = 25;
/** The #2325 statement (bare columns): the in-test baseline the fixed query is measured against. */
const SQL_2325 = `SELECT network_id, to_name, COUNT(*) AS n FROM tasks
  WHERE status IN ('created', 'delivered', 'acked', 'running') AND created_at >= datetime('now', '-86400 seconds')
  GROUP BY network_id, to_name`;

let db: any;
let hub: any = null;
let BASE = "", NET = "", token = "";
let mod: any;
let expectedOpen = new Map<string, number>();
let seedMs = 0, regMs = 0;

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const plan = (sql: string, params: any[]) => (db.all("EXPLAIN QUERY PLAN " + sql, ...params) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");

beforeAll(async () => {
  if (PG) return;
  ({ db } = await import("./db.js"));
  mod = await import("./task-queue-ahead.js");
  const { register } = await import("./auth.js");
  const seedStart = performance.now();
  const u = register(`scale_${Date.now()}`, "QueueScale123!x");
  token = u.token!; NET = u.network_id!;
  // Seed with a handful of set-based INSERT … SELECT over a recursive CTE (no per-row JS round trips): the whole
  // 57k-row seed is ~0.2 s, so the file stays far inside test638's per-file budget even under strace and with two
  // aggregates running at once. Rows are deterministic (functions of the row number), so the expected counts below
  // are computed from the same formulas, independently of the code under test.
  const SEQ = `WITH RECURSIVE seq(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i + 1 < ?1)`;
  const OLD_AGE = `(90000 + (i * 7919) % 2592000)`; // 25 h … 25 h + 30 d, in seconds
  const insertTasks = (prefix: string, count: number, toExpr: string, statusExpr: string, ageExpr: string, doneExpr: string) => db.run(
    `${SEQ}
     INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, created_at, delivered_at, completed_at, expires_at, network_id)
     SELECT '${prefix}-' || i, 'scale-sender', ${toExpr}, 'normal', ${statusExpr}, 'c',
            datetime('now', '-' || ${ageExpr} || ' seconds'), datetime('now', '-' || ${ageExpr} || ' seconds'),
            CASE WHEN ${doneExpr} THEN datetime('now', '-' || (${ageExpr} - 120) || ' seconds') END,
            datetime('now', '-' || (${ageExpr} - 3600) || ' seconds'), ?2
       FROM seq`,
    [count, NET],
  );
  const NODE_OF = (expr: string) => `'scale-node-' || ((${expr}) % ${NODES})`;
  // Throwaway DB only: no fsync, and a page cache big enough that the seed transaction never spills to the WAL
  // mid-way (test638 runs this file under `strace -f`, where every write syscall is expensive).
  regMs = performance.now() - seedStart;
  db.exec("PRAGMA synchronous = OFF; PRAGMA cache_size = -131072;");
  db.transaction(() => {
    db.run(`${SEQ}
      INSERT INTO sessions (resume_id, alias, status, agent, network_id, node_id, updated_at, last_seen_at, task)
      SELECT 'sdk-scale-' || i, 'scale-node-' || i, 'idle', 'agent-node:codex', ?2, 'n_scale_' || i, datetime('now'), datetime('now'), 'x' FROM seq`,
      [NODES, NET]);
    // Two thirds of the stuck rows on one node, the rest spread out.
    insertTasks("acked", STUCK_ACKED, `CASE WHEN i % 3 = 0 THEN ${NODE_OF("i")} ELSE '${HOT}' END`, `'acked'`, OLD_AGE, "0");
    insertTasks("running", STUCK_RUNNING, NODE_OF("i"), `'running'`, OLD_AGE, "0");
    insertTasks("done", OLD_DONE, NODE_OF("i"), `CASE i % 5 WHEN 3 THEN 'failed' WHEN 4 THEN 'expired' ELSE 'replied' END`, OLD_AGE, "1");
    // Last 24 h: i % OPEN_EVERY = 3 / 4 / 5 → delivered / running / acked (open), else failed (i % 7 = 6) or replied;
    // age 0 … 23 h.
    insertTasks("recent", RECENT, NODE_OF("i * 13"),
      `CASE i % ${OPEN_EVERY} WHEN 3 THEN 'delivered' WHEN 4 THEN 'running' WHEN 5 THEN 'acked' ELSE CASE i % 7 WHEN 6 THEN 'failed' ELSE 'replied' END END`,
      `((i * 37) % 82800)`, `i % ${OPEN_EVERY} NOT IN (3, 4, 5)`);
  });
  for (let i = 0; i < RECENT; i++) {
    if (![3, 4, 5].includes(i % OPEN_EVERY)) continue;
    const to = `scale-node-${(i * 13) % NODES}`;
    expectedOpen.set(to, (expectedOpen.get(to) ?? 0) + 1);
  }
  seedMs = performance.now() - seedStart;
  const srv: any = await import("./server.js");
  hub = srv.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 120_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe.skipIf(PG)("#500 queue_depth at production scale (57k tasks, 31k stuck acked)", () => {
  test("plans: never idx_tasks_status; whole table via covering idx_tasks_created_queue, alias list and per-send via idx_tasks_to_created", () => {
    const total = Number(db.get("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1", NET).n);
    expect(total).toBe(STUCK_ACKED + STUCK_RUNNING + OLD_DONE + RECENT);
    const stale = Number(db.get("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1 AND status IN ('acked','running') AND created_at < datetime('now', '-86400 seconds')", NET).n);
    expect(stale).toBe(STUCK_ACKED + STUCK_RUNNING);
    console.log(`[seed] ${total} tasks in ${seedMs.toFixed(0)} ms (register ${regMs.toFixed(0)} ms)`);
    // Positive control: the shape is one where the #2325 statement really does go through idx_tasks_status.
    expect(plan(SQL_2325, [])).toContain("idx_tasks_status");

    const whole = mod.queueDepthQuery();
    const wholePlan = plan(whole.sql, whole.params);
    console.log(`[plan] queue_depth whole table: ${wholePlan}`);
    expect(wholePlan).not.toContain("idx_tasks_status");
    expect(wholePlan).toContain("COVERING INDEX idx_tasks_created_queue");

    // > QUEUE_DEPTH_ALIAS_LIST_MAX aliases → the whole-table form too.
    const many = mod.queueDepthQuery(Array.from({ length: NODES }, (_, i) => `scale-node-${i}`));
    expect(many.sql).toBe(whole.sql);

    const few = mod.queueDepthQuery([HOT, "scale-node-8"]);
    const fewPlan = plan(few.sql, few.params);
    console.log(`[plan] queue_depth alias list: ${fewPlan}`);
    expect(fewPlan).not.toContain("idx_tasks_status");
    expect(fewPlan).toContain("idx_tasks_to_created");

    for (const net of [NET, null]) {
      const send = mod.openTaskCountsQuery(HOT, net);
      const sendPlan = plan(send.sql, send.params);
      console.log(`[plan] per-send open count (net=${net ? "set" : "none"}): ${sendPlan}`);
      expect(sendPlan).not.toContain("idx_tasks_status");
      expect(sendPlan).toContain("idx_tasks_to_created");
    }
  });

  test("counts stay right at scale: stale acked rows are outside the 24 h window", async () => {
    const depth: Map<string, number> = mod.queueDepthByNode();
    for (const [alias, n] of expectedOpen) expect(depth.get(mod.queueDepthKey(NET, alias))).toBe(n);
    expect(depth.get(mod.queueDepthKey(NET, HOT)) ?? 0).toBe(expectedOpen.get(HOT) ?? 0);
    const r = await fetch(`${BASE}/api/status?network_id=${NET}&alias=${HOT}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json() as any;
    expect(body.sessions[0].queue_depth).toBe(expectedOpen.get(HOT) ?? 0);
    expect(mod.openTaskCounts(HOT, NET).open).toBe(expectedOpen.get(HOT) ?? 0);
    // And a node that does have open tasks in the window (HOT's open rows are all > 24 h old).
    expect(expectedOpen.size).toBeGreaterThan(100);
    const [busy, busyN] = [...expectedOpen].sort((a, b) => b[1] - a[1])[0];
    expect(busyN).toBeGreaterThan(1);
    const rb = await fetch(`${BASE}/api/status?network_id=${NET}&alias=${busy}`, { headers: { Authorization: `Bearer ${token}` } });
    expect(((await rb.json()) as any).sessions[0].queue_depth).toBe(busyN);
    expect(mod.openTaskCounts(busy, NET).open).toBe(busyN);
  });

  test("cost (relative, robust on slow runners): ≤ half the #2325 statement on the same DB, and ≤ +50% on a full /api/status read vs the same read without queue_depth", async () => {
    // Interleave the two statements so a slow / noisy runner slows both alike.
    const fixed: number[] = [], old: number[] = [];
    for (let i = 0; i < N + 3; i++) {
      let s0 = performance.now(); mod.queueDepthByNode(); const a = performance.now() - s0;
      s0 = performance.now(); db.all(SQL_2325); const b = performance.now() - s0;
      if (i >= 3) { fixed.push(a); old.push(b); }
    }
    // Full /api/status, cache bypassed, A/B request by request: queue_depth on vs off (off = the pre-#2325 read).
    // Alternating (and flipping the order every iteration) keeps both arms in the same time window — the first
    // version of this budget timed the statement and the read in separate loops and compared them, which a busy
    // runner (test638 runs two aggregates at once) skews: CI saw 2.10 ms vs a 5.25 ms read and failed.
    const cache = await import("./status-read-cache.js");
    cache.__setStatusCacheBypassForTest(true);
    const on: number[] = [], off: number[] = [];
    const readOnce = async (depthOn: boolean) => {
      mod.__setQueueDepthOffForTest(!depthOn);
      const s0 = performance.now();
      await (await fetch(`${BASE}/api/status?network_id=${NET}`, { headers: { Authorization: `Bearer ${token}` } })).text();
      return performance.now() - s0;
    };
    try {
      for (let i = 0; i < 2 * N + 3; i++) {
        const first = i % 2 === 0;
        const a = await readOnce(first), b = await readOnce(!first);
        if (i >= 3) { (first ? on : off).push(a); (first ? off : on).push(b); }
      }
    } finally {
      mod.__setQueueDepthOffForTest(false);
      cache.__setStatusCacheBypassForTest(false);
    }
    const qP50 = pct(fixed, 0.5), oldP50 = pct(old, 0.5), onP50 = pct(on, 0.5), offP50 = pct(off, 0.5);
    console.log(`[perf] queue_depth p50=${qP50.toFixed(2)}ms vs #2325 statement p50=${oldP50.toFixed(2)}ms; full /api/status (bypass) p50 with=${onP50.toFixed(2)}ms without=${offP50.toFixed(2)}ms (+${(100 * (onP50 - offP50) / offP50).toFixed(0)}%) p90 with=${pct(on, 0.9).toFixed(2)}ms`);
    // Measured locally (this fixture, covering index): ≈ 0.15× (1.0 vs 6.5 ms); on the production copy 0.3 vs 55 ms.
    expect(qP50).toBeLessThanOrEqual(0.5 * oldP50);
    // Why the budget is "vs the same read without queue_depth", and what it was measured at (2026-10-04):
    //   production copy (VACUUM INTO of the live DB: 306 sessions, 57k tasks, 64 open in the last 24 h on 4 nodes),
    //   full /api/status p50, cache bypassed, 3 runs each —
    //     pre-#2325 10.5–11.3 ms · #2325 68–71 ms · first fix (idx_tasks_created + row lookups) 16.1–17.1 ms (+50 %,
    //     statement 3.1 ms) · covering idx_tasks_created_queue 11.5–12.2 ms; this A/B on that copy: +7 / +8 / +9 %.
    //   this fixture: +17–31 %. It is harsher than production: ~190 open tasks in the window spread over ~150 nodes
    //   (3× production's open count, ~38× its groups) and one-word session rows that make the rest of the read cheap.
    //   With the original 1-in-7 open share (813 open) it measured +55–62 % even with the covering index — the
    //   GROUP BY over 300 groups, not the index. CI's 67 % (before the covering index) is consistent with that plus the separate-loop skew above.
    expect(onP50 - offP50).toBeLessThanOrEqual(0.5 * offP50);
  }, 60_000);
});
