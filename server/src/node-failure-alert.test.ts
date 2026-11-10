// #2840 —— 连续确定性失败 → 一条告警；且不因 timeout 或一次性失败而告警。
// 校准依据见模块头注释：只算确定性错误时 7 天 6 条（0.9/天）；含 timeout 则是 35 条。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";
import { scanNodeFailureAlerts, scanModelAuthBlockedNodes, classifyDeterministicFailure, NODE_FAILURE_ALERT_KIND, MODEL_AUTH_BLOCKED_CATEGORY } from "./node-failure-alert.js";

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
    // #2964 —— 这是生产里真实出现的那一句（agent-node 的 codex-health 生成），
    // 原来的正则在它上面返回 null ⇒ 凭据过期的节点一条告警都发不出去。
    expect(classifyDeterministicFailure(
      "codex-app-server 错误: model login expired: this node's CODEX_HOME (/home/user/.anet/nodes/n/codex-home) needs a fresh login — log in again there: CODEX_HOME=/x codex login. Not taking work until then (do not copy another node's auth.json).",
    )).toBe("login_required");
    expect(classifyDeterministicFailure("model login revoked: this node's CODEX_HOME needs a fresh login")).toBe("login_required");
    // 反例：非登录类的失败不能被吸进来
    expect(classifyDeterministicFailure("model login ok")).toBeNull();
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

// #2964 后半 —— 节点「在线但干不了活」：状态是 error、原因是登录失效，
// 但它一条任务都不接，所以「连续失败」那条告警路径永远不会触发。
describe("#2964 登录失效节点（不接活）", () => {
  const session = (alias: string, status: string, task: string | null) => {
    db.run(
      `INSERT OR REPLACE INTO sessions (resume_id, alias, status, task, network_id, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`,
      [`s_${alias}`, alias, status, task, NET],
    );
    db.run(
      `INSERT OR IGNORE INTO nodes (node_id, node_name, alias, runtime, network_id, owner_user_id)
       VALUES (?1, ?2, ?2, 'codex', ?3, ?4)`,
      [`n_${alias}`, alias, NET, UID],
    );
  };

  test("status=error 且原因是登录失效 → 告警一次；同一天再扫不重复", () => {
    const alias = `nfa-auth-${Date.now()}`;
    session(alias, "error", "model login expired: this node's CODEX_HOME needs a fresh login — log in again there");
    const before = alerts().length;
    expect(scanModelAuthBlockedNodes().nodes).toContain(alias);
    expect(alerts().length).toBe(before + 1);
    // 每节点每天一条：再扫一次不应新增
    expect(scanModelAuthBlockedNodes().alerts).toBe(0);
  });

  test("idle 的节点不告警（没坏就别吵）", () => {
    const alias = `nfa-auth-idle-${Date.now()}`;
    session(alias, "idle", "model login expired: needs a fresh login");
    expect(scanModelAuthBlockedNodes().nodes).not.toContain(alias);
  });

  test("error 但原因不是登录类（例如代码异常）不告警", () => {
    const alias = `nfa-auth-other-${Date.now()}`;
    session(alias, "error", "TypeError: cannot read properties of undefined (reading 'x')");
    expect(scanModelAuthBlockedNodes().nodes).not.toContain(alias);
  });

  test("告警里带类别与当天日期（去重键）", () => {
    const row = db.get<{ cat: string; day: string }>(
      `SELECT json_extract(meta_json,'$.node_failure_alert.category') AS cat,
              json_extract(meta_json,'$.node_failure_alert.first_seen') AS day
         FROM user_inbox WHERE kind = ?1
          AND json_extract(meta_json,'$.node_failure_alert.category') = ?2 LIMIT 1`,
      NODE_FAILURE_ALERT_KIND, MODEL_AUTH_BLOCKED_CATEGORY,
    );
    expect(row?.cat).toBe(MODEL_AUTH_BLOCKED_CATEGORY);
    expect(row?.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
