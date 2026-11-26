// #3665 第二步（负责人 接手）：单节点读写的部门范围拦截，HTTP 层强制，不止纯函数/列表过滤。
// 覆盖：读（GET /api/nodes/:id/config）、写（DELETE /api/nodes/:id、PUT /api/nodes/:id/attrs），
// 以及拍板口径——无部门节点只归 global，部门管理者看不到也管不到。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "anet-user-grants-node-scope-"));
process.env.COMMHUB_DB ||= join(DIR, "hub.db");
let hub: ReturnType<typeof Bun.serve>;
let base = "";
let ownerToken = "", headToken = "", scopedAdminToken = "", plainAdminToken = "";
let net = "";
let devNode = "", opsNode = "", noDeptNode = "";

const call = async (method: string, path: string, token: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j: any = null; try { j = await r.json(); } catch {}
  return { status: r.status, body: j };
};

beforeAll(async () => {
  process.env.COMMHUB_AUTH_TOKEN ||= "legacy-master-token-for-test";
  const { db } = await import("./db.js");
  await import("./department-heads.js");
  const { register, addNetworkMember } = await import("./auth.js");
  const { setUserGrant } = await import("./user-grants.js");
  const stamp = Date.now();

  const owner = register(`ns_owner_${stamp}`, "Ns-Owner-1!");
  net = owner.network_id!;
  ownerToken = owner.token!;

  const head = register(`ns_head_${stamp}`, "Ns-Head-1!");
  const headId = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `ns_head_${stamp}`)!.user_id;
  addNetworkMember(net, headId, "member");
  // 受限成员默认看不到任何 agent（agent_access='granted'）；这里测的是部门范围这另一层拦截，
  // 不是「受限成员能不能看 agent」那层，所以放开成 'all'，和 user-grants-http.test.ts 的 headToken 一致。
  db.run("UPDATE network_members SET agent_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [net, headId]);
  headToken = head.token!;

  // 2026-11-26（cc123）：管理员被授了「仅某部门」也要收窄；没授部门的管理员仍看全部。
  const mkAdmin = (name: string) => {
    const u = register(`${name}_${stamp}`, "Ns-Admin-1!");
    const id = db.get<{ user_id: string }>("SELECT user_id FROM users WHERE username = ?1", `${name}_${stamp}`)!.user_id;
    addNetworkMember(net, id, "admin");
    return { token: u.token!, id };
  };
  const scopedAdmin = mkAdmin("ns_sadmin");
  const plainAdmin = mkAdmin("ns_padmin");
  scopedAdminToken = scopedAdmin.token;
  plainAdminToken = plainAdmin.token;

  db.run("INSERT INTO network_departments (network_id, department_id, name, sort) VALUES (?1,'d-dev','研发',0)", [net]);
  db.run("INSERT INTO network_departments (network_id, department_id, name, sort) VALUES (?1,'d-ops','运维',1)", [net]);
  // head 被明确授予「只管 d-dev」——不是部门负责人角色，是 user_grants 的 manage_nodes 授权本身。
  setUserGrant({ networkId: net, userId: headId, capability: "manage_nodes", scopeKind: "department", scopeId: "d-dev", level: "edit", grantedBy: null });
  setUserGrant({ networkId: net, userId: scopedAdmin.id, capability: "manage_nodes", scopeKind: "department", scopeId: "d-dev", level: "edit", grantedBy: null });

  devNode = `n_ns_dev_${stamp}`; opsNode = `n_ns_ops_${stamp}`; noDeptNode = `n_ns_none_${stamp}`;
  for (const [id, dept] of [[devNode, "d-dev"], [opsNode, "d-ops"], [noDeptNode, null]] as const) {
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, runtime, model, network_id, department_id) VALUES (?1, ?1, ?1, 'claude-agent-sdk', 'claude-sonnet-4-6', ?2, ?3)`,
      [id, net, dept],
    );
  }

  const mod = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 60_000);

afterAll(() => { try { hub?.stop(true); } catch {}; try { rmSync(DIR, { recursive: true, force: true }); } catch {} });

describe("#3665 单节点读写的部门范围拦截", () => {
  test("部门范围管理者读范围内的节点：200", async () => {
    const r = await call("GET", `/api/nodes/${devNode}/config?network_id=${net}`, headToken);
    expect(r.status).toBe(200);
    expect(r.body.node_id).toBe(devNode);
  });

  test("🔴 部门范围管理者读范围外的节点：403 out_of_scope，不是假装不存在的 404", async () => {
    const r = await call("GET", `/api/nodes/${opsNode}/config?network_id=${net}`, headToken);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("out_of_scope");
  });

  test("🔴 无部门的节点对部门范围管理者也不可见（只归 global，拍板口径）", async () => {
    const r = await call("GET", `/api/nodes/${noDeptNode}/config?network_id=${net}`, headToken);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("out_of_scope");
  });

  test("🔴 部门范围管理者删范围外的节点：403，节点仍在", async () => {
    const r = await call("DELETE", `/api/nodes/${opsNode}?network_id=${net}`, headToken);
    expect(r.status).toBe(403);
    const { db } = await import("./db.js");
    expect(db.get("SELECT node_id FROM nodes WHERE node_id = ?1", [opsNode])).not.toBeNull();
  });

  test("🔴 部门范围管理者改范围外节点的展示属性：403", async () => {
    const r = await call("PUT", `/api/nodes/${opsNode}/attrs?network_id=${net}`, headToken, { base_attrs_revision: 0, display_name: "改名" });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("out_of_scope");
  });

  test("部门范围管理者能改范围内节点的展示属性", async () => {
    const r = await call("PUT", `/api/nodes/${devNode}/attrs?network_id=${net}`, headToken, { base_attrs_revision: 0, display_name: "改名" });
    expect(r.status).toBe(200);
  });

  test("owner 不受部门范围限制，范围外节点照样读写", async () => {
    const got = await call("GET", `/api/nodes/${opsNode}/config?network_id=${net}`, ownerToken);
    expect(got.status).toBe(200);
  });

  test("/api/nodes 列表收窄与单节点判定一致：列表里也看不到无部门/范围外节点", async () => {
    const r = await call("GET", `/api/nodes?network_id=${net}`, headToken);
    expect(r.status).toBe(200);
    const ids = (r.body.nodes as any[]).map(n => n.node_id);
    expect(ids).toContain(devNode);
    expect(ids).not.toContain(opsNode);
    expect(ids).not.toContain(noDeptNode);
  });

  test("🔴 管理员被授了「仅某部门」：列表只剩该部门的节点（cc123 场景）", async () => {
    const r = await call("GET", `/api/nodes?network_id=${net}`, scopedAdminToken);
    expect(r.status).toBe(200);
    const ids = (r.body.nodes as any[]).map(n => n.node_id);
    expect(ids).toContain(devNode);
    expect(ids).not.toContain(opsNode);
    expect(ids).not.toContain(noDeptNode);
  });

  test("🔴 管理员被授了「仅某部门」：范围外节点读写 403 out_of_scope", async () => {
    const got = await call("GET", `/api/nodes/${opsNode}/config?network_id=${net}`, scopedAdminToken);
    expect(got.status).toBe(403);
    expect(got.body.error).toBe("out_of_scope");
    const put = await call("PUT", `/api/nodes/${opsNode}/attrs?network_id=${net}`, scopedAdminToken, { base_attrs_revision: 0, display_name: "改名" });
    expect(put.status).toBe(403);
  });

  test("默认管理员（没有部门授权）不受影响：列表看全部、范围外节点照样读", async () => {
    const r = await call("GET", `/api/nodes?network_id=${net}`, plainAdminToken);
    const ids = (r.body.nodes as any[]).map(n => n.node_id);
    expect(ids).toEqual(expect.arrayContaining([devNode, opsNode, noDeptNode]));
    const got = await call("GET", `/api/nodes/${opsNode}/config?network_id=${net}`, plainAdminToken);
    expect(got.status).toBe(200);
  });
});
