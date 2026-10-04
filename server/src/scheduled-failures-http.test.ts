// #523 —— 定时任务连续失败:告诉创建者(可选自动暂停)。
//
// 钉住:
//   1. 连续 5 次失败(派出去的任务以 failed 结束)→ 给创建者恰好 1 条通知(别的成员 0 条),第 6–10 次不再发;
//      通知里有排程名、目标节点、失败次数、最近一次的错误(截断)和怎么暂停。
//   2. 派发时就失败(目标节点不存在)同样计数。
//   3. 中间成功一次 → 重新上膛:再连续 5 次失败才发第二条。
//   4. 一直失败:24 小时内不重发;上次告警早于 24 小时 → 再发一条。
//   5. 默认不自动暂停;COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS=3 → 第 3 次失败后排程 paused、next_run_at 清空、
//      revision+1,并通知一次。
//   6. GET /runs 返回 consecutive_failures / failure_alert_threshold / last_failure_alert_at,
//      任务以 failed 结束的 run 的 error_message 取自任务的回复正文。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/scheduled-failures-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { dispatchScheduledOccurrence, handleScheduledTaskRequest } from "./scheduled-tasks.js";
import { SCHEDULE_FAILING_NOTICE_KIND, failureStreak } from "./scheduled-failures.js";
import { registerTools } from "./tools.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("scheduled-failures requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now();
const ALIAS = `fail-node-${stamp}`;
const NODE_ID = `n_fail_${stamp}`;
let NET = "", creatorId = "", otherId = "";
const ENV_KEYS = ["COMMHUB_SCHEDULE_FAILURE_NOTICE_RUNS", "COMMHUB_SCHEDULE_FAILURE_RENOTICE_SEC", "COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS"];
const SAFETY_ERROR = "执行出错: upstream model refused the request (safety system). " + "x".repeat(600);

function seedSchedule(name = "前后端分离巡检", targetNodeId = NODE_ID): any {
  const scheduleId = `sched_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, created_by, name, target_node_id, target_alias, task_content, priority,
        schedule_type, schedule_json, timezone, status, next_run_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'scheduled task', 'normal', 'interval',
             '{"type":"interval","every_seconds":120}', 'Asia/Shanghai', 'active', datetime('now', '+2 minutes'))`,
    [scheduleId, NET, creatorId, name, targetNodeId, ALIAS],
  );
  return reload(scheduleId);
}
const reload = (scheduleId: string) => db.get<any>("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", scheduleId);

let slot = 0;
const nextSlot = () => new Date(Date.UTC(2026, 9, 4, 0, 0, 0) + (++slot) * 120_000).toISOString();
const fire = (schedule: any, now = new Date()) => dispatchScheduledOccurrence(schedule, nextSlot(), false, now);

const notices = (userId: string) => db.all<{ title: string; content: string; meta_json: string; from_session: string; severity: string }>(
  "SELECT title, content, meta_json, from_session, severity FROM user_inbox WHERE user_id = ?1 AND network_id = ?2 AND kind = ?3 ORDER BY created_at, message_id",
  userId, NET, SCHEDULE_FAILING_NOTICE_KIND,
);
const noticesFor = (userId: string, scheduleId: string) => notices(userId).filter((n) => JSON.parse(n.meta_json).schedule_failing.schedule_id === scheduleId);

async function nodeReply(args: Record<string, unknown>): Promise<any> {
  const mcp = new McpServer({ name: "sched-fail", version: "0" }) as any;
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const original = mcp.tool.bind(mcp);
  mcp.tool = (name: string, ...rest: any[]) => {
    const handler = rest.at(-1);
    if (typeof handler === "function") handlers[name] = handler;
    return original(name, ...rest);
  };
  registerTools(mcp, undefined, NET, creatorId, ALIAS, true, null);
  const out = await handlers.send_reply(args);
  return JSON.parse(out.content[0].text);
}

/** 派一次,节点以 failed(或 replied)回复。 */
async function runOnce(schedule: any, outcome: "failed" | "replied" = "failed"): Promise<{ runId: string; taskId: string }> {
  const r = fire(schedule);
  expect(r.status).toBe("delivered");
  const out = await nodeReply({ alias: "scheduler", text: outcome === "failed" ? SAFETY_ERROR : "done", in_reply_to: r.taskId, status: outcome, from_session: ALIAS });
  expect(out.ok).toBe(true);
  return { runId: r.runId, taskId: r.taskId! };
}

async function getRuns(scheduleId: string): Promise<any> {
  const url = new URL(`http://hub.test/api/scheduled-tasks/${scheduleId}/runs`);
  const res = await handleScheduledTaskRequest({
    req: new Request(url, { method: "GET" }), url,
    auth: { userId: creatorId, networkId: NET, username: "creator" },
    isAdmin: false, isNodeToken: false, scope: { networkId: NET, networkIds: [NET] } as any,
  });
  expect(res!.status).toBe(200);
  return res!.json();
}

beforeAll(() => {
  const creator = register(`fail_creator_${stamp}`, "FailCreator123!", undefined, "seed");
  expect(creator.ok).toBe(true);
  NET = creator.network_id!; creatorId = creator.user!.user_id;
  const other = register(`fail_other_${stamp}`, "FailOther123!", undefined, "seed");
  otherId = other.user!.user_id;
  expect(addNetworkMember(NET, otherId, "member", creatorId, { agentAccess: "all" }).ok).toBe(true);
  expect(createNetworkTokenForNode(creatorId, NET, ALIAS).ok).toBe(true);
  db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id) VALUES (?1, ?2, ?2, 'claude-code', ?3)", [NODE_ID, ALIAS, NET]);
  db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id) VALUES (?1, ?2, 'idle', ?3, ?4)", [`r_fail_${stamp}`, ALIAS, NODE_ID, NET]);
});
beforeEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
afterAll(() => { db.run("DELETE FROM user_inbox WHERE network_id = ?1 AND kind = ?2", [NET, SCHEDULE_FAILING_NOTICE_KIND]); });

describe("#523 consecutive-failure alert", () => {
  test("5 failed runs → exactly one notice to the creator with name/target/count/error/how to pause; runs 6–10 stay quiet", async () => {
    const s = seedSchedule();
    for (let i = 0; i < 4; i++) await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(0);
    await runOnce(s);
    const mine = noticesFor(creatorId, s.schedule_id);
    expect(mine.length).toBe(1);
    expect(noticesFor(otherId, s.schedule_id).length).toBe(0);
    const n = mine[0];
    expect(n.from_session).toBe(ALIAS);
    expect(n.title).toBe("定时任务连续失败");
    expect(n.severity).toBe("error");
    for (const frag of ["前后端分离巡检", ALIAS, "连续 5 次", "safety system", "task_failed", "暂停", s.schedule_id]) expect(n.content).toContain(frag);
    expect(n.content).not.toContain("x".repeat(400)); // 错误被截断
    expect(JSON.parse(n.meta_json).schedule_failing).toEqual({ reason: "failing", schedule_id: s.schedule_id, consecutive_failures: 5, error_code: "task_failed" });
    for (let i = 0; i < 5; i++) await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(1);
    expect(reload(s.schedule_id).status).toBe("active"); // 默认不自动暂停
  });

  test("dispatch-time failures (target node gone) count too", () => {
    const s = seedSchedule("孤儿排程", `n_missing_${stamp}`);
    for (let i = 0; i < 5; i++) expect(fire(s).status).toBe("failed");
    const mine = noticesFor(creatorId, s.schedule_id);
    expect(mine.length).toBe(1);
    expect(mine[0].content).toContain("target_node_not_found");
    expect(mine[0].content).toContain("The bound node no longer exists");
  });

  test("a success in between re-arms: the next 5 failures notify again", async () => {
    const s = seedSchedule();
    for (let i = 0; i < 5; i++) await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(1);
    await runOnce(s, "replied");
    expect(failureStreak(s.schedule_id).consecutiveFailures).toBe(0);
    for (let i = 0; i < 4; i++) await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(1);
    await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(2);
  });

  test("still failing: no repeat within 24h; one more once the last alert is older than 24h", async () => {
    const s = seedSchedule();
    for (let i = 0; i < 5; i++) await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(1);
    db.run("UPDATE scheduled_tasks SET failure_alert_at = ?1 WHERE schedule_id = ?2", [new Date(Date.now() - 23 * 3_600_000).toISOString(), s.schedule_id]);
    await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(1);
    db.run("UPDATE scheduled_tasks SET failure_alert_at = ?1 WHERE schedule_id = ?2", [new Date(Date.now() - 25 * 3_600_000).toISOString(), s.schedule_id]);
    await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(2);
    await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(2);
  });

  test("COMMHUB_SCHEDULE_FAILURE_NOTICE_RUNS changes N; no creator → no notice", async () => {
    process.env.COMMHUB_SCHEDULE_FAILURE_NOTICE_RUNS = "2";
    const s = seedSchedule();
    await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(0);
    await runOnce(s);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(1);

    const orphan = seedSchedule();
    db.run("UPDATE scheduled_tasks SET created_by = NULL WHERE schedule_id = ?1", [orphan.schedule_id]);
    const row = reload(orphan.schedule_id);
    for (let i = 0; i < 3; i++) await runOnce(row);
    expect(noticesFor(creatorId, orphan.schedule_id).length).toBe(0);
  });
});

describe("#523 auto-pause (opt-in)", () => {
  test("off by default: 10 failures leave the schedule active", async () => {
    const s = seedSchedule();
    for (let i = 0; i < 10; i++) await runOnce(s);
    const after = reload(s.schedule_id);
    expect(after.status).toBe("active");
    expect(after.next_run_at).not.toBeNull();
  });

  test("COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS=3 pauses after the 3rd failure and tells the creator once", async () => {
    process.env.COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS = "3";
    const s = seedSchedule();
    await runOnce(s); await runOnce(s);
    expect(reload(s.schedule_id).status).toBe("active");
    await runOnce(s);
    const after = reload(s.schedule_id);
    expect(after.status).toBe("paused");
    expect(after.next_run_at).toBeNull();
    expect(after.revision).toBe(s.revision + 1);
    const mine = noticesFor(creatorId, s.schedule_id);
    expect(mine.length).toBe(1);
    expect(mine[0].title).toBe("定时任务连续失败,已自动暂停");
    expect(JSON.parse(mine[0].meta_json).schedule_failing.reason).toBe("paused");
    // 手动 run-now 再失败两次到 N=5:同一段失败,已经通知过 → 不再发
    await runOnce(after); await runOnce(after);
    expect(noticesFor(creatorId, s.schedule_id).length).toBe(1);
  });
});

describe("#523 GET /runs", () => {
  test("exposes consecutive_failures and the failed task's reason as error_message", async () => {
    const s = seedSchedule();
    await runOnce(s, "replied");
    const fails = [await runOnce(s), await runOnce(s)];
    const body = await getRuns(s.schedule_id);
    expect(body.ok).toBe(true);
    expect(body.consecutive_failures).toBe(2);
    expect(body.failure_alert_threshold).toBe(5);
    expect(body.last_failure_alert_at).toBeNull();
    expect(body.runs.length).toBe(3);
    const failed = body.runs.find((r: any) => r.run_id === fails[1].runId);
    expect(failed.status).toBe("failed");
    expect(failed.error_code).toBe("task_failed");
    expect(failed.error_message).toContain("safety system");
    expect(failed.error_message.length).toBeLessThanOrEqual(500);
    for (const k of ["scheduled_for", "created_at", "completed_at", "task_id"]) expect(k in failed).toBe(true);
    const ok = body.runs.find((r: any) => r.status === "replied");
    expect(ok.error_message).toBeNull();

    for (let i = 0; i < 3; i++) await runOnce(s);
    const again = await getRuns(s.schedule_id);
    expect(again.consecutive_failures).toBe(5);
    expect(typeof again.last_failure_alert_at).toBe("string");
  });
});
