import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";

process.env.COMMHUB_DB ||= `${mkdtempSync("/tmp/req-echo-")}/hub.db`;

let hub: any;
let base = "";
let owner: any;
let outsider: any;

async function rest(token: string, path: string) {
  const r = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: r.status, body: await r.json() as any };
}

beforeAll(async () => {
  const { register } = await import("./auth.js");
  owner = register("echo_owner", "Fixture-Strong1!");
  outsider = register("echo_outsider", "Fixture-Strong1!");
  const { bootServer } = await import("./server.js");
  hub = bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
  await rest(owner.token, `/api/requirements/projects?network_id=${owner.network_id}`); // warm
}, 60_000);
afterAll(() => hub?.stop(true));

// #2899 —— 三条复核的共同点：响应码不携带「你问的是不是这个网络」。
// 只加一个回显字段，不改鉴权、不改返回内容、不引入新的 4xx。
test("projects 列表回显实际使用的 network_id", async () => {
  const r = await rest(owner.token, `/api/requirements/projects?network_id=${owner.network_id}`);
  expect(r.status).toBe(200);
  expect(r.body.network_id).toBe(owner.network_id);
});

test("不带 network_id（单一成员可被自动推断）时，回显推断出来的那个网络", async () => {
  const r = await rest(owner.token, "/api/requirements/projects");
  expect(r.status).toBe(200);
  expect(r.body.network_id).toBe(owner.network_id);
  // 没有跨网泄漏：项目都属于回显的那个网络
  for (const p of r.body.projects) expect(p.network_id ?? owner.network_id).toBe(owner.network_id);
});

test("节点令牌传别人网络的 id 时，回显的是**它自己**的网络（调用方可据此发现不一致）", async () => {
  const { db } = await import("./db.js");
  const nodeId = `n_echo_${Date.now()}`;
  db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,lifecycle_state)
    VALUES(?1,?1,?1,?2,?3,'active')`, [nodeId, owner.network_id, owner.user.user_id]);
  const { generateNetworkToken, hashToken } = await import("./db.js");
  const raw = generateNetworkToken();
  db.run(`INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash,bound_node_id,node_identity_epoch)
    VALUES(?1,?2,?3,'network','node:echo',?4,?1,2)`, [nodeId, owner.user.user_id, owner.network_id, hashToken(raw)]);

  const r = await rest(raw, "/api/requirements/projects?network_id=net_someone_else");
  expect(r.status).toBe(200);
  // 关键：不是 net_someone_else，而是令牌自己的网络 —— 客户端可据此判定「拿到的不是我问的」
  expect(r.body.network_id).toBe(owner.network_id);
});
