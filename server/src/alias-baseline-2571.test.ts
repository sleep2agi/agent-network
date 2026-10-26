// #2571（第三轮）—— 告警阈值从「全局常数」改成「每个目标自己的 p99 基线」。
//
// 现场（2026-10-27）：同一个 `10 分钟没消费就报警` 的判据，在两种节奏下表现相反 ——
//   7 天基线：delivered→首次活动 p90=6s、p99=12min ⇒ 超过 600s 只占 1.2%
//   某一晚：  p90=411s、p99=1573s             ⇒ 超过 600s 占 5.4%，其中 43% 最终成功
// 全队一起变慢时，全局常数会炸一屏；而单个节点卡死时，又必须能显形。
//
// 这个文件钉住四件事：
//   1. 没有基线（样本不足/老库）⇒ **与 .163 完全一致**（沿用全局下限，不漏报不误报）；
//   2. 基线比全局更宽（慢节点）⇒ 更晚才报；
//   3. 基线比全局更窄（快节点）⇒ **仍然不早于全局下限**（不允许比 600s 更敏感）；
//   4. 基线只由**成功且已进 runtime** 的样本算出来，且样本不足不写行。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import {
  ALIAS_BASELINE_TABLE,
  BASELINE_MIN_SAMPLES,
  aliasBaseline,
  ensureAliasBaselineTable,
  refreshAliasBaseline,
} from "./alias-baseline.js";
import { recordDeliveredStaleEvents } from "./task-lifecycle-watcher.js";

const stamp = `${Date.now()}`;
let NET = "";
const NOW = new Date("2026-10-27T03:00:00.000Z");

function iso(secondsAgo: number): string {
  return new Date(NOW.getTime() - secondsAgo * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function seedTask(id: string, toName: string, deliveredSecondsAgo: number) {
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, status, content, delivered_at, network_id)
     VALUES (?1, 'sender', ?2, 'delivered', 'baseline fixture', ?3, ?4)`,
    [id, toName, iso(deliveredSecondsAgo), NET],
  );
}

function seedSession(alias: string, status: string) {
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, registered_at)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
    [`res_${alias}_${stamp}`, alias, `n_${alias}_${stamp}`, status, NET],
  );
}

function setBaseline(alias: string, p99: number, samples = 100) {
  ensureAliasBaselineTable();
  db.run(
    `INSERT INTO ${ALIAS_BASELINE_TABLE} (alias, network_id, p99_seconds, samples, computed_at)
     VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(alias, network_id) DO UPDATE SET p99_seconds = excluded.p99_seconds, samples = excluded.samples`,
    [alias, NET, p99, samples, NOW.toISOString()],
  );
}

const eventsFor = (taskId: string) =>
  db.all<{ event_type: string }>("SELECT event_type FROM task_events WHERE task_id = ?1", [taskId]).map(r => r.event_type);

beforeAll(async () => {
  const { register } = await import("./auth.js");
  const auth = register(`baseline_owner_${stamp}`, "Baseline-Owner-Strong-1!", undefined, "tester");
  expect(auth.ok).toBe(true);
  NET = auth.network_id!;
  ensureAliasBaselineTable();
});

afterAll(() => {
  try {
    db.run(`DELETE FROM task_events WHERE task_id LIKE ?1`, [`bl-%-${stamp}`]);
    db.run(`DELETE FROM tasks WHERE task_id LIKE ?1`, [`bl-%-${stamp}`]);
    db.run(`DELETE FROM sessions WHERE alias LIKE ?1`, [`bl-%-${stamp}`]);
    db.run(`DELETE FROM ${ALIAS_BASELINE_TABLE} WHERE alias LIKE ?1`, [`bl-%-${stamp}`]);
  } catch {}
});

describe("#2571 alias p99 baseline", () => {
  test("没有基线 ⇒ 沿用全局下限（与 .163 行为一致）", () => {
    seedSession(`bl-nobase-${stamp}`, "idle");
    seedTask(`bl-nobase-task-${stamp}`, `bl-nobase-${stamp}`, 700);
    recordDeliveredStaleEvents(NOW);
    expect(eventsFor(`bl-nobase-task-${stamp}`)).toContain("task.warning.delivered_stale_600s");
  });

  test("基线更宽（慢节点）：700 秒不报，超过 p99×1.5 才报", () => {
    seedSession(`bl-slow-${stamp}`, "idle");
    setBaseline(`bl-slow-${stamp}`, 3600); // 阈值 5400s
    seedTask(`bl-slow-700-${stamp}`, `bl-slow-${stamp}`, 700);
    seedTask(`bl-slow-6000-${stamp}`, `bl-slow-${stamp}`, 6000);
    recordDeliveredStaleEvents(NOW);
    expect(eventsFor(`bl-slow-700-${stamp}`)).toEqual([]);
    expect(eventsFor(`bl-slow-6000-${stamp}`)).toContain("task.warning.delivered_stale_600s");
  });

  test("基线极大（p99=50min）时，等满 30 分钟仍然报（上限兜底）", () => {
    seedSession(`bl-very-slow-${stamp}`, "idle");
    setBaseline(`bl-very-slow-${stamp}`, 3017); // ×1.5 = 4525s，若无上限就永远不报
    seedTask(`bl-very-slow-1900-${stamp}`, `bl-very-slow-${stamp}`, 1900);
    seedTask(`bl-very-slow-1700-${stamp}`, `bl-very-slow-${stamp}`, 1700);
    recordDeliveredStaleEvents(NOW);
    expect(eventsFor(`bl-very-slow-1900-${stamp}`)).toContain("task.warning.delivered_stale_600s");
    expect(eventsFor(`bl-very-slow-1700-${stamp}`)).toEqual([]);
  });

  test("基线更窄（快节点）：不允许比全局下限更敏感", () => {
    seedSession(`bl-fast-${stamp}`, "idle");
    setBaseline(`bl-fast-${stamp}`, 2); // 阈值 max(600, 3) = 600
    seedTask(`bl-fast-120-${stamp}`, `bl-fast-${stamp}`, 120);
    recordDeliveredStaleEvents(NOW);
    expect(eventsFor(`bl-fast-120-${stamp}`)).toEqual([]);
  });

  test("refresh 只用成功且已进 runtime 的样本", () => {
    const alias = `bl-refresh-${stamp}`;
    // 20 条成功的（delivered→started 各 10s），2 条失败的（不应计入）
    for (let i = 0; i < BASELINE_MIN_SAMPLES; i++) {
      db.run(
        `INSERT INTO tasks (task_id, from_name, to_name, status, content, delivered_at, started_at, completed_at, network_id)
         VALUES (?1, 'sender', ?2, 'replied', 'x', ?3, ?4, ?5, ?6)`,
        [`bl-ref-ok-${i}-${stamp}`, alias, iso(1000 - i), iso(990 - i), iso(985 - i), NET],
      );
    }
    for (let i = 0; i < 5; i++) {
      db.run(
        `INSERT INTO tasks (task_id, from_name, to_name, status, content, delivered_at, completed_at, network_id)
         VALUES (?1, 'sender', ?2, 'failed', 'x', ?3, ?4, ?5)`,
        [`bl-ref-bad-${i}-${stamp}`, alias, iso(5000 - i), iso(1000), NET],
      );
    }
    refreshAliasBaseline(NOW);
    const row = aliasBaseline(alias, NET);
    expect(row).not.toBeNull();
    expect(row!.samples).toBe(BASELINE_MIN_SAMPLES); // 失败的不算
    expect(row!.p99Seconds).toBeGreaterThanOrEqual(9); // 10s 左右的样本
    expect(row!.p99Seconds).toBeLessThanOrEqual(11);
  });

  test("样本不足不写基线行（退回全局）", () => {
    const alias = `bl-thin-${stamp}`;
    for (let i = 0; i < BASELINE_MIN_SAMPLES - 1; i++) {
      db.run(
        `INSERT INTO tasks (task_id, from_name, to_name, status, content, delivered_at, started_at, completed_at, network_id)
         VALUES (?1, 'sender', ?2, 'replied', 'x', ?3, ?4, ?5, ?6)`,
        [`bl-thin-${i}-${stamp}`, alias, iso(1000 - i), iso(995 - i), iso(990 - i), NET],
      );
    }
    refreshAliasBaseline(NOW);
    expect(aliasBaseline(alias, NET)).toBeNull();
  });
});
