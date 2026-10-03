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
//   2. the cost: on the full /api/status read (cache bypassed), queue_depth adds at most 50 % to the rest of the read
//      (the read is ≤ 1.5× what it would be without queue_depth) and its own p50 stays under an absolute bound;
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
const N = 40;

let db: any;
let hub: any = null;
let BASE = "", NET = "", token = "";
let mod: any;
let expectedOpen = new Map<string, number>();

const ts = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const plan = (sql: string, params: any[]) => (db.all("EXPLAIN QUERY PLAN " + sql, ...params) as Array<{ detail: string }>).map((r) => r.detail).join(" | ");

beforeAll(async () => {
  if (PG) return;
  ({ db } = await import("./db.js"));
  mod = await import("./task-queue-ahead.js");
  const { register } = await import("./auth.js");
  const u = register(`scale_${Date.now()}`, "QueueScale123!x");
  token = u.token!; NET = u.network_id!;
  const now = Date.now();
  let seq = 0;
  const node = (i: number) => `scale-node-${i % NODES}`;
  db.transaction(() => {
    for (let i = 0; i < NODES; i++) {
      db.run(`INSERT INTO sessions (resume_id, alias, status, agent, network_id, node_id, updated_at, last_seen_at, task)
        VALUES (?1, ?2, 'idle', 'agent-node:codex', ?3, ?4, datetime('now'), datetime('now'), 'x')`, [`sdk-scale-${i}`, node(i), NET, `n_scale_${i}`]);
    }
    const put = (to: string, status: string, ageMs: number, done: boolean) => db.run(
      `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, created_at, delivered_at, completed_at, expires_at, network_id)
       VALUES (?1, 'scale-sender', ?2, 'normal', ?3, 'c', ?4, ?4, ?5, ?6, ?7)`,
      [`scale-${++seq}`, to, status, ts(now - ageMs), done ? ts(now - ageMs + 120_000) : null, ts(now - ageMs + 3600_000), NET]);
    const old = () => 25 * 3600_000 + Math.floor(Math.random() * 30 * 86400_000);
    // Two thirds of the stuck rows on one node, the rest spread out.
    for (let i = 0; i < STUCK_ACKED; i++) put(i % 3 ? HOT : node(i), "acked", old(), false);
    for (let i = 0; i < STUCK_RUNNING; i++) put(node(i), "running", old(), false);
    const doneStatuses = ["replied", "replied", "replied", "failed", "expired"];
    for (let i = 0; i < OLD_DONE; i++) put(node(i), doneStatuses[i % doneStatuses.length], old(), true);
    const recentStatuses = ["replied", "replied", "replied", "delivered", "running", "acked", "failed"];
    for (let i = 0; i < RECENT; i++) {
      const st = recentStatuses[i % recentStatuses.length];
      const to = node(i * 13);
      put(to, st, Math.floor(Math.random() * 23 * 3600_000), !["delivered", "running", "acked"].includes(st));
      if (["delivered", "running", "acked"].includes(st)) expectedOpen.set(to, (expectedOpen.get(to) ?? 0) + 1);
    }
  });
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

  test("cost: queue_depth adds at most 50% to a full /api/status read (cache bypassed), and its p50 is small", async () => {
    const cache = await import("./status-read-cache.js");
    cache.__setStatusCacheBypassForTest(true);
    try {
      const read: number[] = [];
      for (let i = 0; i < N + 5; i++) {
        const s = performance.now();
        const r = await fetch(`${BASE}/api/status?network_id=${NET}`, { headers: { Authorization: `Bearer ${token}` } });
        await r.text();
        if (i >= 5) read.push(performance.now() - s);
      }
      const q: number[] = [];
      for (let i = 0; i < N + 5; i++) {
        const s = performance.now();
        mod.queueDepthByNode();
        if (i >= 5) q.push(performance.now() - s);
      }
      const readP50 = pct(read, 0.5), readP90 = pct(read, 0.9), qP50 = pct(q, 0.5);
      console.log(`[perf] full /api/status (bypass) p50=${readP50.toFixed(2)}ms p90=${readP90.toFixed(2)}ms; queue_depth query p50=${qP50.toFixed(2)}ms`);
      // The read without queue_depth ≈ readP50 − qP50. Budget: queue_depth adds at most 50 % to it, i.e. the full read
      // is ≤ 1.5× what it would be without queue_depth. Measured here: fixed ≈ 0.3× (2.6 of 11 ms); the #2325 SQL
      // ≈ 0.9× (10 of 21 ms, plan on idx_tasks_status) — on the production copy it was ~7×.
      expect(qP50).toBeLessThanOrEqual(0.5 * (readP50 - qP50));
      expect(qP50).toBeLessThan(20);
    } finally {
      cache.__setStatusCacheBypassForTest(false);
    }
  }, 60_000);
});
