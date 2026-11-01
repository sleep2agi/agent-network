// #1828 —— /api/messages?scope=user 按 agent 分的未读 + 用户 ack 覆盖 inbox 里的回复行。
//
// 生产 hub 24h:admin 收到的 70 条 agent 回复全在 `inbox`(session_name='admin', type='reply',
// acked 永远 0),`user_inbox` 只有 2 行;角标链只读 user_inbox,所以回复从不进未读(app#260)。
// 这里让 scope=user 同时给 `unread_by_agent`(两表合并)与 `unread_total`,`unread`/`pending_count`
// 口径不动(qa-hub-14 钉着);POST /api/messages/ack 也能 ack inbox 里发给调用者用户名的回复行。
//
// 承重的是两条边界:
//   ① 只算/只 ack **调用者自己用户名** 的 inbox 行 —— B 拿 A 的 id 来 ack 匹配不到;
//   ② 用户名与某节点 alias 撞名时,inbox 那半边整体跳过(那是节点的待办,不是用户的)。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRIVATE_DB_DIR = mkdtempSync(join(tmpdir(), "anet-user-inbox-by-agent-"));
process.env.COMMHUB_DB ||= join(PRIVATE_DB_DIR, "hub.db");

let server: ReturnType<typeof Bun.serve>;
let base = "";
let aToken = "", bToken = "", cToken = "";
let aUserId = "", bUserId = "", cUserId = "", aNet = "", cNet = "";
let aName = "", bName = "", cName = "";

const get = async (path: string, token: string) => {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() as any };
};
const post = async (path: string, token: string, body: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() as any };
};

function seedUserInbox(mid: string, userId: string, netId: string, from: string) {
  const { db } = require("./db.js");
  db.run(
    `INSERT INTO user_inbox (message_id, network_id, user_id, from_session, kind, title, content, severity, meta_json, acked)
     VALUES (?1, ?2, ?3, ?4, 'agent_message', NULL, 'dm', 'info', NULL, 0)`,
    [mid, netId, userId, from],
  );
}
function seedInbox(id: string, sessionName: string, netId: string, from: string, type = "reply", acked = 0) {
  const { db } = require("./db.js");
  db.run(
    `INSERT INTO inbox (id, session_name, type, priority, content, from_session, acked, network_id, created_at)
     VALUES (?1, ?2, ?3, 'normal', 'reply body', ?4, ?5, ?6, datetime('now'))`,
    [id, sessionName, type, from, acked, netId],
  );
}

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  const { register, addNetworkMember } = await import("./auth.js");
  const stamp = Date.now();

  // 首个注册用户 = 全局 admin;探针 A/B/C 都不是 admin(admin 走不过滤分支,隔离断言会白过)。
  const admin = register(`uba_admin_${stamp}`, "UbaAdmin-Strong-1!");
  expect(admin.ok).toBe(true);
  aName = `uba_a_${stamp}`; bName = `uba_b_${stamp}`; cName = `uba_c_${stamp}`;
  const a = register(aName, "UbaA-Strong-1!");
  const b = register(bName, "UbaB-Strong-1!");
  const c = register(cName, "UbaC-Strong-1!");
  expect(a.ok && b.ok && c.ok).toBe(true);
  aToken = a.token!; bToken = b.token!; cToken = c.token!;
  aNet = a.network_id!; cNet = c.network_id!;
  const uid = (name: string) => db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", name)!.user_id;
  aUserId = uid(aName); bUserId = uid(bName); cUserId = uid(cName);
  for (const id of [aUserId, bUserId, cUserId]) {
    expect(db.get<{ role: string }>("SELECT role FROM users WHERE user_id = ?1", id)?.role).toBe("user");
  }
  // B 与 A 同网:user_id / session_name 过滤是唯一的隔离手段。
  expect(addNetworkMember(aNet, bUserId, "member").ok).toBe(true);

  // A:user_inbox 两条(node-x),inbox 回复两条(peer-1)+ 一条已 ack + 一条 status 类(不算)。
  seedUserInbox("dm_a1", aUserId, aNet, "node-x");
  seedUserInbox("dm_a2", aUserId, aNet, "node-x");
  seedInbox("ib_a1", aName, aNet, "peer-1");
  seedInbox("ib_a2", aName, aNet, "peer-1");
  seedInbox("ib_a_acked", aName, aNet, "peer-1", "reply", 1);
  seedInbox("ib_a_status", aName, aNet, "peer-1", "status");
  // B 同网:自己的一条回复;不该出现在 A 的数里。
  seedInbox("ib_b1", bName, aNet, "peer-2");
  // C:用户名撞节点 alias —— inbox 里那行是节点的待办。
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, datetime('now'), datetime('now'))`,
    [`node_${stamp}`, cName, cName, cNet],
  );
  seedInbox("ib_c_node_task", cName, cNet, "leader", "task");
  seedUserInbox("dm_c1", cUserId, cNet, "node-y");

  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  try { server?.stop(true); } catch {}
  try { rmSync(PRIVATE_DB_DIR, { recursive: true, force: true }); } catch {}
});

describe("#1828 GET /api/messages?scope=user unread_by_agent", () => {
  test("A:user_inbox + inbox 回复按 agent 合并;unread/pending_count 口径不变", async () => {
    const { status, body } = await get("/api/messages?scope=user", aToken);
    expect(status).toBe(200);
    expect(body.unread).toBe(2);                 // 只算 user_inbox(qa-hub-14 钉着)
    expect(body.pending_count).toBe(2);
    expect(body.unread_by_agent).toEqual({ "node-x": 2, "peer-1": 2 }); // 已 ack 与 status 类不算
    expect(body.unread_total).toBe(4);
  });

  test("B(同网):只看到自己的回复,看不到 A 的", async () => {
    const { body } = await get("/api/messages?scope=user", bToken);
    expect(body.unread_by_agent).toEqual({ "peer-2": 1 });
    expect(body.unread_total).toBe(1);
  });

  test("🔴 C 的用户名撞节点 alias:inbox 半边整体跳过,只剩 user_inbox", async () => {
    const { body } = await get("/api/messages?scope=user", cToken);
    expect(body.unread_by_agent).toEqual({ "node-y": 1 });
    expect(body.unread_total).toBe(1);
  });
});

describe("#1828 POST /api/messages/ack covers inbox reply rows", () => {
  test("🔴 B 拿 A 的 inbox id 来 ack:匹配不到,A 的数不动", async () => {
    const { body } = await post("/api/messages/ack", bToken, { message_ids: ["ib_a1"] });
    expect(body).toMatchObject({ ok: true, acked: 0, acked_inbox: 0 });
    // 2026-10-31 —— #3214：ack 的形状钉住（两个分桶 + 总数，客户端按这三个数更新未读角标）
    expect(Object.keys(body).sort()).toEqual(["acked", "acked_inbox", "acked_user_inbox", "ok", "scope"]);
    // 守恒：两个分桶之和 == 总数（否则角标与明细是两个读数）
    expect(body.acked_inbox + body.acked_user_inbox).toBe(body.acked);
    const a = await get("/api/messages?scope=user", aToken);
    expect(a.body.unread_by_agent["peer-1"]).toBe(2);
  });

  test("A ack 一条 inbox 回复 + 一条 user_inbox:两边各减一,响应分开计数", async () => {
    const { body } = await post("/api/messages/ack", aToken, { message_ids: ["ib_a1", "dm_a1"] });
    expect(body).toMatchObject({ ok: true, acked: 2, acked_user_inbox: 1, acked_inbox: 1 });
    const a = await get("/api/messages?scope=user", aToken);
    expect(a.body.unread).toBe(1);
    expect(a.body.unread_by_agent).toEqual({ "node-x": 1, "peer-1": 1 });
    expect(a.body.unread_total).toBe(2);
    // 再 ack 同一条:幂等,0 行。
    const again = await post("/api/messages/ack", aToken, { message_ids: ["ib_a1"] });
    expect(again.body.acked).toBe(0);
  });

  // #3354 —— 拒绝路径：未认证必须 401，且**一条都不许 ack**。
  // 这条路由的门是 `restAuth?.userId`（没有它就没有"我的消息"这个概念）。
  test("🔴 未认证 ⇒ 401，且 A 的未读数一条都不减（拒绝不许有副作用）", async () => {
    const before = await get("/api/messages?scope=user", aToken);
    const res = await fetch(`${base}/api/messages/ack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message_ids: ["ib_a1"] }),
    });
    expect(res.status).toBe(401);
    const after = await get("/api/messages?scope=user", aToken);
    expect(after.body.unread_total).toBe(before.body.unread_total);
  });

  // 同时给 agent 与 message_ids 是歧义的：拒收，且不 ack 任何一边
  test("🔴 {agent} 与 {message_ids} 同给 ⇒ 400 ambiguous_ack，且两边都不动", async () => {
    const before = await get("/api/messages?scope=user", aToken);
    const { status, body } = await post("/api/messages/ack", aToken, { agent: "peer-1", message_ids: ["ib_a1"] }) as any;
    expect(status).toBe(400);
    expect(body.error).toBe("ambiguous_ack");
    const after = await get("/api/messages?scope=user", aToken);
    expect(after.body.unread_total).toBe(before.body.unread_total);
  });

  test("status 类 inbox 行不会被用户 ack 掉(不是发给用户的消息)", async () => {
    const { body } = await post("/api/messages/ack", aToken, { message_ids: ["ib_a_status"] });
    expect(body.acked_inbox).toBe(0);
  });

  test("🔴 C 撞名:节点的待办不能被用户 ack 走", async () => {
    const { body } = await post("/api/messages/ack", cToken, { message_ids: ["ib_c_node_task"] });
    expect(body.acked_inbox).toBe(0);
    const { db } = require("./db.js");
    expect(db.get<{ acked: number }>("SELECT acked FROM inbox WHERE id = 'ib_c_node_task'")?.acked).toBe(0);
  });
});
