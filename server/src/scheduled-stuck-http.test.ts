// #464 —— 定时任务被一次没结束的执行卡住:告警 + 超时放行。
//
// 钉住:
//   1. 默认值:超时 = clamp(6 × 间隔, 1h, 24h);环境变量能改。
//   2. 同一个挡路任务连续挡掉 3 次 → 给排程创建者发恰好 1 条通知(别的成员 0 条);第 4、5 次不再发;
//      挡路任务一换(下一次真派出去了)重新上膛。
//   3. 挡路任务开着超过超时 → 它变成 expired(行还在、收件箱行 acked、run 记 expired/task_expired、
//      error_message 说明是调度器超时),这一次照常派发。超时前已发过「卡住」→ 不再发;没发过 → 发一条「已超时」。
//   4. 晚到的回复:send_reply 以 reply_task_terminal 拒掉,旧 run / 旧任务 / 新任务 / 新 run 都不变,创建者不多收东西。
//   5. GET /runs 带 blocked_by_task_id / blocked_by_state。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/scheduled-stuck-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { dispatchScheduledOccurrence, handleScheduledTaskRequest } from "./scheduled-tasks.js";
import { SCHEDULE_STUCK_NOTICE_KIND, stuckTimeoutMs } from "./scheduled-stuck.js";
import { registerTools } from "./tools.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("scheduled-stuck requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now();
const ALIAS = `stuck-node-${stamp}`;
const NODE_ID = `n_stuck_${stamp}`;
let NET = "", creatorId = "", otherId = "";
const ENV_KEYS = ["COMMHUB_SCHEDULE_STUCK_NOTICE_SKIPS", "COMMHUB_SCHEDULE_STUCK_TIMEOUT_FACTOR", "COMMHUB_SCHEDULE_STUCK_TIMEOUT_FLOOR_SEC", "COMMHUB_SCHEDULE_STUCK_TIMEOUT_CAP_SEC"];

function seedSchedule(name = "日报汇总"): any {
  const scheduleId = `sched_${crypto.randomUUID()}`;
  db.run(
    `INSERT INTO scheduled_tasks
       (schedule_id, network_id, created_by, name, target_node_id, target_alias, task_content, priority,
        schedule_type, schedule_json, timezone, status, next_run_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'scheduled task', 'normal', 'interval',
             '{"type":"interval","every_seconds":60}', 'Asia/Shanghai', 'active', datetime('now', '+1 minute'))`,
    [scheduleId, NET, creatorId, name, NODE_ID, ALIAS],
  );
  return db.get("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", scheduleId);
}

let slot = 0;
const nextSlot = () => new Date(Date.UTC(2026, 9, 2, 0, 0, 0) + (++slot) * 60_000).toISOString();
const fire = (schedule: any, now = new Date()) => dispatchScheduledOccurrence(schedule, nextSlot(), false, now);

const notices = (userId: string) => db.all<{ title: string; content: string; meta_json: string; from_session: string }>(
  "SELECT title, content, meta_json, from_session FROM user_inbox WHERE user_id = ?1 AND network_id = ?2 AND kind = ?3 ORDER BY created_at, message_id",
  userId, NET, SCHEDULE_STUCK_NOTICE_KIND,
);
const runRow = (runId: string) => db.get<any>("SELECT * FROM scheduled_task_runs WHERE run_id = ?1", runId);
const taskRow = (taskId: string) => db.get<any>("SELECT * FROM tasks WHERE task_id = ?1", taskId);
/** 把任务的开始时间往前拨(数据库里的 UTC 无时区串)。 */
const backdate = (taskId: string, ms: number) => db.run("UPDATE tasks SET created_at = ?1 WHERE task_id = ?2", [new Date(Date.now() - ms).toISOString().slice(0, 19).replace("T", " "), taskId]);

async function nodeReply(args: Record<string, unknown>): Promise<any> {
  const mcp = new McpServer({ name: "sched-stuck", version: "0" }) as any;
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

beforeAll(() => {
  const creator = register(`stuck_creator_${stamp}`, "StuckCreator123!", undefined, "seed");
  expect(creator.ok).toBe(true);
  NET = creator.network_id!; creatorId = creator.user!.user_id;
  const other = register(`stuck_other_${stamp}`, "StuckOther123!", undefined, "seed");
  otherId = other.user!.user_id;
  expect(addNetworkMember(NET, otherId, "member", creatorId, { agentAccess: "all" }).ok).toBe(true);
  expect(createNetworkTokenForNode(creatorId, NET, ALIAS).ok).toBe(true);
  db.run("INSERT INTO nodes (node_id, node_name, alias, runtime, network_id) VALUES (?1, ?2, ?2, 'claude-code', ?3)", [NODE_ID, ALIAS, NET]);
  db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id) VALUES (?1, ?2, 'idle', ?3, ?4)", [`r_stuck_${stamp}`, ALIAS, NODE_ID, NET]);
});
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  db.run("DELETE FROM user_inbox WHERE network_id = ?1 AND kind = ?2", [NET, SCHEDULE_STUCK_NOTICE_KIND]);
  // 上一个用例留下的开着的任务不许挡这一个(每个用例自己的排程,只按 schedule 查,保险起见也关掉)
  db.run("UPDATE tasks SET status = 'replied' WHERE network_id = ?1 AND status IN ('created', 'delivered', 'acked', 'running')", [NET]);
});
afterEach(() => { for (const k of ENV_KEYS) delete process.env[k]; });
afterAll(() => { db.run("DELETE FROM user_inbox WHERE network_id = ?1 AND kind = ?2", [NET, SCHEDULE_STUCK_NOTICE_KIND]); });

describe("#464 defaults", () => {
  test("timeout = clamp(6 × interval, 1h, 24h)", () => {
    const iv = (s: number) => JSON.stringify({ type: "interval", every_seconds: s });
    expect(stuckTimeoutMs(iv(60))).toBe(3_600_000);
    expect(stuckTimeoutMs(iv(600))).toBe(3_600_000);
    expect(stuckTimeoutMs(iv(1800))).toBe(3 * 3_600_000);
    expect(stuckTimeoutMs(iv(3600))).toBe(6 * 3_600_000);
    expect(stuckTimeoutMs(iv(86_400))).toBe(24 * 3_600_000);
    expect(stuckTimeoutMs(JSON.stringify({ type: "daily", time: "09:00" }))).toBe(24 * 3_600_000);
    expect(stuckTimeoutMs(JSON.stringify({ type: "once", run_at: "2026-10-02T00:00:00Z" }))).toBe(3_600_000);
    process.env.COMMHUB_SCHEDULE_STUCK_TIMEOUT_FACTOR = "0";
    process.env.COMMHUB_SCHEDULE_STUCK_TIMEOUT_FLOOR_SEC = "20";
    expect(stuckTimeoutMs(iv(60))).toBe(20_000);
    process.env.COMMHUB_SCHEDULE_STUCK_TIMEOUT_FLOOR_SEC = "junk";
    expect(stuckTimeoutMs(iv(60))).toBe(3_600_000);
  });
});

describe("#464 stuck notice", () => {
  test("3rd consecutive skip behind the same task → exactly one notice to the creator, none to others", () => {
    const s = seedSchedule();
    const first = fire(s);
    expect(first.status).toBe("delivered");
    const skips = [fire(s), fire(s)];
    expect(notices(creatorId).length).toBe(0);
    skips.push(fire(s), fire(s), fire(s));
    expect(skips.map((r) => r.status)).toEqual(["skipped", "skipped", "skipped", "skipped", "skipped"]);
    const mine = notices(creatorId);
    expect(mine.length).toBe(1);
    expect(notices(otherId).length).toBe(0);
    const n = mine[0];
    expect(n.from_session).toBe(ALIAS);
    expect(n.title).toBe("定时任务被卡住");
    for (const frag of ["日报汇总", first.taskId!, ALIAS, "(Asia/Shanghai)", "3 次", "1 小时"]) expect(n.content).toContain(frag);
    expect(JSON.parse(n.meta_json).schedule_stuck).toEqual({ reason: "stuck", schedule_id: s.schedule_id, blocked_by_task_id: first.taskId, skips: 3 });
  });

  test("re-armed once a run is dispatched again: a second episode notifies again", () => {
    const s = seedSchedule();
    const first = fire(s);
    for (let i = 0; i < 4; i++) fire(s);
    db.run("UPDATE tasks SET status = 'replied', completed_at = datetime('now') WHERE task_id = ?1", [first.taskId]);
    const second = fire(s);
    expect(second.status).toBe("delivered");
    for (let i = 0; i < 3; i++) fire(s);
    const mine = notices(creatorId);
    expect(mine.length).toBe(2);
    // 两条通知同一秒写入,created_at 排不出先后:按挡路任务比集合。
    expect(mine.map((m) => JSON.parse(m.meta_json).schedule_stuck.blocked_by_task_id).sort()).toEqual([first.taskId, second.taskId].sort());
  });

  test("COMMHUB_SCHEDULE_STUCK_NOTICE_SKIPS changes N", () => {
    process.env.COMMHUB_SCHEDULE_STUCK_NOTICE_SKIPS = "1";
    const s = seedSchedule();
    fire(s); fire(s);
    expect(notices(creatorId).length).toBe(1);
  });

  test("schedule without a creator → no notice, skips still recorded", () => {
    const s = seedSchedule();
    db.run("UPDATE scheduled_tasks SET created_by = NULL WHERE schedule_id = ?1", [s.schedule_id]);
    const row = db.get("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", s.schedule_id);
    fire(row); for (let i = 0; i < 4; i++) expect(fire(row).status).toBe("skipped");
    expect(notices(creatorId).length).toBe(0);
  });
});

describe("#464 stuck timeout", () => {
  test("blocker past the timeout is expired (row kept) and this occurrence dispatches; no second notice", () => {
    const s = seedSchedule();
    const first = fire(s);
    db.run("UPDATE tasks SET status = 'running' WHERE task_id = ?1", [first.taskId]);
    for (let i = 0; i < 3; i++) fire(s);
    expect(notices(creatorId).length).toBe(1);

    backdate(first.taskId!, 59 * 60_000);
    expect(fire(s).status).toBe("skipped"); // 59 分钟 < 1 小时
    backdate(first.taskId!, 61 * 60_000);
    const next = fire(s);
    expect(next.status).toBe("delivered");
    expect(next.taskId).not.toBe(first.taskId);

    const old = taskRow(first.taskId!);
    expect(old.status).toBe("expired");
    expect(old.content).toBe("scheduled task");
    expect(db.get<any>("SELECT acked FROM inbox WHERE task_id = ?1", first.taskId).acked).toBeTruthy();
    const oldRun = runRow(first.runId);
    expect(oldRun.status).toBe("expired");
    expect(oldRun.error_code).toBe("task_expired");
    expect(oldRun.error_message).toContain("timed out by the scheduler");
    expect(db.get<any>("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?1 AND to_status = 'expired' AND actor = 'hub-scheduler'", first.taskId).n).toBe(1);
    expect(notices(creatorId).length).toBe(1); // 每段卡住恰好一条
  });

  test("timed out before N skips (long interval) → one 'timed out' notice instead", () => {
    const s = seedSchedule("每日巡检");
    const first = fire(s);
    expect(fire(s).status).toBe("skipped");
    backdate(first.taskId!, 2 * 3_600_000);
    expect(fire(s).status).toBe("delivered");
    const mine = notices(creatorId);
    expect(mine.length).toBe(1);
    expect(mine[0].title).toBe("定时任务已超时放行");
    expect(mine[0].content).toContain(first.taskId!);
    expect(JSON.parse(mine[0].meta_json).schedule_stuck.reason).toBe("timed_out");
  });

  test("a late reply to the expired task is refused and changes nothing", async () => {
    const s = seedSchedule();
    const first = fire(s);
    backdate(first.taskId!, 2 * 3_600_000);
    const next = fire(s);
    expect(next.status).toBe("delivered");
    const inboxBefore = db.get<any>("SELECT COUNT(*) AS n FROM inbox WHERE network_id = ?1", NET).n;
    const out = await nodeReply({ alias: "scheduler", text: "late answer", in_reply_to: first.taskId, status: "replied", from_session: ALIAS });
    expect(out.ok).toBe(false);
    expect(out.error).toBe("reply_task_terminal");
    expect(out.reply_queued).toBe(false);
    expect(taskRow(first.taskId!).status).toBe("expired");
    expect(runRow(first.runId).status).toBe("expired");
    expect(taskRow(next.taskId!).status).toBe("delivered");
    expect(runRow(next.runId).status).toBe("delivered");
    expect(db.get<any>("SELECT COUNT(*) AS n FROM inbox WHERE network_id = ?1", NET).n).toBe(inboxBefore);
    // 新那条照常能被回复,run 照常收尾
    const ok = await nodeReply({ alias: "scheduler", text: "on time", in_reply_to: next.taskId, status: "replied", from_session: ALIAS });
    expect(ok.ok).toBe(true);
    expect(runRow(next.runId).status).toBe("replied");
  });
});

describe("#464 history clarity", () => {
  test("GET /runs exposes blocked_by_task_id and blocked_by_state on skipped rows", async () => {
    const s = seedSchedule();
    const first = fire(s);
    const second = fire(s);
    const url = new URL(`http://hub.test/api/scheduled-tasks/${s.schedule_id}/runs`);
    const res = await handleScheduledTaskRequest({
      req: new Request(url, { method: "GET" }), url,
      auth: { userId: creatorId, networkId: NET, username: "creator" },
      isAdmin: false, isNodeToken: false, scope: { networkId: NET, networkIds: [NET] } as any,
    });
    const body = await res!.json() as any;
    const skipped = body.runs.find((r: any) => r.run_id === second.runId);
    expect(skipped.status).toBe("skipped");
    expect(skipped.blocked_by_task_id).toBe(first.taskId);
    expect(skipped.blocked_by_state).toBe("not_received");
  });
});
