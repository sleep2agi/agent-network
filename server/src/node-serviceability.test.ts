// #2880 —— 节点级「不可服务」检测（默认关闭，只记录）。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { db } from "./db.js";
import { isNotServing, scanNodeBusyCircuit, nodeCanAcceptDispatch, circuitEnabled } from "./node-serviceability.js";

const NET = "net_circuit";

// 🔴 scheduled_task_runs 上有 UNIQUE(schedule_id, scheduled_for)：
// 用 INSERT OR REPLACE 且 scheduled_for 相同 ⇒ 后一行会**替换**前一行，
// 于是 6 条「忙类失败」最后只剩 1 条，判据永远不成立。每条用不同的 minute 偏移。
function mkTaskAndRun(taskId: string, alias: string, status: string, result: string | null, runStatus: string, errorCode: string | null, minuteOffset = 0) {
  db.run(
    `INSERT OR REPLACE INTO tasks (task_id, content, from_name, to_name, network_id, status, result, created_at, completed_at)
     VALUES (?1, 'x', 'hub', ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))`,
    [taskId, alias, NET, status, result],
  );
  db.run(
    `INSERT OR REPLACE INTO scheduled_task_runs (run_id, schedule_id, network_id, scheduled_for, task_id, status, error_code, created_at)
     VALUES (?1, 'sched_x', ?2, datetime('now', ?3), ?4, ?5, ?6, datetime('now'))`,
    [`run_${taskId}`, NET, `-${minuteOffset + 1} minutes`, taskId, runStatus, errorCode],
  );
}

const BUSY = "[n] opencode 任务未提交：共享会话在 30 分钟 内一直处于忙碌状态";

describe("节点忙熔断：三项判据", () => {
  beforeAll(() => {
    db.run("DELETE FROM scheduled_task_runs WHERE network_id = ?1", [NET]);
    db.run("DELETE FROM tasks WHERE network_id = ?1", [NET]);
  });
  afterAll(() => {
    db.run("DELETE FROM scheduled_task_runs WHERE network_id = ?1", [NET]);
    db.run("DELETE FROM tasks WHERE network_id = ?1", [NET]);
    delete process.env.COMMHUB_NODE_BUSY_CIRCUIT;
  });

  test("纯判定：忙类失败够多 + 零成功 + 有投递 ⇒ 不可服务", () => {
    expect(isNotServing({ delivered: 10, replied: 0, busy_failed: 5 }, 5)).toBe(true);
    expect(isNotServing({ delivered: 10, replied: 1, busy_failed: 9 }, 5)).toBe(false); // 成功过 = 等得到
    expect(isNotServing({ delivered: 4, replied: 0, busy_failed: 4 }, 5)).toBe(false); // 证据不够
    expect(isNotServing({ delivered: 0, replied: 0, busy_failed: 0 }, 5)).toBe(false); // 没投递过 ≠ 不可服务
  });

  test("扫描能把「零产出节点」挑出来，且有成功的节点不受影响", () => {
    for (let i = 0; i < 6; i++) mkTaskAndRun(`t_bh_${i}`, "黑洞节点", "failed", BUSY, "failed", null, i);
    for (let i = 0; i < 6; i++) mkTaskAndRun(`t_ok_${i}`, "正常节点", i < 3 ? "replied" : "failed", i < 3 ? "done" : BUSY, i < 3 ? "replied" : "failed", null, i + 10);
    const r = scanNodeBusyCircuit();
    expect(r.tripped).toContain("黑洞节点");
    expect(r.tripped).not.toContain("正常节点");
    expect(r.enabled).toBe(false); // 默认关闭
  });

  test("默认关闭时投递判断恒放行（不改任何既有行为）", () => {
    delete process.env.COMMHUB_NODE_BUSY_CIRCUIT;
    expect(circuitEnabled()).toBe(false);
    expect(nodeCanAcceptDispatch("黑洞节点", NET).ok).toBe(true);
  });

  test("开启后才拦：黑洞节点被拒，正常节点仍放行", () => {
    process.env.COMMHUB_NODE_BUSY_CIRCUIT = "1";
    const bad = nodeCanAcceptDispatch("黑洞节点", NET);
    expect(bad.ok).toBe(false);
    expect(bad.reason ?? "").toContain("忙类失败");
    expect(nodeCanAcceptDispatch("正常节点", NET).ok).toBe(true);
    expect(nodeCanAcceptDispatch("不存在的节点", NET).ok).toBe(true); // 没数据就不拦
  });
});
