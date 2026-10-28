// #2840 —— 连续确定性失败 → 一条告警；且不因 timeout 或一次性失败而告警。
// 校准依据见模块头注释：只算确定性错误时 7 天 6 条（0.9/天）；含 timeout 则是 35 条。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";
import { scanNodeFailureAlerts, classifyDeterministicFailure, NODE_FAILURE_ALERT_KIND } from "./node-failure-alert.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-nfa-"));
let NET = "", UID = "", NODE = "";

function task(to: string, status: string, result: string, minutesAgo: number) {
  const id = `t_nfa_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, result, created_at, completed_at, network_id)
     VALUES (?1,'scheduler',?2,'normal',?3,'c',?4, datetime('now', ?5), datetime('now', ?5), ?6)`,
    [id, to, status, result, `-${minutesAgo} minutes`, NET],
  );
}

const alerts = () => db.all<{ id: string }>(
  "SELECT message_id AS id FROM user_inbox WHERE kind = ?1", NODE_FAILURE_ALERT_KIND,
);

beforeAll(() => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  const a = register(`nfa_owner_${Date.now()}`, "NfaPassw0rd!x", undefined, "Owner");
  expect(a.ok).toBe(true);
  NET = a.network_id!; UID = a.user!.user_id;
  NODE = `nfa-node-${Date.now()}`;
  db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, owner_user_id) VALUES (?1,?2,?2,'codex',?3,?4)",
    [`n_${NODE}`, NODE, NET, UID]);
});
afterAll(() => { try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("#2840 节点连续确定性失败告警", () => {
  test("分类：只认确定性错误，timeout 与任务内容错误都不算", () => {
    expect(classifyDeterministicFailure("codex-app-server 错误: Missing environment variable: `DEEPSEEK_KEY`")).toBe("missing_env");
    expect(classifyDeterministicFailure("spawn ENOENT")).toBe("binary_missing");
    expect(classifyDeterministicFailure("401 Unauthorized")).toBe("login_required");
    expect(classifyDeterministicFailure("codex request 'turn/start' timed out")).toBeNull();
    // #2891 —— 额度耗尽单列一类；限流（会自愈）**不能**混进来
    expect(classifyDeterministicFailure("opencode 错误: 模型调用失败（provider.quota: The usage limit has been reached）")).toBe("quota_exhausted");
    expect(classifyDeterministicFailure("provider.quota: Free usage limit reached.")).toBe("quota_exhausted");
    // 限流不是额度：等几秒就好，不该惊动人
    expect(classifyDeterministicFailure("429 Too Many Requests (rate limit)")).toBeNull();
    // 任务正文里**提到**额度（不是错误原文）→ 不能命中
    expect(classifyDeterministicFailure("本轮汇报：我把 provider.quota 的含义写进了 runbook")).toBeNull();
    // 已知限制：正文**逐字引用**错误原文（含冒号）时仍会命中。
    // 生产 7 天语料里这样的假阳性 1/507，且告警要「连续 5 次」才发，故不改判据；
    // 这里把它钉成测试，避免以后有人误以为这是完备的语义判断。
    expect(classifyDeterministicFailure("引用：provider.quota: The usage limit has been reached")).toBe("quota_exhausted");
    expect(classifyDeterministicFailure("任务内容写错了")).toBeNull();
    expect(classifyDeterministicFailure(null)).toBeNull();
  });

  test("连续 5 次缺环境变量 → 恰好一条告警；再次扫描不重复发", () => {
    for (let i = 5; i >= 1; i--) task(NODE, "failed", "Missing environment variable: `DEEPSEEK_KEY`", i * 3);
    const first = scanNodeFailureAlerts();
    expect(first.nodes).toContain(NODE);
    expect(alerts().length).toBe(1);
    const again = scanNodeFailureAlerts();
    expect(again.nodes).not.toContain(NODE);
    expect(alerts().length).toBe(1);
  });

  test("timeout 连续 10 次不告警（这是校准结论的回归钉）", () => {
    const other = `nfa-timeout-${Date.now()}`;
    db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, owner_user_id) VALUES (?1,?2,?2,'codex',?3,?4)",
      [`n_${other}`, other, NET, UID]);
    for (let i = 10; i >= 1; i--) task(other, "failed", "turn/start timed out", i * 2);
    const r = scanNodeFailureAlerts();
    expect(r.nodes).not.toContain(other);
    expect(alerts().length).toBe(1); // 仍然只有前面那一条
  });

  test("中间出现一条成功就断开连续，不告警", () => {
    const reset = `nfa-reset-${Date.now()}`;
    db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, owner_user_id) VALUES (?1,?2,?2,'codex',?3,?4)",
      [`n_${reset}`, reset, NET, UID]);
    task(reset, "failed", "Missing environment variable: `X`", 30);
    task(reset, "failed", "Missing environment variable: `X`", 29);
    task(reset, "replied", "ok 正常完成", 28);
    task(reset, "failed", "Missing environment variable: `X`", 27);
    task(reset, "failed", "Missing environment variable: `X`", 26);
    const r = scanNodeFailureAlerts();
    expect(r.nodes).not.toContain(reset);
  });
});
