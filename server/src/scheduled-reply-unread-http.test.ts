// 定时任务的回复要进建排程那个人的未读(Vincent 2026-09-30「定时任务触发的…那个红点它是不显示的」)。
//
// scheduler 派的任务 from_name='scheduler',回复以前按 from_name 落进 inbox(session_name='scheduler'):
// app 会话里看得到(会话取自 tasks 表),但 unread_by_agent 只数 session_name=用户名 的行 ⇒ 永远没红点。
// 这里走真 Hub(bootServer)+ 真节点令牌回复路径(send_reply,callerTokenIsNetwork=true)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";
import { runDueScheduledTasks } from "./scheduled-tasks.js";
import { registerTools } from "./tools.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("scheduled-reply-unread requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

let server: any;
let base = "";
let ownerToken = "";
let ownerName = "";
let memberToken = "";
let memberName = "";
let networkId = "";
let ownerId = "";
const stamp = Date.now();
const ALIAS = `sched-reply-node-${stamp}`;
const nodeId = `n_sched_reply_${stamp}`;

async function api(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  return { status: res.status, body: await res.json() as any };
}

/** 节点令牌身份调 send_reply(与真节点的 commhub_reply 同一个 handler、同一组归属校验)。 */
async function nodeReply(args: Record<string, unknown>): Promise<any> {
  const mcp = new McpServer({ name: "sched-reply", version: "0" }) as any;
  const handlers: Record<string, (a: any) => Promise<any>> = {};
  const original = mcp.tool.bind(mcp);
  mcp.tool = (name: string, ...rest: any[]) => {
    const handler = rest.at(-1);
    if (typeof handler === "function") handlers[name] = handler;
    return original(name, ...rest);
  };
  registerTools(mcp, undefined, networkId, ownerId, ALIAS, true, null);
  const out = await handlers.send_reply(args);
  return JSON.parse(out.content[0].text);
}

async function unreadFor(token: string): Promise<Record<string, number>> {
  const res = await api(token, "/api/messages?scope=user&limit=50");
  expect(res.status).toBe(200);
  return res.body.unread_by_agent ?? {};
}

async function ackAgent(token: string) {
  const res = await api(token, "/api/messages/ack", { method: "POST", body: JSON.stringify({ agent: ALIAS }) });
  expect(res.status).toBe(200);
  return res.body;
}

/** 建一个排程、让它立刻到期、跑一次,返回它派出的 task_id。 */
async function fireSchedule(token: string, name: string): Promise<{ scheduleId: string; taskId: string }> {
  const created = await api(token, "/api/scheduled-tasks", {
    method: "POST",
    body: JSON.stringify({
      network_id: networkId, name, target_node_id: nodeId, task: `${name} tick`,
      timezone: "UTC", schedule: { type: "interval", every_seconds: 120 },
    }),
  });
  expect(created.status).toBe(201);
  const scheduleId = created.body.schedule.schedule_id as string;
  // 别的排程不许在这次 sweep 里一起跑
  db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id != ?2", [new Date(Date.now() + 24 * 3600_000).toISOString(), scheduleId]);
  db.run("UPDATE scheduled_tasks SET next_run_at = ?1 WHERE schedule_id = ?2", [new Date(Date.now() - 60_000).toISOString(), scheduleId]);
  await runDueScheduledTasks();
  const run = db.get<{ task_id: string | null }>(
    "SELECT task_id FROM scheduled_task_runs WHERE schedule_id = ?1 ORDER BY scheduled_for DESC LIMIT 1", scheduleId,
  );
  expect(run?.task_id).toBeTruthy();
  const task = db.get<{ from_name: string }>("SELECT from_name FROM tasks WHERE task_id = ?1", run!.task_id!);
  expect(task?.from_name).toBe("scheduler");
  return { scheduleId, taskId: run!.task_id! };
}

function replyRow(taskId: string) {
  return db.get<{ session_name: string; from_session: string; acked: number }>(
    "SELECT session_name, from_session, acked FROM inbox WHERE type = 'reply' AND in_reply_to = ?1", taskId,
  );
}

beforeAll(async () => {
  ownerName = `sched_reply_owner_${stamp}`;
  const owner = register(ownerName, "SchedReplyOwner123!", undefined, "seed");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  networkId = owner.network_id!;
  ownerId = db.get<{ owner_id: string }>("SELECT owner_id FROM networks WHERE network_id = ?1", networkId)!.owner_id;

  memberName = `sched_reply_member_${stamp}`;
  const member = register(memberName, "SchedReplyMember123!", undefined, "seed");
  expect(member.ok).toBe(true);
  memberToken = member.token!;
  const memberId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", memberName)!.user_id;
  expect(addNetworkMember(networkId, memberId, "member", ownerId, { agentAccess: "all" }).ok).toBe(true);

  expect(createNetworkTokenForNode(ownerId, networkId, ALIAS).ok).toBe(true);
  db.run(
    "INSERT INTO nodes (node_id, node_name, alias, runtime, network_id) VALUES (?1, ?2, ?2, 'claude-code', ?3)",
    [nodeId, ALIAS, networkId],
  );
  db.run(
    "INSERT INTO sessions (resume_id, alias, status, node_id, network_id) VALUES (?1, ?2, 'idle', ?3, ?4)",
    [`r_sched_reply_${stamp}`, ALIAS, nodeId, networkId],
  );
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
});

describe("scheduled-task replies reach the schedule creator's unread", () => {
  test("a direct reply still lands on the sender and counts once", async () => {
    await ackAgent(ownerToken);
    const sent = await api(ownerToken, "/api/task", { method: "POST", body: JSON.stringify({ network_id: networkId, alias: ALIAS, task: "direct hello" }) });
    expect(sent.status).toBe(200);
    const taskId = sent.body.task_id as string;
    const reply = await nodeReply({ in_reply_to: taskId, text: "direct answer", status: "replied" });
    expect(reply.ok).toBe(true);
    expect(replyRow(taskId)?.session_name).toBe(ownerName);
    expect((await unreadFor(ownerToken))[ALIAS]).toBe(1);
    await ackAgent(ownerToken);
    expect((await unreadFor(ownerToken))[ALIAS]).toBeUndefined();
  });

  test("a scheduled-task reply counts for the creator, and ack-by-agent clears it", async () => {
    await ackAgent(ownerToken);
    const { taskId } = await fireSchedule(ownerToken, "owner-every-2m");
    // 节点不带 alias(SDK 运行时)——收件人由 in_reply_to 推出
    const reply = await nodeReply({ in_reply_to: taskId, text: "tick answer", status: "replied" });
    expect(reply.ok).toBe(true);
    expect(replyRow(taskId)).toEqual({ session_name: ownerName, from_session: ALIAS, acked: 0 });
    expect(db.get<{ status: string; result: string }>("SELECT status, result FROM tasks WHERE task_id = ?1", taskId))
      .toEqual({ status: "replied", result: "tick answer" });
    expect((await unreadFor(ownerToken))[ALIAS]).toBe(1);

    const acked = await ackAgent(ownerToken);
    expect(acked.acked_inbox).toBe(1);
    expect((await unreadFor(ownerToken))[ALIAS]).toBeUndefined();
    expect(replyRow(taskId)?.acked).toBe(1);
  });

  test("a node that names alias='scheduler' explicitly is routed the same way", async () => {
    await ackAgent(ownerToken);
    const { taskId } = await fireSchedule(ownerToken, "owner-explicit-alias");
    const reply = await nodeReply({ alias: "scheduler", in_reply_to: taskId, text: "explicit answer", status: "replied" });
    expect(reply.ok).toBe(true);
    expect(replyRow(taskId)?.session_name).toBe(ownerName);
    expect((await unreadFor(ownerToken))[ALIAS]).toBe(1);
    await ackAgent(ownerToken);
  });

  test("another member of the network does not get the owner's scheduled reply, and gets their own", async () => {
    await ackAgent(ownerToken);
    await ackAgent(memberToken);
    const ownerRun = await fireSchedule(ownerToken, "owner-only");
    expect((await nodeReply({ in_reply_to: ownerRun.taskId, text: "for owner", status: "replied" })).ok).toBe(true);
    expect((await unreadFor(memberToken))[ALIAS]).toBeUndefined();
    expect((await unreadFor(ownerToken))[ALIAS]).toBe(1);

    const memberRun = await fireSchedule(memberToken, "member-only");
    expect((await nodeReply({ in_reply_to: memberRun.taskId, text: "for member", status: "replied" })).ok).toBe(true);
    expect(replyRow(memberRun.taskId)?.session_name).toBe(memberName);
    expect((await unreadFor(memberToken))[ALIAS]).toBe(1);
    expect((await unreadFor(ownerToken))[ALIAS]).toBe(1);
    await ackAgent(ownerToken);
    await ackAgent(memberToken);
  });

  test("a schedule with no creator falls back to 'scheduler'", async () => {
    await ackAgent(ownerToken);
    const { scheduleId, taskId } = await fireSchedule(ownerToken, "creatorless");
    db.run("UPDATE scheduled_tasks SET created_by = NULL WHERE schedule_id = ?1", [scheduleId]);
    expect((await nodeReply({ in_reply_to: taskId, text: "nobody's", status: "replied" })).ok).toBe(true);
    expect(replyRow(taskId)?.session_name).toBe("scheduler");
    expect((await unreadFor(ownerToken))[ALIAS]).toBeUndefined();
  });

  test("a creator whose username is also a node alias falls back to 'scheduler' (the collision guard)", async () => {
    await ackAgent(ownerToken);
    const { taskId } = await fireSchedule(ownerToken, "colliding-creator");
    const clashNodeId = `n_clash_${stamp}`;
    db.run(
      "INSERT INTO nodes (node_id, node_name, alias, runtime, network_id) VALUES (?1, ?2, ?2, 'claude-code', ?3)",
      [clashNodeId, ownerName, networkId],
    );
    try {
      expect((await nodeReply({ in_reply_to: taskId, text: "not a todo", status: "replied" })).ok).toBe(true);
      // 那个同名节点收不到这条(它不是节点的待办),用户名也拿不到(inbox 半边整体跳过)
      expect(replyRow(taskId)?.session_name).toBe("scheduler");
      expect(db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM inbox WHERE session_name = ?1 AND in_reply_to = ?2", ownerName, taskId,
      )?.n).toBe(0);
    } finally {
      db.run("DELETE FROM nodes WHERE node_id = ?1", [clashNodeId]);
    }
  });
});
