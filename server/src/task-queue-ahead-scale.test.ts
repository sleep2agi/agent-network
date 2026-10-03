// #500 follow-up to #2325 —— queue_depth at production scale. SQLite only (the plan assertions are SQLite's
// EXPLAIN QUERY PLAN; the result-equality side runs on PostgreSQL in task-queue-ahead-http.test.ts via test2123).
//
// The .100 release drill on a read-only copy of a production-shaped DB (306 sessions, 57k tasks, ~31k stuck in
// `acked` for weeks, ~900 `running`, only ~1.9k created in the last 24 h) measured full /api/status at p50 66–77 ms
// against 8–9 ms on .99: the queue_depth GROUP BY went through idx_tasks_status and walked every open-status row
// ever written to keep a 24 h window. This file seeds that shape and pins:
//   1. the plans: the whole-table queue_depth query and the per-send open-task count never use idx_tasks_status;
//      the whole-table one is driven by idx_tasks_created, the alias list and the per-send count by
//      idx_tasks_to_created;
//   2. the cost, relative only (no absolute ms, so a slow runner can't fail it): the queue_depth statement is at most
//      half the #2325 statement measured on the same DB in the same loop, and it adds at most 50 % to the rest of a
//      full /api/status read (cache bypassed);
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
let seedMs = 0;

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
  db.transaction(() => {
    db.run(`${SEQ}
      INSERT INTO sessions (resume_id, alias, status, agent, network_id, node_id, updated_at, last_seen_at, task)
      SELECT 'sdk-scale-' || i, 'scale-node-' || i, 'idle', 'agent-node:codex', ?2, 'n_scale_' || i, datetime('now'), datetime('now'), 'x' FROM seq`,
      [NODES, NET]);
    // Two thirds of the stuck rows on one node, the rest spread out.
    insertTasks("acked", STUCK_ACKED, `CASE WHEN i % 3 = 0 THEN ${NODE_OF("i")} ELSE '${HOT}' END`, `'acked'`, OLD_AGE, "0");
    insertTasks("running", STUCK_RUNNING, NODE_OF("i"), `'running'`, OLD_AGE, "0");
    insertTasks("done", OLD_DONE, NODE_OF("i"), `CASE i % 5 WHEN 3 THEN 'failed' WHEN 4 THEN 'expired' ELSE 'replied' END`, OLD_AGE, "1");
    // Last 24 h: status by i % 7 (delivered / running / acked open), age 0 … 23 h.
    insertTasks("recent", RECENT, NODE_OF("i * 13"),
      `CASE i % 7 WHEN 3 THEN 'delivered' WHEN 4 THEN 'running' WHEN 5 THEN 'acked' WHEN 6 THEN 'failed' ELSE 'replied' END`,
      `((i * 37) % 82800)`, "i % 7 NOT IN (3, 4, 5)");
  });
  for (let i = 0; i < RECENT; i++) {
    if (![3, 4, 5].includes(i % 7)) continue;
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
  test("plans: never idx_tasks_status; whole table via idx_tasks_created, alias list and per-send via idx_tasks_to_created", () => {
    const total = Number(db.get("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1", NET).n);
    expect(total).toBe(STUCK_ACKED + STUCK_RUNNING + OLD_DONE + RECENT);
    const stale = Number(db.get("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1 AND status IN ('acked','running') AND created_at < datetime('now', '-86400 seconds')", NET).n);
    expect(stale).toBe(STUCK_ACKED + STUCK_RUNNING);
    console.log(`[seed] ${total} tasks in ${seedMs.toFixed(0)} ms`);
    // Positive control: the shape is one where the #2325 statement really does go through idx_tasks_status.
    expect(plan(SQL_2325, [])).toContain("idx_tasks_status");

    const whole = mod.queueDepthQuery();
    const wholePlan = plan(whole.sql, whole.params);
    console.log(`[plan] queue_depth whole table: ${wholePlan}`);
    expect(wholePlan).not.toContain("idx_tasks_status");
    expect(wholePlan).toContain("idx_tasks_created");

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
  });

  test("cost (relative, robust on slow runners): ≤ half the #2325 statement on the same DB, and ≤ +50% on a full /api/status read", async () => {
    // Interleave the two statements so a slow / noisy runner slows both alike.
    const fixed: number[] = [], old: number[] = [];
    for (let i = 0; i < N + 3; i++) {
      let s0 = performance.now(); mod.queueDepthByNode(); const a = performance.now() - s0;
      s0 = performance.now(); db.all(SQL_2325); const b = performance.now() - s0;
      if (i >= 3) { fixed.push(a); old.push(b); }
    }
    const cache = await import("./status-read-cache.js");
    cache.__setStatusCacheBypassForTest(true);
    const read: number[] = [];
    try {
      for (let i = 0; i < N + 3; i++) {
        const s0 = performance.now();
        await (await fetch(`${BASE}/api/status?network_id=${NET}`, { headers: { Authorization: `Bearer ${token}` } })).text();
        if (i >= 3) read.push(performance.now() - s0);
      }
    } finally {
      cache.__setStatusCacheBypassForTest(false);
    }
    const qP50 = pct(fixed, 0.5), oldP50 = pct(old, 0.5), readP50 = pct(read, 0.5);
    console.log(`[perf] queue_depth p50=${qP50.toFixed(2)}ms vs #2325 statement p50=${oldP50.toFixed(2)}ms; full /api/status (bypass) p50=${readP50.toFixed(2)}ms p90=${pct(read, 0.9).toFixed(2)}ms`);
    // Measured locally: ≈ 0.25× (2.5 vs 10 ms); on the production copy 3.45 vs 54.6 ms (0.06×).
    expect(qP50).toBeLessThanOrEqual(0.5 * oldP50);
    // The read without queue_depth ≈ readP50 − qP50; queue_depth may add at most 50 % to it.
    expect(qP50).toBeLessThanOrEqual(0.5 * (readP50 - qP50));
  }, 60_000);
});
