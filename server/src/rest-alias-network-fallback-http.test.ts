// #1974 —— 多网络账号给「另一个网络里的 Agent」发消息,hub 侧也要能发出去。
//
// 起因(admin 2026-10-21 截图 + hub 拒绝日志):
//   [15:55:54] tang → /api/task → tang02: REJECTED 404 alias_not_found (net=net_ac567b4ab74e)
//
// 客户端的 Agent 列表是跨网络的(GET /api/status?light=1 不带 network_id ⇒ 返回调用者所属的
// 全部网络),发送却带着「登录时选的那一个网络」。这里用真实 HTTP + 临时库复现那个形状:
//   * admin 拥有 NET_A,里面有 Agent `cross-agent`;
//   * tang 注册 ⇒ 自己的个人网络 NET_B(owner),同时是 NET_A 的 admin 成员(agent_access 'all');
//   * tang 用 NET_B 发给 `cross-agent` ⇒ 修之前 404 alias_not_found,修之后送达 NET_A。
//
// 三条红线各有断言:同名在两个网络都有 ⇒ 不猜(仍 404);没授权的网络 ⇒ 不去;不存在的 alias ⇒ 404。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addNetworkMember, register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-1974-alias-net-"));
let BASE = "";
let hub: any = null;
const PW = "AliasNetPassw0rd!x";
let NET_A = "";
let NET_B = "";
let tangToken = "";
let tangUserId = "";

const stamp = Date.now();

let sessionSeq = 0;
function insertSession(alias: string, networkId: string, nodeId: string | null = null) {
  sessionSeq += 1;
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, network_id, status, updated_at, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, 'idle', datetime('now'), datetime('now'))`,
    [`resume_${alias}_${stamp}_${sessionSeq}`, alias, nodeId, networkId],
  );
}

async function postTask(token: string, body: any) {
  const res = await fetch(`${BASE}/api/task`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json };
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";

  const admin = register(`aliasnet_admin_${stamp}`, PW, undefined, "Admin");
  expect(admin.ok).toBe(true);
  NET_A = admin.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [admin.user!.user_id]);

  // admin 名下的 Agent:只在 NET_A 里。
  insertSession("cross-agent", NET_A, `node_cross_${stamp}`);

  // tang:自己的个人网络 NET_B(owner)+ NET_A 的 admin 成员(两个网络 agent_access 都是 'all',
  // 这正是现网 tang 的形状:owner 个人网络 + admin 团队网络)。
  const tang = register(`aliasnet_tang_${stamp}`, PW, undefined, "Tang");
  expect(tang.ok).toBe(true);
  NET_B = tang.network_id!;
  tangToken = tang.token!;
  tangUserId = tang.user!.user_id;
  expect(addNetworkMember(NET_A, tangUserId, "admin", admin.user!.user_id, { agentAccess: "all" }).ok).toBe(true);

  // 同名 alias 在**请求的网络之外**的两个网络里都有 ⇒ 不猜。
  // 需要第三个网络:另一个用户建自己的网络,tang 也是它的成员。
  const third = register(`aliasnet_third_${stamp}`, PW, undefined, "Third");
  expect(third.ok).toBe(true);
  const NET_C = third.network_id!;
  expect(addNetworkMember(NET_C, tangUserId, "member", third.user!.user_id, { agentAccess: "all" }).ok).toBe(true);
  insertSession("twin-agent", NET_A, `node_twin_a_${stamp}`);
  insertSession("twin-agent", NET_C, `node_twin_c_${stamp}`);

  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
});

afterAll(() => {
  try { hub?.stop?.(); } catch { /* ignore */ }
  try { rmSync(DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("POST /api/task across the caller's own networks (#1974)", () => {
  test("an alias in the caller's other network is delivered there, not 404", async () => {
    const res = await postTask(tangToken, { alias: "cross-agent", task: "hi", network_id: NET_B });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    // 落在 NET_A(那个 alias 真正所在的网络),不是请求里带的 NET_B。
    expect(res.json.actual_to?.network_id ?? res.json.actual_to?.networkId).toBe(NET_A);
    const row = db.get<{ network_id: string }>("SELECT network_id FROM tasks WHERE task_id = ?1", [res.json.task_id]);
    expect(row?.network_id).toBe(NET_A);
  });

  test("the same alias in two of the caller's networks is not guessed", async () => {
    const res = await postTask(tangToken, { alias: "twin-agent", task: "hi", network_id: NET_B });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("alias_not_found");
  });

  test("an alias nobody has is still 404", async () => {
    const res = await postTask(tangToken, { alias: "nowhere-agent", task: "hi", network_id: NET_B });
    expect(res.status).toBe(404);
    expect(res.json.error).toBe("alias_not_found");
  });

  test("the requested network still wins when it has the alias", async () => {
    const res = await postTask(tangToken, { alias: "cross-agent", task: "hi2", network_id: NET_A });
    expect(res.status).toBe(200);
    expect(res.json.actual_to?.network_id ?? res.json.actual_to?.networkId).toBe(NET_A);
  });
});
