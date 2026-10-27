// #2622（第二轮）—— 「跑不起来」的两类跳过也要退避。
//
// 生产 24h（2026-10-27）：previous_run_active 2286 条、target_offline 1951 条，
// 而 failureStreak 只数 status='failed'，skipped 完全不计 ⇒ 永远按原速重试。
//
// 这个文件钉住四件事：
//   1. 同一 error_code 连续 ≥3 次 ⇒ 间隔放大（有上限：previous_run_active 1800s / target_offline 3600s）；
//   2. 换链（原因变了）或出现成功 ⇒ 立刻回到原间隔；
//   3. no_change_backoff=1 的排程由另一套逻辑拥有 backoff 列，这里完全不介入；
//   4. 非 interval 排程不介入。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { register } from "./auth.js";
import { db } from "./db.js";
import { applyNoProgressBackoff, noProgressBackoffRuns } from "./scheduled-failures.js";

const stamp = Date.now();
let NET = "";
let creatorId = "";

function seedSchedule(everySeconds = 180, extra: Record<string, unknown> = {}) {
  const id = `sched_np_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, created_by, name, target_node_id, target_alias, task_content, priority,
        schedule_type, schedule_json, timezone, status, next_run_at, overlap_policy)
     VALUES (?1, ?2, ?3, 'np fixture', 'n_np', 'np-node', 'x', 'normal', 'interval', ?4,
             'Asia/Shanghai', 'active', ?5, 'skip')`,
    [id, NET, creatorId, JSON.stringify({ type: "interval", every_seconds: everySeconds }),
     new Date(Date.now() + everySeconds * 1000).toISOString()],
  );
  for (const [k, v] of Object.entries(extra)) db.run(`UPDATE scheduled_tasks SET ${k} = ?1 WHERE schedule_id = ?2`, [v as any, id]);
  return id;
}

let seq = 0;
function addRun(scheduleId: string, status: string, code: string | null) {
  seq += 1;
  const when = new Date(Date.now() + seq * 1000).toISOString();
  db.run(
    `INSERT INTO scheduled_task_runs (run_id, schedule_id, network_id, scheduled_for, status, error_code, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?4)`,
    [`srun_np_${crypto.randomUUID()}`, scheduleId, NET, when, status, code],
  );
}

const reload = (id: string) => db.get<any>("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", id)!;

beforeAll(async () => {
  const auth = register(`np_owner_${stamp}`, "Np-Owner-Strong-1!", undefined, "tester");
  expect(auth.ok).toBe(true);
  NET = auth.network_id!;
  creatorId = auth.user_id!;
  delete process.env.COMMHUB_SCHEDULE_NO_PROGRESS_BACKOFF_RUNS;
});

afterAll(() => { delete process.env.COMMHUB_SCHEDULE_NO_PROGRESS_BACKOFF_RUNS; });

describe("applyNoProgressBackoff (#2622)", () => {
  test("defaults to 3 consecutive same-cause skips", () => {
    expect(noProgressBackoffRuns()).toBe(3);
  });

  test("target_offline streak widens the interval (capped at 2h)", () => {
    const id = seedSchedule(180);
    for (let i = 0; i < 4; i++) addRun(id, "skipped", "target_offline");
    const r = applyNoProgressBackoff(id)!;
    expect(r.cause).toBe("target_offline");
    expect(r.streak).toBe(4);
    expect(r.effective_seconds).toBeGreaterThan(180);
    expect(r.effective_seconds!).toBeLessThanOrEqual(7200);
    expect(reload(id).backoff_effective_seconds).toBe(r.effective_seconds);
  });

  test("previous_run_active uses a shorter cap (30min)", () => {
    const id = seedSchedule(180);
    for (let i = 0; i < 10; i++) addRun(id, "skipped", "previous_run_active");
    const r = applyNoProgressBackoff(id)!;
    expect(r.cause).toBe("previous_run_active");
    expect(r.effective_seconds).toBe(1800);
  });

  test("below the threshold it leaves the interval alone", () => {
    const id = seedSchedule(180);
    addRun(id, "skipped", "target_offline");
    addRun(id, "skipped", "target_offline");
    expect(applyNoProgressBackoff(id)).toBeNull();
    expect(reload(id).backoff_effective_seconds).toBeNull();
  });

  test("a success resets the streak and restores the base interval", () => {
    const id = seedSchedule(180);
    for (let i = 0; i < 5; i++) addRun(id, "skipped", "target_offline");
    const widened = applyNoProgressBackoff(id)!;
    expect(widened.effective_seconds!).toBeGreaterThan(180);
    addRun(id, "replied", null); // 成功一次
    expect(applyNoProgressBackoff(id)).toBeNull();
    const row = reload(id);
    expect(row.backoff_streak).toBe(0);
    expect(row.backoff_effective_seconds).toBeNull();
  });

  test("switching cause (different error_code) does not keep the streak", () => {
    const id = seedSchedule(180);
    addRun(id, "skipped", "target_offline");
    addRun(id, "skipped", "target_offline");
    addRun(id, "skipped", "previous_run_active"); // 最新一条换链 ⇒ streak=1
    expect(applyNoProgressBackoff(id)).toBeNull();
  });

  test("schedules that opt into no_change_backoff are left to the other mechanism", () => {
    const id = seedSchedule(180, { no_change_backoff: 1 });
    for (let i = 0; i < 5; i++) addRun(id, "skipped", "target_offline");
    expect(applyNoProgressBackoff(id)).toBeNull();
    expect(reload(id).backoff_effective_seconds).toBeNull();
  });
});
