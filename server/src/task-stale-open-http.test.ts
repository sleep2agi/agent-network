// #519 —— 已开工(acked / running)却再无动静的任务由巡检结束为 expired;默认关闭。
// 外加 #2322 的遗留缺陷:过期通知里「前面还有几个」没有时间下界,把几个月前被遗弃的 acked 行全算进去。
// HTTP 集成测试(真实 Bun.serve,私有端口,临时库);test2123 在真实 PostgreSQL 上原样再跑一遍。
//
// 任务一律经真入口 POST /api/task 派出,目标用自己的节点令牌经 /mcp ack_inbox(→ acked)、
// report_status(working, task=原文)(→ running)推进;只把时间戳(tasks 的各列 + 它的 task_events)往前拨,
// 然后调巡检(server.ts patrolExpiredTasks,定时器调的就是它)。迟到的回复走 /mcp send_reply。
//
// 钉住:
//   1. 未设 COMMHUB_STALE_OPEN_TASK_HOURS → 什么都不变;设成 0 → 同样关闭。
//   2. 设 72:71 小时无动静的留着,73 小时的结束为 expired,result 带原因,task_events 记 task.stale_expired。
//   3. running 但 consumed_at 是最近的 → 留着;最近有 task_event 的 acked → 留着。
//   4. 每次巡检最多 500 行,先结束最老的;下一次巡检接着来。
//   5. 不通知派活的一方(agent inbox / user_inbox 都没有)。
//   6. 之后对它的 send_reply 被拒:reply_task_terminal。
//   7. (#2322 缺陷)过期通知的「前面还有几个」只数 24 小时内的开着任务。
//
// 跑法:cd server && bun test src/task-stale-open-http.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-stale-open-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";
const ENV = "COMMHUB_STALE_OPEN_TASK_HOURS";
delete process.env[ENV];
const PW = "StaleOpen123!x";
const stamp = Date.now();

let db: any;
let patrol: () => void;
let hub: any = null;
let BASE = "";
let NET = "";
let bossToken = "", umaToken = "", umaId = "";
let EVENT = "", LIMIT = 0;
type Node = { alias: string; nodeId: string; token: string };
const nodes: Record<"sender" | "target", Node> = {} as any;

async function send(token: string, method: string, path: string, payload?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter((x) => x.startsWith("data:"));
  const payload = data.length ? JSON.parse(data.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  return JSON.parse(payload.result.content[0].text);
}

let seq = 0;
/** 经 POST /api/task 派一条;返回 { id, content }。 */
async function dispatch(token: string, to: string): Promise<{ id: string; content: string }> {
  const content = `stale case ${stamp} #${++seq}`;
  const r = await send(token, "POST", "/api/task", { alias: to, task: content, network_id: NET });
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  return { id: r.body.task_id, content };
}
/** 目标经 /mcp ack_inbox 收下 → acked。 */
async function ack(taskId: string) {
  const r = await tool(nodes.target.token, "ack_inbox", { alias: nodes.target.alias, message_id: taskId, network_id: NET });
  expect(r.ok).toBe(true);
  expect(taskRow(taskId).status).toBe("acked");
}
/** 目标经 /mcp report_status(working, task=原文)开工 → running。 */
async function run(t: { id: string; content: string }) {
  await ack(t.id);
  const r = await tool(nodes.target.token, "report_status", { resume_id: `sdk-${nodes.target.nodeId}`, alias: nodes.target.alias, status: "working", task: t.content, node_id: nodes.target.nodeId, network_id: NET });
  expect(r.ok).toBe(true);
  expect(taskRow(t.id).status).toBe("running");
}
/** 把这条任务所有的时间戳(含它的 task_events)拨到 `hours` 小时前。 */
function age(taskId: string, hours: number) {
  const off = `-${Math.round(hours * 3600)} seconds`;
  db.run(
    `UPDATE tasks SET created_at = datetime('now', ?2),
        delivered_at = CASE WHEN delivered_at IS NULL THEN NULL ELSE datetime('now', ?2) END,
        started_at = CASE WHEN started_at IS NULL THEN NULL ELSE datetime('now', ?2) END,
        consumed_at = CASE WHEN consumed_at IS NULL THEN NULL ELSE datetime('now', ?2) END,
        runtime_submitted_at = CASE WHEN runtime_submitted_at IS NULL THEN NULL ELSE datetime('now', ?2) END,
        expires_at = datetime('now', ?2)
      WHERE task_id = ?1`,
    [taskId, off],
  );
  db.run("UPDATE task_events SET created_at = datetime('now', ?2) WHERE task_id = ?1", [taskId, off]);
}
const taskRow = (taskId: string) => db.get("SELECT status, result, completed_at FROM tasks WHERE task_id = ?1", taskId) as { status: string; result: string | null; completed_at: string | null };
const staleEvents = (taskId: string) => db.all("SELECT from_status, to_status, event_type, actor, detail FROM task_events WHERE task_id = ?1 AND event_type = ?2", taskId, EVENT) as any[];
const hubNotices = () => Number((db.get("SELECT COUNT(*) AS n FROM inbox WHERE network_id = ?1 AND from_session = 'hub'", NET) as { n: number }).n);
const userNotices = () => Number((db.get("SELECT COUNT(*) AS n FROM user_inbox WHERE network_id = ?1 AND user_id = ?2", NET, umaId) as { n: number }).n);

function withHours<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[ENV];
  if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev; }
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { addNetworkMember, createNetworkTokenForNode, register } = await import("./auth.js");
  ({ STALE_OPEN_EVENT_TYPE: EVENT, STALE_OPEN_BATCH_LIMIT: LIMIT } = await import("./task-stale-open.js"));
  const boss = register(`stale_boss_${stamp}`, PW);
  expect(boss.ok).toBe(true);
  bossToken = boss.token!; NET = boss.network_id!;
  const bossId = boss.user!.user_id;
  const uma = register(`stale_uma_${stamp}`, PW);
  umaToken = uma.token!; umaId = uma.user!.user_id;
  expect(addNetworkMember(NET, umaId, "member", bossId, { agentAccess: "all" }).ok).toBe(true);
  for (const key of ["sender", "target"] as const) {
    const alias = `stale-${key}-${stamp}`;
    const nodeId = `n_stale_${key}_${stamp}`;
    const minted = createNetworkTokenForNode(bossId, NET, alias, nodeId);
    expect(minted.ok).toBe(true);
    nodes[key] = { alias, nodeId, token: minted.token! };
  }
  const mod: any = await import("./server.js");
  patrol = mod.patrolExpiredTasks;
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  for (const n of Object.values(nodes)) {
    const r = await tool(n.token, "report_status", { resume_id: `sdk-${n.nodeId}`, alias: n.alias, status: "idle", node_id: n.nodeId, network_id: NET });
    expect(r.ok).toBe(true);
  }
}, 30_000);

beforeEach(() => {
  // 每条用例自己的数据:上一条留下的开着的任务不许被这一次巡检碰到,也不许算进「前面还有几个」。
  db.run("UPDATE tasks SET status = 'replied', completed_at = datetime('now') WHERE network_id = ?1 AND status IN ('created', 'delivered', 'acked', 'running')", [NET]);
  db.run("DELETE FROM inbox WHERE network_id = ?1 AND from_session = 'hub'", [NET]);
  db.run("DELETE FROM user_inbox WHERE network_id = ?1", [NET]);
});

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#519 off by default", () => {
  test("env unset → a 30-day-old acked and running task stay open, no event", async () => {
    const a = await dispatch(nodes.sender.token, nodes.target.alias);
    await ack(a.id);
    const r = await dispatch(nodes.sender.token, nodes.target.alias);
    await run(r);
    age(a.id, 720); age(r.id, 720);
    withHours(undefined, () => patrol());
    expect(taskRow(a.id).status).toBe("acked");
    expect(taskRow(r.id).status).toBe("running");
    expect(staleEvents(a.id).length + staleEvents(r.id).length).toBe(0);
  });

  test("0 (and garbage) disable it too", async () => {
    const a = await dispatch(nodes.sender.token, nodes.target.alias);
    await ack(a.id);
    age(a.id, 720);
    for (const v of ["0", "-5", "abc", ""]) withHours(v, () => patrol());
    expect(taskRow(a.id).status).toBe("acked");
    expect(staleEvents(a.id).length).toBe(0);
  });
});

describe("#519 at 72h", () => {
  test("71h stays open; 73h acked/running → expired with reason + task.stale_expired; no sender notice", async () => {
    const young = await dispatch(nodes.sender.token, nodes.target.alias);
    await ack(young.id);
    const old = await dispatch(nodes.sender.token, nodes.target.alias);
    await ack(old.id);
    const oldRun = await dispatch(umaToken, nodes.target.alias); // 人派的:同样不通知
    await run(oldRun);
    // send_ack 只改任务状态、不动 inbox:它的 inbox 行还是未确认,巡检要一并确认掉。
    const viaSendAck = await dispatch(nodes.sender.token, nodes.target.alias);
    const sa = await tool(nodes.target.token, "send_ack", { task_id: viaSendAck.id, network_id: NET });
    expect(sa.ok).toBe(true);
    expect(taskRow(viaSendAck.id).status).toBe("acked");
    const unackedInbox = (id: string) => Number((db.get("SELECT COUNT(*) AS n FROM inbox WHERE COALESCE(task_id, id) = ?1 AND acked = 0", id) as any).n);
    expect(unackedInbox(viaSendAck.id)).toBe(1);
    age(young.id, 71); age(old.id, 73); age(oldRun.id, 73); age(viaSendAck.id, 73);

    withHours("72", () => patrol());

    expect(taskRow(young.id).status).toBe("acked");
    const o = taskRow(old.id);
    expect(o.status).toBe("expired");
    expect(o.completed_at).toBeTruthy();
    expect(o.result).toBe("stale: no activity for 72h (was acked) — closed by hub patrol (#519)");
    expect(taskRow(oldRun.id)).toMatchObject({ status: "expired", result: "stale: no activity for 72h (was running) — closed by hub patrol (#519)" });
    expect(staleEvents(old.id)).toEqual([{ from_status: "acked", to_status: "expired", event_type: EVENT, actor: "patrol", detail: o.result }]);
    expect(staleEvents(oldRun.id).map((e) => e.from_status)).toEqual(["running"]);
    expect(taskRow(viaSendAck.id).status).toBe("expired");
    expect(unackedInbox(viaSendAck.id)).toBe(0);
    // 不是 TTL 过期:不多写一条 task.expired。
    expect(Number((db.get("SELECT COUNT(*) AS n FROM task_events WHERE task_id = ?1 AND event_type = 'task.expired'", old.id) as any).n)).toBe(0);
    // 不通知派活的一方:agent inbox 没有 hub 的行,人的 user_inbox 也没有。
    expect(hubNotices()).toBe(0);
    expect(userNotices()).toBe(0);
    // 再巡检一次:幂等,不重复记事件。
    withHours("72", () => patrol());
    expect(staleEvents(old.id).length).toBe(1);
  });

  test("recent activity keeps it open: fresh consumed_at on running, fresh task_event on acked", async () => {
    const r = await dispatch(nodes.sender.token, nodes.target.alias);
    await run(r);
    age(r.id, 720);
    db.run("UPDATE tasks SET consumed_at = datetime('now', '-1 hours') WHERE task_id = ?1", [r.id]);
    const a = await dispatch(nodes.sender.token, nodes.target.alias);
    await ack(a.id);
    age(a.id, 720);
    db.run(
      "INSERT INTO task_events (task_id, from_status, to_status, event_type, actor, network_id, created_at) VALUES (?1, 'acked', 'acked', 'task.note', 'test', ?2, datetime('now', '-1 hours'))",
      [a.id, NET],
    );
    withHours("72", () => patrol());
    expect(taskRow(r.id).status).toBe("running");
    expect(taskRow(a.id).status).toBe("acked");
  });

  test("a late reply to a stale-expired task is rejected as terminal", async () => {
    const a = await dispatch(nodes.sender.token, nodes.target.alias);
    await ack(a.id);
    age(a.id, 100);
    withHours("72", () => patrol());
    expect(taskRow(a.id).status).toBe("expired");
    const r = await tool(nodes.target.token, "send_reply", { in_reply_to: a.id, text: "late answer", status: "replied", network_id: NET });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("reply_task_terminal");
    expect(taskRow(a.id).status).toBe("expired");
  });

  test(`at most ${500} rows per pass, oldest first; the next pass continues`, async () => {
    expect(LIMIT).toBe(500);
    const total = LIMIT + 20;
    db.transaction(() => {
      for (let i = 0; i < total; i++) {
        // 批量造数据直接写库(经 /api/task 派 520 条只会更慢,不改变被测路径:巡检只读 tasks / task_events)。
        db.run(
          `INSERT INTO tasks (task_id, from_name, from_node_id, to_name, to_node_id, priority, status, content, requires_response, created_at, delivered_at, expires_at, network_id)
           VALUES (?1, ?2, ?3, ?4, ?5, 'normal', 'acked', 'bulk', 'reply', datetime('now', ?6), datetime('now', ?6), datetime('now', ?6), ?7)`,
          [`stale_bulk_${stamp}_${String(i).padStart(4, "0")}`, nodes.sender.alias, nodes.sender.nodeId, nodes.target.alias, nodes.target.nodeId, `-${(100 + total - i) * 60} minutes`, NET],
        );
      }
    });
    const openBulk = () => Number((db.get("SELECT COUNT(*) AS n FROM tasks WHERE network_id = ?1 AND task_id LIKE 'stale_bulk_%' AND status = 'acked'", NET) as any).n);
    expect(openBulk()).toBe(total);
    withHours("72", () => patrol());
    expect(openBulk()).toBe(20);
    // 最老的先结束:剩下的是最新的 20 条(i = 500..519)。
    const left = (db.all("SELECT task_id FROM tasks WHERE network_id = ?1 AND task_id LIKE 'stale_bulk_%' AND status = 'acked' ORDER BY task_id", NET) as any[]).map((r) => r.task_id);
    expect(left[0]).toBe(`stale_bulk_${stamp}_0500`);
    withHours("72", () => patrol());
    expect(openBulk()).toBe(0);
    expect(hubNotices()).toBe(0);
  }, 60_000);
});

describe("#2322 follow-up: expiry notice counts only open tasks within 24h", () => {
  test("old abandoned acked rows on the target are not 'ahead'", async () => {
    // 3 条几个月前被遗弃的 acked + 1 条 2 小时前的 acked(真的排在前面)。
    for (let i = 0; i < 3; i++) {
      const s = await dispatch(bossToken, nodes.target.alias);
      await ack(s.id);
      age(s.id, 24 * 60 + i);
    }
    const recent = await dispatch(bossToken, nodes.target.alias);
    await ack(recent.id);
    age(recent.id, 2);
    // 一条 61 分钟前派出、1 分钟前到期、没人取的 → TTL 过期,通知发送方。
    const id = (await dispatch(nodes.sender.token, nodes.target.alias)).id;
    db.run("UPDATE tasks SET created_at = datetime('now', '-61 minutes'), delivered_at = datetime('now', '-61 minutes'), expires_at = datetime('now', '-1 minutes') WHERE task_id = ?1", [id]);
    withHours(undefined, () => patrol());
    expect(taskRow(id).status).toBe("expired");
    const n = db.all("SELECT content, meta_json FROM inbox WHERE session_name = ?1 AND network_id = ?2 AND from_session = 'hub'", nodes.sender.alias, NET) as Array<{ content: string; meta_json: string }>;
    expect(n.length).toBe(1);
    expect(JSON.parse(n[0].meta_json).task_expired.queued_ahead).toBe(1);
    expect(n[0].content).toContain("还有 1 个");
  });
});
