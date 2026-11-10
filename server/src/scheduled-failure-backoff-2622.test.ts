// #2622 —— 定时任务「连续失败 → 间隔翻倍 → 成功即恢复」。
//
// 为什么需要它（生产 24h，2026-10-27）：
//   一个 `every_seconds=180` 的排程 351 次失败 / 24 次成功 —— 失败与成功交替，
//   所以「连续失败」永远攒不到 #523 的自动暂停阈值，而**每一次失败都按 3 分钟原速重试**。
//   `#523` 的机制（连续 5 次通知、可选自动暂停）都在，缺的只是「放慢」这一档。
//
// 这个文件钉住四件事：
//   1. 连续失败达到阈值 ⇒ `backoff_effective_seconds` 按 2 倍递增，且有上限；
//   2. `next_run_at` 只往后推，不会被“放大后又缩短”的抖动来回拉；
//   3. 成功一次 ⇒ 立刻清空退避，`next_run_at` 拉回正常节奏；
//   4. 与 `no_change_backoff` 互斥（那套逻辑自己拥有这一列），关掉开关时完全不介入。

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { register } from "./auth.js";
import { db } from "./db.js";
import { applyFailureBackoff, failureBackoffRuns } from "./scheduled-failures.js";

const stamp = Date.now();
let NET = "";
let creatorId = "";
const ENV_KEY = "COMMHUB_SCHEDULE_FAILURE_BACKOFF_RUNS";
const savedEnv = process.env[ENV_KEY];
let slot = 0;

function seedSchedule(everySeconds = 180, patch: Record<string, unknown> = {}) {
  const scheduleId = `sched_bo_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, created_by, name, target_node_id, target_alias, task_content, priority,
        schedule_type, schedule_json, timezone, status, next_run_at, overlap_policy)
     VALUES (?1, ?2, ?3, 'backoff fixture', 'n_bo', 'bo-node', 'x', 'normal', 'interval', ?4,
             'Asia/Shanghai', 'active', ?5, 'skip')`,
    [scheduleId, NET, creatorId, JSON.stringify({ type: "interval", every_seconds: everySeconds }),
     new Date(Date.now() + everySeconds * 1000).toISOString()],
  );
  for (const [k, v] of Object.entries(patch)) db.run(`UPDATE scheduled_tasks SET ${k} = ?1 WHERE schedule_id = ?2`, [v as any, scheduleId]);
  return scheduleId;
}

function addRun(scheduleId: string, status: string, minutesFromNow: number) {
  const runId = `srun_bo_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO scheduled_task_runs (run_id, schedule_id, network_id, scheduled_for, status, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?4)`,
    [runId, scheduleId, NET, new Date(Date.now() + minutesFromNow * 60_000).toISOString(), status],
  );
  return runId;
}

const reload = (id: string) => db.get<any>("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", id)!;

beforeAll(async () => {
  const auth = register(`bo_owner_${stamp}`, "Bo-Owner-Strong-1!", undefined, "tester");
  expect(auth.ok).toBe(true);
  NET = auth.network_id!;
  creatorId = auth.user_id!;
  process.env[ENV_KEY] = "6";
});

afterEach(() => {
  process.env[ENV_KEY] = "6";
});

afterAll(() => {
  try { db.run(`DELETE FROM scheduled_task_runs WHERE network_id = ?1`, [NET]); } catch {}
  try { db.run(`DELETE FROM scheduled_tasks WHERE network_id = ?1`, [NET]); } catch {}
  if (savedEnv === undefined) delete process.env[ENV_KEY]; else process.env[ENV_KEY] = savedEnv;
});

describe("#2622 failure backoff", () => {
  test("默认阈值是 6，且可以关掉", () => {
    delete process.env[ENV_KEY];
    expect(failureBackoffRuns()).toBe(6);
    process.env[ENV_KEY] = "0";
    expect(failureBackoffRuns()).toBe(0);
  });

  test("失败次数未到阈值：不写退避", () => {
    const id = seedSchedule();
    for (let i = 0; i < 5; i++) addRun(id, "failed", -60 + i);
    const out = applyFailureBackoff(id);
    expect(out).toEqual({ streak: 5, effective_seconds: null });
    expect(reload(id).backoff_effective_seconds ?? null).toBeNull();
  });

  test("达到阈值后间隔翻倍，且 next_run_at 只会往后推", () => {
    const id = seedSchedule(180);
    for (let i = 0; i < 6; i++) addRun(id, "failed", -60 + i);
    const before = reload(id).next_run_at;
    const out = applyFailureBackoff(id);
    expect(out!.effective_seconds).toBe(360); // 180 × 2
    const after = reload(id);
    expect(after.backoff_effective_seconds).toBe(360);
    expect(Date.parse(after.next_run_at)).toBeGreaterThanOrEqual(Date.parse(before));
  });

  test("失败继续累积：指数放大且有 1 小时上限", () => {
    const id = seedSchedule(180);
    for (let i = 0; i < 12; i++) addRun(id, "failed", -120 + i);
    const out = applyFailureBackoff(id);
    // 180 × 2^k 会被 3600 截断
    expect(out!.effective_seconds).toBeLessThanOrEqual(3600);
    expect(out!.streak).toBe(12);
  });

  test("成功一次 ⇒ 立刻清空退避并把 next_run_at 拉回正常节奏", () => {
    const id = seedSchedule(180);
    for (let i = 0; i < 8; i++) addRun(id, "failed", -120 + i);
    applyFailureBackoff(id);
    expect(reload(id).backoff_effective_seconds).toBeGreaterThan(180);
    addRun(id, "replied", -1);
    const out = applyFailureBackoff(id);
    expect(out!.streak).toBe(0);
    expect(out!.effective_seconds).toBeNull();
    expect(reload(id).backoff_effective_seconds ?? null).toBeNull();
  });

  test("no_change_backoff 的排程不被这条逻辑改写", () => {
    const id = seedSchedule(180, { no_change_backoff: 1 });
    for (let i = 0; i < 9; i++) addRun(id, "failed", -120 + i);
    expect(applyFailureBackoff(id)).toBeNull();
    expect(reload(id).backoff_effective_seconds ?? null).toBeNull();
  });

  test("非 interval 排程不参与", () => {
    const id = seedSchedule(180, { schedule_type: "daily", schedule_json: JSON.stringify({ type: "daily", time: "09:00" }) });
    for (let i = 0; i < 9; i++) addRun(id, "failed", -120 + i);
    expect(applyFailureBackoff(id)).toBeNull();
  });

  test("paused 的排程不参与（暂停已经把它停住了）", () => {
    const id = seedSchedule(180, { status: "paused", next_run_at: null });
    for (let i = 0; i < 9; i++) addRun(id, "failed", -120 + i);
    expect(applyFailureBackoff(id)).toBeNull();
  });

  test("开关设为 0 时完全不介入", () => {
    const id = seedSchedule(180);
    for (let i = 0; i < 9; i++) addRun(id, "failed", -120 + i);
    process.env[ENV_KEY] = "0";
    expect(applyFailureBackoff(id)).toBeNull();
    expect(reload(id).backoff_effective_seconds ?? null).toBeNull();
  });
});
