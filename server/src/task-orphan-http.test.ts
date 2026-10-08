// #758 —— 孤儿任务:acked / running 超过阈值,接收节点在开工之后回到 idle / offline 却没回复。
// HTTP 集成测试(真实 Bun.serve,私有端口,临时库);test2123 在真实 PostgreSQL 上原样再跑一遍。
//
// 任务经真入口 POST /api/task 派出,目标用自己的节点令牌经 /mcp ack_inbox / report_status 推进;
// 只把任务的时间戳往前拨,然后调巡检(server.ts patrolOrphanTasks,5 分钟定时器调的就是它)。
//
// 钉住:
//   1. 孤儿(agent 派的)→ 记一条 task.orphan_suspected、发一条 inbox reply 给派活节点,任务状态不变;第二次巡检不重发。
//   2. 人派的孤儿 → user_inbox 一条。
//   3. 节点 working → 不标。
//   4. 不到阈值 → 不标;阈值可由 COMMHUB_ORPHAN_TASK_MINUTES 改,0 = 关。
//   5. 节点开工之后没再报过状态 → 不标。
//   6. scheduler 派的孤儿 → 标,但不通知。
//   7. TTL 巡检(patrolExpiredTasks)不碰孤儿阶段:不写 orphan 事件。
//
// 跑法:cd server && bun test src/task-orphan-http.test.ts

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-orphan-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
process.env.HOST = "127.0.0.1";
const ENV = "COMMHUB_ORPHAN_TASK_MINUTES";
const LOOKBACK_ENV = "COMMHUB_ORPHAN_TASK_LOOKBACK_HOURS";
delete process.env[ENV];
delete process.env[LOOKBACK_ENV];
const PW = "Orphan123!xyz";
const stamp = Date.now();

let db: any;
let patrol: () => void;
let ttlPatrol: () => void;
let flag: (o?: { minutes?: number | null }) => Array<{ task_id: string; notified: string | null }>;
let hub: any = null;
let BASE = "";
let NET = "";
let umaToken = "", umaId = "";
let EVENT = "";
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
async function dispatch(token: string): Promise<{ id: string; content: string }> {
  const content = `orphan case ${stamp} #${++seq}`;
  const r = await send(token, "POST", "/api/task", { alias: nodes.target.alias, task: content, network_id: NET });
  expect(r.status).toBe(200);
  expect(r.body.ok).toBe(true);
  return { id: r.body.task_id, content };
}
async function ack(taskId: string) {
  const r = await tool(nodes.target.token, "ack_inbox", { alias: nodes.target.alias, message_id: taskId, network_id: NET });
  expect(r.ok).toBe(true);
  expect(taskRow(taskId).status).toBe("acked");
}
async function targetStatus(status: string, task?: string) {
  const r = await tool(nodes.target.token, "report_status", { resume_id: `sdk-${nodes.target.nodeId}`, alias: nodes.target.alias, status, task, node_id: nodes.target.nodeId, network_id: NET });
  expect(r.ok).toBe(true);
}
/** 任务的时间戳拨到 `minutes` 分钟前(节点的 last_seen_at 不动 = 「之后还报过状态」)。 */
function age(taskId: string, minutes: number) {
  const off = `-${minutes * 60} seconds`;
  db.run(
    `UPDATE tasks SET created_at = datetime('now', ?2),
        delivered_at = CASE WHEN delivered_at IS NULL THEN NULL ELSE datetime('now', ?2) END,
        started_at = CASE WHEN started_at IS NULL THEN NULL ELSE datetime('now', ?2) END,
        consumed_at = CASE WHEN consumed_at IS NULL THEN NULL ELSE datetime('now', ?2) END
      WHERE task_id = ?1`,
    [taskId, off],
  );
}
const taskRow = (taskId: string) => db.get("SELECT status, result, completed_at FROM tasks WHERE task_id = ?1", taskId) as { status: string; result: string | null; completed_at: string | null };
const orphanEvents = (taskId: string) => db.all("SELECT from_status, to_status, event_type, event_key, actor, detail FROM task_events WHERE task_id = ?1 AND event_type = ?2", taskId, EVENT) as any[];
const agentNotices = () => db.all("SELECT in_reply_to, type, requires_response, content FROM inbox WHERE network_id = ?1 AND session_name = ?2 AND from_session = 'hub'", NET, nodes.sender.alias) as any[];
const userNotices = () => db.all("SELECT kind, from_session, content FROM user_inbox WHERE network_id = ?1 AND user_id = ?2", NET, umaId) as any[];

function withMinutes<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env[ENV];
  if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
  try { return fn(); } finally { if (prev === undefined) delete process.env[ENV]; else process.env[ENV] = prev; }
}

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { addNetworkMember, createNetworkTokenForNode, register } = await import("./auth.js");
  const orphan: any = await import("./task-orphan.js");
  EVENT = orphan.ORPHAN_EVENT_TYPE;
  flag = orphan.flagOrphanTasks;
  const boss = register(`orphan_boss_${stamp}`, PW);
  expect(boss.ok).toBe(true);
  NET = boss.network_id!;
  const bossId = boss.user!.user_id;
  const uma = register(`orphan_uma_${stamp}`, PW);
  umaToken = uma.token!; umaId = uma.user!.user_id;
  expect(addNetworkMember(NET, umaId, "member", bossId, { agentAccess: "all" }).ok).toBe(true);
  for (const key of ["sender", "target"] as const) {
    const alias = `orphan-${key}-${stamp}`;
    const nodeId = `n_orphan_${key}_${stamp}`;
    const minted = createNetworkTokenForNode(bossId, NET, alias, nodeId);
    expect(minted.ok).toBe(true);
    nodes[key] = { alias, nodeId, token: minted.token! };
  }
  const mod: any = await import("./server.js");
  patrol = mod.patrolOrphanTasks;
  ttlPatrol = mod.patrolExpiredTasks;
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  for (const n of Object.values(nodes)) {
    const r = await tool(n.token, "report_status", { resume_id: `sdk-${n.nodeId}`, alias: n.alias, status: "idle", node_id: n.nodeId, network_id: NET });
    expect(r.ok).toBe(true);
  }
}, 30_000);

beforeEach(() => {
  db.run("UPDATE tasks SET status = 'replied', completed_at = datetime('now') WHERE network_id = ?1 AND status IN ('created', 'delivered', 'acked', 'running')", [NET]);
  db.run("DELETE FROM inbox WHERE network_id = ?1 AND from_session = 'hub'", [NET]);
  db.run("DELETE FROM user_inbox WHERE network_id = ?1", [NET]);
  // 上一条用例可能把目标留在 offline / working:派活前先让它回到 idle(否则 /api/task 回 202 排队)。
  db.run("UPDATE sessions SET status = 'idle' WHERE alias = ?1 AND network_id = ?2", [nodes.target.alias, NET]);
});

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#758 orphan detected", () => {
  test("acked 2h, node idle since → one event + one inbox reply to the sending agent; status unchanged; second pass silent", async () => {
    const t = await dispatch(nodes.sender.token);
    await ack(t.id);
    age(t.id, 120);
    await targetStatus("idle");

    withMinutes(undefined, () => patrol());

    expect(taskRow(t.id)).toMatchObject({ status: "acked", result: null, completed_at: null });
    const ev = orphanEvents(t.id);
    expect(ev.length).toBe(1);
    expect(ev[0]).toMatchObject({ from_status: "acked", to_status: "acked", event_key: EVENT, actor: "patrol" });
    expect(ev[0].detail).toContain(`notify: agent ${nodes.sender.alias}`);
    const n = agentNotices();
    expect(n.length).toBe(1);
    expect(n[0]).toMatchObject({ in_reply_to: t.id, type: "reply", requires_response: "none" });
    expect(n[0].content).toContain(nodes.target.alias);
    expect(n[0].content).toContain("没有改这条任务的状态");

    // 第二、三次巡检:不重发、不重记。
    withMinutes(undefined, () => { patrol(); patrol(); });
    expect(orphanEvents(t.id).length).toBe(1);
    expect(agentNotices().length).toBe(1);
    expect(taskRow(t.id).status).toBe("acked");
  });

  test("running task, node went offline afterwards → flagged; a human sender gets one user_inbox notice", async () => {
    const t = await dispatch(umaToken);
    await ack(t.id);
    await targetStatus("working", t.content);
    expect(taskRow(t.id).status).toBe("running");
    age(t.id, 90);
    await targetStatus("idle");
    db.run("UPDATE sessions SET status = 'offline' WHERE alias = ?1 AND network_id = ?2", [nodes.target.alias, NET]);

    const out = withMinutes(undefined, () => flag());
    expect(out).toEqual([{ task_id: t.id, notified: "user" }]);
    expect(taskRow(t.id).status).toBe("running");
    const u = userNotices();
    expect(u.length).toBe(1);
    expect(u[0]).toMatchObject({ kind: "task_orphan_suspected", from_session: nodes.target.alias });
    expect(withMinutes(undefined, () => flag())).toEqual([]);
    expect(userNotices().length).toBe(1);
  });
});

describe("#758 not orphans", () => {
  test("node is working (busy) → not flagged", async () => {
    const t = await dispatch(nodes.sender.token);
    await ack(t.id);
    age(t.id, 120);
    await targetStatus("working", "something else");
    withMinutes(undefined, () => patrol());
    expect(orphanEvents(t.id).length).toBe(0);
    expect(agentNotices().length).toBe(0);
  });

  test("younger than the threshold → not flagged; env lowers it; 0 turns it off", async () => {
    const t = await dispatch(nodes.sender.token);
    await ack(t.id);
    age(t.id, 45);
    await targetStatus("idle");
    withMinutes(undefined, () => patrol());
    expect(orphanEvents(t.id).length).toBe(0);
    withMinutes("0", () => patrol());
    expect(orphanEvents(t.id).length).toBe(0);
    withMinutes("30", () => patrol());
    expect(orphanEvents(t.id).length).toBe(1);
    expect(agentNotices().length).toBe(1);
  });

  test("node has not reported any status since the task started → not flagged", async () => {
    const t = await dispatch(nodes.sender.token);
    await ack(t.id);
    age(t.id, 120);
    await targetStatus("idle");
    db.run("UPDATE sessions SET last_seen_at = datetime('now', '-180 minutes'), updated_at = datetime('now', '-180 minutes') WHERE alias = ?1 AND network_id = ?2", [nodes.target.alias, NET]);
    withMinutes(undefined, () => patrol());
    expect(orphanEvents(t.id).length).toBe(0);
    expect(agentNotices().length).toBe(0);
  });
});

describe("#758 lookback cap", () => {
  test("a 10-day-old orphan is not flagged by default (72h cap) but is with lookback 0", async () => {
    // 10 天前的那条直接写库(目标上已有开着的任务时 /api/task 回 202 排队,而这里要两条同时开着)。
    const t = { id: `orphan_old_${stamp}` };
    db.run(
      `INSERT INTO tasks (task_id, from_name, from_node_id, to_name, to_node_id, priority, status, content, requires_response, created_at, delivered_at, network_id)
       VALUES (?1, ?2, ?3, ?4, ?5, 'normal', 'acked', 'ten days old', 'reply', datetime('now', '-240 hours'), datetime('now', '-240 hours'), ?6)`,
      [t.id, nodes.sender.alias, nodes.sender.nodeId, nodes.target.alias, nodes.target.nodeId, NET],
    );
    await targetStatus("idle");
    withMinutes(undefined, () => patrol());
    expect(orphanEvents(t.id).length).toBe(0);
    expect(agentNotices().length).toBe(0);
    // 71 小时的照常标出:上限只挡更老的。
    const recent = await dispatch(nodes.sender.token);
    await ack(recent.id);
    age(recent.id, 71 * 60);
    await targetStatus("idle");
    withMinutes(undefined, () => patrol());
    expect(orphanEvents(recent.id).length).toBe(1);
    expect(orphanEvents(t.id).length).toBe(0);
    process.env[LOOKBACK_ENV] = "0";
    try { withMinutes(undefined, () => patrol()); } finally { delete process.env[LOOKBACK_ENV]; }
    expect(orphanEvents(t.id).length).toBe(1);
    expect(agentNotices().map((n) => n.in_reply_to).sort()).toEqual([recent.id, t.id].sort());
  });
});

describe("#758 scheduler and regression", () => {
  test("scheduler-sent orphan → flagged, sender not notified", async () => {
    const id = `orphan_sched_${stamp}`;
    db.run(
      `INSERT INTO tasks (task_id, from_name, to_name, to_node_id, priority, status, content, requires_response, created_at, delivered_at, network_id)
       VALUES (?1, 'scheduler', ?2, ?3, 'normal', 'acked', 'scheduled run', 'reply', datetime('now', '-120 minutes'), datetime('now', '-120 minutes'), ?4)`,
      [id, nodes.target.alias, nodes.target.nodeId, NET],
    );
    await targetStatus("idle");
    const out = withMinutes(undefined, () => flag());
    expect(out).toEqual([{ task_id: id, notified: null }]);
    expect(orphanEvents(id)[0].detail).toContain("notify: none (scheduler)");
    expect(agentNotices().length).toBe(0);
    expect(userNotices().length).toBe(0);
  });

  test("the TTL patrol alone does not run the orphan phase", async () => {
    const t = await dispatch(nodes.sender.token);
    await ack(t.id);
    age(t.id, 120);
    await targetStatus("idle");
    withMinutes(undefined, () => ttlPatrol());
    expect(orphanEvents(t.id).length).toBe(0);
    expect(taskRow(t.id).status).toBe("acked");
  });
});
