// Agent 分组(RFC-038 §8)—— HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。
//
// 场景:Hub 管理员 admin 的网络 NET 里有 3 个 Agent(X、Y、Z);受限成员 alice 没有任何直接授权。
// 正向:组授权 ⇒ 看得见、能派活;往组里加节点 ⇒ 下一次请求就可见(动态);直接授权与组授权取并集。
// 反向:移出组 ⇒ 403 且与不存在的 alias 逐字节相同;删组 ⇒ 访问消失;跨网络 id ⇒ 400;
//       节点令牌 / 受限成员碰组接口 ⇒ 403。
// 兼容:旧 app 形状的 PUT(只带 grants)不动组授权;agent_access='all' 的成员不看组。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-agent-groups-"));
let BASE = "";
let hub: any = null;

const PW = "GroupTestPassw0rd!x";
let adminToken = "";
let adminId = "";
let NET = "";
let OTHER_NET = "";
let aliceToken = "";
let aliceId = "";
let carolToken = "";
let carolId = "";
let nodeToken = "";

const X = { alias: "grp-agent-x", node: "node_grp_x" };
const Y = { alias: "grp-agent-y", node: "node_grp_y" };
const Z = { alias: "grp-agent-z", node: "node_grp_z" };
const FOREIGN = { alias: "grp-agent-foreign", node: "node_grp_foreign" };

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
const json = (token: string) => ({ ...auth(token), "Content-Type": "application/json" });

function seedAgent(a: { alias: string; node: string }, net: string) {
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at) VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`,
    [a.node, a.alias, net, adminId],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, status, network_id, updated_at, last_seen_at)
     VALUES (?1, ?2, ?3, 'idle', ?4, datetime('now'), datetime('now'))`,
    [`resume_${a.node}`, a.alias, a.node, net],
  );
}

async function send(token: string, method: string, path: string, payload?: unknown): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${BASE}${path}`, { method, headers: json(token), body: payload === undefined ? undefined : JSON.stringify(payload) });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body, text };
}
const get = (token: string, path: string) => send(token, "GET", path);
const seen = async (token: string) => {
  const r = await get(token, `/api/status?network_id=${NET}`);
  expect(r.status).toBe(200);
  return (r.body.sessions ?? []).map((s: any) => s.alias).filter((a: string) => a.startsWith("grp-agent-")).sort();
};
// 每次内容不同:hub 按内容哈希 5 分钟去重(send_dedup),同样的探针第二次会 429。
let probeSeq = 0;
const task = (token: string, alias: string) => send(token, "POST", "/api/task", { alias, task: `probe ${alias} #${++probeSeq}`, network_id: NET });
const grantsPath = (uid: string) => `/api/networks/${NET}/members/${uid}/agent-grants`;
const groupsPath = `/api/networks/${"__NET__"}/agent-groups`;
const gp = (suffix = "") => groupsPath.replace("__NET__", NET) + suffix;

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";

  const admin = register(`grp_admin_${Date.now()}`, PW, undefined, "Admin");
  expect(admin.ok).toBe(true);
  adminToken = admin.token!;
  adminId = admin.user!.user_id;
  NET = admin.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [adminId]);
  for (const a of [X, Y, Z]) seedAgent(a, NET);

  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  // 另一个网络(admin 也是 owner),放一个外网节点,用来测跨网络 id。
  const other = await send(adminToken, "POST", "/api/networks", { name: `grp-other-${Date.now()}` });
  expect(other.status).toBe(200);
  OTHER_NET = other.body.network_id ?? other.body.network?.network_id;
  expect(typeof OTHER_NET).toBe("string");
  seedAgent(FOREIGN, OTHER_NET);

  const mk = async (username: string, agentAccess?: "all") => {
    const r = await send(adminToken, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role: "member" });
    expect(r.status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    expect(login.status).toBe(200);
    if (agentAccess) db.run("UPDATE network_members SET agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, login.body.user.user_id]);
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  const alice = await mk(`grp_alice_${Date.now()}`);
  aliceToken = alice.token; aliceId = alice.id;
  const carol = await mk(`grp_carol_${Date.now()}`, "all");
  carolToken = carol.token; carolId = carol.id;

  const nt = await send(adminToken, "POST", "/api/auth/node-token", { network_id: NET, node_name: X.alias, node_id: X.node });
  expect(nt.status).toBe(200);
  nodeToken = nt.body.token;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

let groupId = "";

describe("Agent 分组:CRUD 与权限", () => {
  test("owner 建组(带成员);重名 409;外网节点 400 且整批不写", async () => {
    const r = await send(adminToken, "POST", gp(), { name: "前端组", node_ids: [X.node] });
    expect(r.status).toBe(200);
    groupId = r.body.group.group_id;
    expect(r.body.group.node_ids).toEqual([X.node]);
    expect((await send(adminToken, "POST", gp(), { name: "前端组" })).status).toBe(409);
    const bad = await send(adminToken, "POST", gp(), { name: "坏组", node_ids: [Y.node, FOREIGN.node] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("agent_not_in_network");
    const list = await get(adminToken, gp());
    expect(list.body.groups.map((g: any) => g.name)).toEqual(["前端组"]);
  });

  test("受限成员、节点令牌碰组接口 ⇒ 403", async () => {
    expect((await get(aliceToken, gp())).status).toBe(403);
    expect((await send(aliceToken, "POST", gp(), { name: "偷偷建" })).status).toBe(403);
    expect((await get(nodeToken, gp())).status).toBe(403);
  });

  test("审计:建组写 agent_group_created(带 network_id)", () => {
    const row = db.get<{ network_id: string; detail: string }>("SELECT network_id, detail FROM audit_log WHERE action = 'agent_group_created' AND target_id = ?1", groupId);
    expect(row?.network_id).toBe(NET);
    expect(row?.detail).toContain("前端组");
  });
});

describe("组授权:动态生效", () => {
  test("基线:alice 没有任何授权 ⇒ 看不到、发不了", async () => {
    expect(await seen(aliceToken)).toEqual([]);
    expect((await task(aliceToken, X.alias)).status).toBe(403);
  });

  test("授权给组 ⇒ 看到组里的 X、能派活;GET 回 group_grants", async () => {
    const put = await send(adminToken, "PUT", grantsPath(aliceId), { group_grants: [{ group_id: groupId, can_message: true }] });
    expect(put.status).toBe(200);
    expect(put.body.group_grants).toEqual([{ group_id: groupId, name: "前端组", can_message: true }]);
    expect(put.body.restricted).toBe(true);
    expect(await seen(aliceToken)).toEqual([X.alias]);
    expect((await task(aliceToken, X.alias)).status).toBe(200);
    expect((await task(aliceToken, Y.alias)).status).toBe(403);
    const g = await get(adminToken, grantsPath(aliceId));
    expect(g.body.grants).toEqual([]);
    expect(g.body.group_grants.length).toBe(1);
  });

  test("往组里加 Y ⇒ alice 下一次请求就看得见 Y(不用改她的授权)", async () => {
    const r = await send(adminToken, "PUT", gp(`/${groupId}/members`), { node_ids: [X.node, Y.node] });
    expect(r.status).toBe(200);
    expect(r.body.added).toEqual([Y.node]);
    expect(await seen(aliceToken)).toEqual([X.alias, Y.alias]);
    expect((await task(aliceToken, Y.alias)).status).toBe(200);
    const audit = db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'agent_group_members_changed' AND target_id = ?1 ORDER BY id DESC LIMIT 1", groupId);
    expect(JSON.parse(audit!.detail)).toEqual({ added: [Y.node], removed: [] });
  });

  test("从组里移出 Y ⇒ 看不见,派活 403 且与不存在的 alias 逐字节相同", async () => {
    await send(adminToken, "PUT", gp(`/${groupId}/members`), { node_ids: [X.node] });
    expect(await seen(aliceToken)).toEqual([X.alias]);
    const y = await task(aliceToken, Y.alias);
    const ghost = await task(aliceToken, "grp-agent-does-not-exist");
    expect(y.status).toBe(403);
    expect(y.text).toBe(ghost.text);
  });

  test("直接授权与组授权取并集;可对话任一来源给了就算", async () => {
    // 组授权只读,Z 直接授权可对话
    const put = await send(adminToken, "PUT", grantsPath(aliceId), {
      grants: [{ node_id: Z.node, can_message: true }],
      group_grants: [{ group_id: groupId, can_message: false }],
    });
    expect(put.status).toBe(200);
    expect(await seen(aliceToken)).toEqual([X.alias, Z.alias]);
    expect((await task(aliceToken, X.alias)).status).toBe(403);   // 组只读
    expect((await task(aliceToken, Z.alias)).status).toBe(200);   // 直接可对话
    // X 再给一条直接可对话授权 ⇒ 并集 ⇒ 可以发
    await send(adminToken, "PUT", grantsPath(aliceId), { grants: [{ node_id: Z.node, can_message: true }, { node_id: X.node, can_message: true }] });
    expect((await task(aliceToken, X.alias)).status).toBe(200);
  });

  test("兼容:旧 app 形状的 PUT(只带 grants,不带 group_grants)不动组授权", async () => {
    const before = await get(adminToken, grantsPath(aliceId));
    expect(before.body.group_grants.length).toBe(1);
    const old = await send(adminToken, "PUT", grantsPath(aliceId), { grants: [{ node_id: Z.node, can_message: true }] });
    expect(old.status).toBe(200);
    expect(old.body.group_grants.length).toBe(1);
    expect(await seen(aliceToken)).toEqual([X.alias, Z.alias]);
  });

  test("组授权:外网 / 不存在的 group_id ⇒ 400,整批不写", async () => {
    const other = await send(adminToken, "POST", `/api/networks/${OTHER_NET}/agent-groups`, { name: "外网组" });
    expect(other.status).toBe(200);
    const bad = await send(adminToken, "PUT", grantsPath(aliceId), { group_grants: [{ group_id: other.body.group.group_id }] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("group_not_in_network");
    expect((await get(adminToken, grantsPath(aliceId))).body.group_grants.map((g: any) => g.group_id)).toEqual([groupId]);
  });

  test("agent_access='all' 的成员不看组:照旧全部可见", async () => {
    expect(await seen(carolToken)).toEqual([X.alias, Y.alias, Z.alias]);
  });

  test("成员列表带 agent_group_count", async () => {
    const r = await get(adminToken, `/api/networks/${NET}/members`);
    const alice = r.body.members.find((m: any) => m.user_id === aliceId);
    expect(alice.agent_group_count).toBe(1);
  });

  test("删组 ⇒ 组授权随之消失,只剩直接授权;响应带受影响成员;审计", async () => {
    const del = await send(adminToken, "DELETE", gp(`/${groupId}`));
    expect(del.status).toBe(200);
    expect(del.body.affected_user_ids).toEqual([aliceId]);
    expect(await seen(aliceToken)).toEqual([Z.alias]);
    expect((await task(aliceToken, X.alias)).status).toBe(403);
    expect((await get(adminToken, grantsPath(aliceId))).body.group_grants).toEqual([]);
    expect(db.get("SELECT 1 FROM audit_log WHERE action = 'agent_group_deleted' AND target_id = ?1", groupId)).toBeTruthy();
    expect((await send(adminToken, "DELETE", gp(`/${groupId}`))).status).toBe(404);
  });

  test("移出网络 ⇒ 组授权一并清掉", async () => {
    const g2 = await send(adminToken, "POST", gp(), { name: "第二组", node_ids: [Y.node] });
    await send(adminToken, "PUT", grantsPath(aliceId), { group_grants: [g2.body.group.group_id] });
    expect(db.get("SELECT 1 FROM network_member_group_grants WHERE user_id = ?1", aliceId)).toBeTruthy();
    const rm = await send(adminToken, "DELETE", `/api/networks/${NET}/members/${aliceId}`);
    expect(rm.status).toBe(200);
    expect(db.get("SELECT 1 FROM network_member_group_grants WHERE user_id = ?1", aliceId)).toBeFalsy();
  });
});
