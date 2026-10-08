// #764:Agent 团队 —— GET/POST/PATCH/DELETE /api/networks/:id/agent-teams[/:team_id] + PUT …/nodes/:node_id/agent-team。
// HTTP 集成测试(真实 Bun.serve,私有端口,临时库;PG 阶梯里用同一个文件跑真 PostgreSQL)。
//
// 夹具(全是占位名):网络 owner;成员 ownerA(管「平台」子树)、ownerB(管「运维」,和平台是兄弟)、member;
// 节点 n1..n3(owner 建),nodeTok 是 n1 的节点令牌;另一个网络 NET2(owner2)有自己的团队和节点。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-agent-teams-"));
let BASE = "";
let hub: any = null;
const PW = "AgentTeamsPassw0rd!xyz";
let NET = "";
let NET2 = "";
const U: Record<string, { token: string; id: string }> = {};
const T: Record<string, string> = {};
let NODE_TOKEN = "";
const N = { n1: "node_at_1", n2: "node_at_2", n3: "node_at_3", x1: "node_at_x1" };
let before: Record<string, string> = {};

async function raw(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}
async function send(token: string, method: string, path: string, body?: unknown) {
  const r = await raw(token, method, path, body);
  let json: any = null;
  try { json = JSON.parse(r.text); } catch {}
  return { status: r.status, body: json };
}
const tok = (who: string) => (who === "node" ? NODE_TOKEN : U[who].token);
const create = (who: string, name: string, parent_id?: string | null, net = NET) => send(tok(who), "POST", `/api/networks/${net}/agent-teams`, { name, parent_id });
const patch = (who: string, id: string, body: unknown, net = NET) => send(tok(who), "PATCH", `/api/networks/${net}/agent-teams/${id}`, body);
const del = (who: string, id: string) => send(tok(who), "DELETE", `/api/networks/${NET}/agent-teams/${id}`);
const assign = (who: string, node: string, team_id: string | null, net = NET) => send(tok(who), "PUT", `/api/networks/${net}/nodes/${node}/agent-team`, { team_id });
const teams = async (who = "owner") => (await send(tok(who), "GET", `/api/networks/${NET}/agent-teams`)).body.teams as any[];
const team = async (id: string) => (await teams()).find((t) => t.id === id);
const teamOf = async (node: string) => (await teams()).find((t) => t.members.some((m: any) => m.node_id === node))?.id ?? null;
const denied = (r: { status: number; body: any }) => { expect(r.status).toBe(403); expect(r.body.error).toBe("agent_team_scope_denied"); };
const snapshot = async () => ({
  departments: (await raw(U.owner.token, "GET", `/api/networks/${NET}/departments`)).text,
  humans: (await raw(U.owner.token, "GET", `/api/networks/${NET}/humans`)).text,
  node: (await raw(U.owner.token, "GET", `/api/nodes/${N.n1}/config`)).text,
});

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const stamp = Date.now();
  const a = register(`at_owner_${stamp}`, PW, undefined, "Owner");
  U.owner = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const b = register(`at_owner2_${stamp}`, PW, undefined, "Owner2");
  U.owner2 = { token: b.token!, id: b.user!.user_id };
  NET2 = b.network_id!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  for (const k of ["ownerA", "ownerB", "member"]) {
    const username = `at_${k}_${stamp}`;
    expect((await send(U.owner.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role: "member" })).status).toBe(200);
    const login = await send("", "POST", "/api/auth/login", { username, password: PW });
    U[k] = { token: login.body.token, id: login.body.user.user_id };
  }
  db.run("UPDATE users SET display_name = ?1 WHERE user_id = ?2", ["平台负责人", U.ownerA.id]);
  for (const [alias, id] of [["示例节点一", N.n1], ["示例节点二", N.n2], ["示例节点三", N.n3]]) {
    const t = createNetworkTokenForNode(U.owner.id, NET, alias, id);
    expect(t.error ?? null).toBe(null);
    if (id === N.n1) NODE_TOKEN = t.token!;
  }
  expect(createNetworkTokenForNode(U.owner2.id, NET2, "外网节点", N.x1).error ?? null).toBe(null);
  db.run("UPDATE nodes SET display_name = ?1 WHERE node_id = ?2", ["节点一号", N.n1]);
  // 成员默认「只看授权 Agent」:ownerA 看得见 n1、n2(看不见 n3),ownerB 看得见 n2、n3。
  const grant = (k: string, ids: string[]) => send(U.owner.token, "PUT", `/api/networks/${NET}/members/${U[k].id}/agent-grants`, { agent_access: "granted", grants: ids.map((node_id) => ({ node_id })) });
  expect((await grant("ownerA", [N.n1, N.n2])).status).toBe(200);
  expect((await grant("ownerB", [N.n2, N.n3])).status).toBe(200);
  before = await snapshot();
}, 60_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#764 CRUD (network owner)", () => {
  test("empty tree, then create roots and children", async () => {
    expect(await teams()).toEqual([]);
    const p = await create("owner", "平台");
    expect(p.status).toBe(201);
    T.plat = p.body.team.id;
    T.ops = (await create("owner", "运维")).body.team.id;
    T.api = (await create("owner", "接口", T.plat)).body.team.id;
    T.web = (await create("owner", "前端", T.plat)).body.team.id;
    const t = await team(T.api);
    expect(t).toMatchObject({ id: T.api, name: "接口", parent_id: T.plat, lead: null, owner: null, members: [] });
  });
  test("validation: empty name 400, duplicate sibling 409, unknown parent 400, wrong method 405", async () => {
    expect((await create("owner", "  ")).body.error).toBe("invalid_team_name");
    const dup = await create("owner", "接口", T.plat);
    expect(dup.status).toBe(409); expect(dup.body.error).toBe("team_name_taken");
    expect((await create("owner", "接口", T.ops)).status).toBe(201); // 不同上级可以同名
    expect((await create("owner", "x", "team_nope")).body.error).toBe("parent_not_found");
    expect((await send(U.owner.token, "PUT", `/api/networks/${NET}/agent-teams`, {})).status).toBe(405);
  });
  test("rename, sort, lead, owner; GET shows display names", async () => {
    expect((await patch("owner", T.plat, { name: "平台组", sort: 5, lead_node_id: N.n1, owner_user_id: U.ownerA.id })).status).toBe(200);
    expect((await patch("owner", T.ops, { owner_user_id: U.ownerB.id })).status).toBe(200);
    const t = await team(T.plat);
    expect(t.name).toBe("平台组"); expect(t.sort).toBe(5);
    expect(t.lead).toEqual({ node_id: N.n1, alias: "示例节点一", display_name: "节点一号" });
    expect(t.owner).toEqual({ user_id: U.ownerA.id, display_name: "平台负责人" });
    expect((await team(T.ops)).owner).toEqual({ user_id: U.ownerB.id, display_name: "" });
    const nope = await patch("owner", T.plat, { lead_node_id: "node_nope" });
    expect(nope.status).toBe(404); expect(nope.body.error).toBe("node_not_found");
    expect((await patch("owner", T.plat, { owner_user_id: U.owner2.id })).body.error).toBe("owner_not_member");
    expect((await patch("owner", T.plat, {})).body.error).toBe("empty_patch");
  });
  test("cycle rejected (self and descendant)", async () => {
    for (const p of [T.plat, T.api]) {
      const r = await patch("owner", T.plat, { parent_id: p });
      expect(r.status).toBe(400); expect(r.body.error).toBe("team_cycle");
    }
    expect((await team(T.plat)).parent_id).toBe(null);
  });
  test("delete with children rejected; leaf delete clears memberships", async () => {
    const r = await del("owner", T.plat);
    expect(r.status).toBe(409); expect(r.body.error).toBe("team_has_children"); expect(r.body.children).toBe(2);
    const tmp = (await create("owner", "临时", T.ops)).body.team.id;
    expect((await assign("owner", N.n3, tmp)).status).toBe(200);
    expect(await teamOf(N.n3)).toBe(tmp);
    expect((await del("owner", tmp)).status).toBe(200);
    expect(await teamOf(N.n3)).toBe(null);
    expect((await del("owner", tmp)).status).toBe(404);
  });
});

describe("#764 membership set / move / clear", () => {
  test("set, move, clear", async () => {
    const r = await assign("owner", N.n2, T.api);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, node_id: N.n2, team_id: T.api });
    expect((await team(T.api)).members).toEqual([{ node_id: N.n2, alias: "示例节点二", display_name: null }]);
    expect((await assign("owner", N.n2, T.ops)).status).toBe(200);
    expect(await teamOf(N.n2)).toBe(T.ops);
    expect((await team(T.api)).members).toEqual([]);
    expect((await assign("owner", N.n2, null)).status).toBe(200);
    expect(await teamOf(N.n2)).toBe(null);
    expect((await assign("owner", N.n2, "team_nope")).body.error).toBe("team_not_found");
    expect((await assign("owner", "node_nope", T.api)).status).toBe(404);
  });
});

describe("#764 subtree owner vs sibling owner", () => {
  test("ownerA manages the 平台 subtree", async () => {
    expect((await patch("ownerA", T.plat, { name: "平台", lead_node_id: N.n2 })).status).toBe(200);
    const c = await create("ownerA", "网关", T.api);
    expect(c.status).toBe(201);
    T.gw = c.body.team.id;
    expect((await patch("ownerA", T.gw, { parent_id: T.web })).status).toBe(200); // 子树内挪动
    expect((await patch("ownerA", T.web, { owner_user_id: U.ownerA.id })).status).toBe(200); // 下级的 owner 可以换
    expect((await assign("ownerA", N.n1, T.gw)).status).toBe(200);
    expect((await assign("ownerA", N.n1, T.api)).status).toBe(200);
    expect((await assign("ownerA", N.n1, null)).status).toBe(200);
    expect((await del("ownerA", T.gw)).status).toBe(200);
  });
  test("ownerA cannot change its own team's owner, move it out, delete it, or create a root", async () => {
    denied(await patch("ownerA", T.plat, { owner_user_id: U.ownerA.id }));
    denied(await patch("ownerA", T.plat, { parent_id: T.ops }));
    denied(await patch("ownerA", T.api, { parent_id: T.ops })); // 挪出子树
    denied(await patch("ownerA", T.api, { parent_id: null }));
    denied(await del("ownerA", T.plat));
    denied(await create("ownerA", "根"));
  });
  test("sibling owner (ownerB) denied on the 平台 subtree", async () => {
    denied(await patch("ownerB", T.plat, { name: "抢" }));
    denied(await patch("ownerB", T.api, { lead_node_id: N.n3 }));
    denied(await create("ownerB", "插", T.plat));
    denied(await del("ownerB", T.web));
    denied(await assign("ownerB", N.n3, T.api));
    expect((await assign("owner", N.n3, T.api)).status).toBe(200);
    denied(await assign("ownerB", N.n3, T.ops)); // 从别人的子树拉走
    denied(await assign("ownerB", N.n3, null));
    expect(await teamOf(N.n3)).toBe(T.api);
    expect((await assign("ownerB", N.n2, T.ops)).status).toBe(200); // 自己子树里可以
  });
});

describe("#764 read-only callers", () => {
  test("plain member and node token: GET ok, every write denied", async () => {
    for (const who of ["member", "node"]) {
      expect((await send(tok(who), "GET", `/api/networks/${NET}/agent-teams`)).status).toBe(200);
      denied(await create(who, "x"));
      denied(await create(who, "x", T.plat));
      denied(await patch(who, T.plat, { name: "x" }));
      denied(await del(who, T.web));
      denied(await assign(who, N.n1, T.plat));
    }
    expect((await teams("node")).find((t) => t.id === T.plat).lead.node_id).toBe(N.n2);
  });
  test("agent-restricted member does not see ungranted nodes", async () => {
    const t = (await teams("member")).find((x) => x.id === T.plat);
    expect(t.lead).toBe(null);
    expect((await teams("member")).every((x) => x.members.length === 0)).toBe(true);
  });
});

describe("#764 restricted subtree owner: invisible nodes are the same as missing ones", () => {
  test("cannot set an invisible lead; cannot assign an invisible node; 404 identical to a nonexistent node", async () => {
    expect((await assign("owner", N.n3, null)).status).toBe(200);
    const leadHidden = await raw(U.ownerA.token, "PATCH", `/api/networks/${NET}/agent-teams/${T.api}`, { lead_node_id: N.n3 });
    const leadMissing = await raw(U.ownerA.token, "PATCH", `/api/networks/${NET}/agent-teams/${T.api}`, { lead_node_id: "node_nope" });
    expect(leadHidden.status).toBe(404);
    expect(leadHidden.text).toBe(leadMissing.text);
    expect((await team(T.api)).lead).toBe(null);
    const putHidden = await raw(U.ownerA.token, "PUT", `/api/networks/${NET}/nodes/${N.n3}/agent-team`, { team_id: T.api });
    const putMissing = await raw(U.ownerA.token, "PUT", `/api/networks/${NET}/nodes/node_nope/agent-team`, { team_id: T.api });
    expect(putHidden.status).toBe(404);
    expect(putHidden.text).toBe(putMissing.text.replace("node_nope", N.n3));
    expect(await teamOf(N.n3)).toBe(null);
    // 能看见的节点照常可设
    const ok = await patch("ownerA", T.api, { lead_node_id: N.n1 });
    expect(ok.status).toBe(200); expect(ok.body.team.lead.node_id).toBe(N.n1);
  });
  test("PATCH response never echoes an invisible lead", async () => {
    expect((await patch("owner", T.web, { lead_node_id: N.n3 })).status).toBe(200);
    const r = await patch("ownerA", T.web, { name: "前端组" });
    expect(r.status).toBe(200);
    expect(r.body.team.lead).toBe(null);
    expect(JSON.stringify(r.body)).not.toContain(N.n3);
  });
  test("owner_not_member is only reported after the permission check", async () => {
    denied(await patch("ownerA", T.plat, { owner_user_id: "user_nope" }));
    denied(await patch("ownerB", T.plat, { owner_user_id: "user_nope" }));
    denied(await patch("member", T.plat, { owner_user_id: "user_nope" }));
  });
});

describe("#764 network owner (not a Hub admin)", () => {
  test("owner2 manages its own network's teams end to end", async () => {
    expect(db.get<{ role: string }>("SELECT role FROM users WHERE user_id = ?1", U.owner2.id)?.role).not.toBe("admin");
    const c = await create("owner2", "外网根", null, NET2);
    expect(c.status).toBe(201);
    const id = c.body.team.id;
    const child = (await create("owner2", "外网子", id, NET2)).body.team.id;
    expect((await patch("owner2", child, { name: "外网子组", lead_node_id: N.x1, owner_user_id: U.owner2.id }, NET2)).status).toBe(200);
    expect((await assign("owner2", N.x1, child, NET2)).status).toBe(200);
    expect((await assign("owner2", N.x1, null, NET2)).status).toBe(200);
    expect((await send(U.owner2.token, "DELETE", `/api/networks/${NET2}/agent-teams/${child}`)).status).toBe(200);
    expect((await send(U.owner2.token, "DELETE", `/api/networks/${NET2}/agent-teams/${id}`)).status).toBe(200);
  });
});

describe("#764 cross-network", () => {
  test("foreign network's ids are not usable here", async () => {
    const foreign = (await create("owner2", "外网团队", null, NET2)).body.team.id;
    expect((await patch("owner", foreign, { name: "x" })).status).toBe(404);
    expect((await del("owner", foreign)).status).toBe(404);
    expect((await create("owner", "x", foreign)).body.error).toBe("parent_not_found");
    expect((await patch("owner", T.api, { parent_id: foreign })).body.error).toBe("parent_not_found");
    expect((await assign("owner", N.n1, foreign)).body.error).toBe("team_not_found");
    expect((await assign("owner", N.x1, T.api)).status).toBe(404);
    expect((await patch("owner", T.api, { lead_node_id: N.x1 })).status).toBe(404);
    expect((await assign("owner2", N.x1, T.api, NET2)).body.error).toBe("team_not_found");
    // 非成员 / 别的网络的节点令牌
    expect((await send(U.owner2.token, "GET", `/api/networks/${NET}/agent-teams`)).status).toBe(403);
    expect((await send(NODE_TOKEN, "GET", `/api/networks/${NET2}/agent-teams`)).status).toBe(403);
    expect((await (await send(U.owner2.token, "GET", `/api/networks/${NET2}/agent-teams`)).body.teams).length).toBe(1);
  });
});

describe("#764 node delete cleans up", () => {
  test("deleting a node removes its membership and nulls the lead", async () => {
    expect((await assign("owner", N.n2, T.plat)).status).toBe(200);
    expect((await send(U.owner.token, "DELETE", `/api/nodes/${N.n2}`)).status).toBe(200);
    expect(await teamOf(N.n2)).toBe(null);
    expect((await team(T.plat)).lead).toBe(null);
    expect(db.get("SELECT 1 AS x FROM network_agent_team_members WHERE node_id = ?1", N.n2) ?? null).toBe(null);
    expect(db.get("SELECT 1 AS x FROM network_agent_teams WHERE lead_node_id = ?1", N.n2) ?? null).toBe(null);
  });
});

describe("#764 network deletion removes team rows", () => {
  const rowsIn = (net: string) => ({
    teams: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM network_agent_teams WHERE network_id = ?1", net)!.n,
    members: db.get<{ n: number }>("SELECT COUNT(*) AS n FROM network_agent_team_members WHERE network_id = ?1", net)!.n,
  });
  const seed = async (who: string) => {
    const r = register(`at_${who}_${Date.now()}`, PW, undefined, who);
    U[who] = { token: r.token!, id: r.user!.user_id };
    const team_id = (await create(who, "将删", null, r.network_id!)).body.team.id;
    db.run("INSERT INTO network_agent_team_members (network_id, node_id, team_id) VALUES (?1, ?2, ?3)", [r.network_id!, `node_gone_${who}`, team_id]);
    expect(rowsIn(r.network_id!)).toEqual({ teams: 1, members: 1 });
    return r.network_id!;
  };
  test("Hub admin deleting an empty network (NETWORK_CLEANUP_TABLES)", async () => {
    const net = await seed("owner3");
    const r = await send(U.owner.token, "DELETE", `/api/networks/${net}`);
    expect(r.status).toBe(200);
    expect(r.body.cleaned.network_agent_teams).toBe(1);
    expect(r.body.cleaned.network_agent_team_members).toBe(1);
    expect(rowsIn(net)).toEqual({ teams: 0, members: 0 });
  });
  test("owner deleting its own network", async () => {
    const net = await seed("owner4");
    expect((await send(U.owner4.token, "DELETE", `/api/networks/${net}`)).status).toBe(200);
    expect(rowsIn(net)).toEqual({ teams: 0, members: 0 });
  });
});

describe("#764 existing endpoints unchanged", () => {
  test("departments / humans / node config byte-identical after all team operations", async () => {
    const after = await snapshot();
    expect(after.departments).toBe(before.departments);
    expect(after.humans).toBe(before.humans);
    expect(after.node).toBe(before.node);
  });
});
