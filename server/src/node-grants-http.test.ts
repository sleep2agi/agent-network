// 节点管理授权（node-grants.ts）—— 全部经真实 HTTP 入口（bootServer + REST / /mcp）。
//
// 钉住：
//   1. PUT /api/nodes/:id/grants：网络 owner 可授全网；节点主人（普通成员）不行；部门负责人只能授自己子树里的部门范围，
//      授 network 403；未知能力 / 计划中的 board 能力 400；GET 读回；/health 带 node_grants。
//   2. 定时任务：没授权时节点看不到别人的计划；schedules·network·read ⇒ 看得到、改不了（not_schedule_creator）；
//      edit ⇒ 能改、能取消，审计一行 schedule_changed_via_node_grant；department 范围只覆盖目标节点在子树里的计划；
//      只读模式的节点 edit 降为 read；撤销（[]）当场生效。
//
// 跑法：COMMHUB_DB=/tmp/x.db bun test server/src/node-grants-http.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db } from "./db.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("node-grants requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now();
const PW = "NodeGrants123!";
let server: any, base = "", net = "";
const user: Record<string, { id: string; name: string; token: string }> = {};
const node: Record<string, { id: string; alias: string; token: string }> = {};
const deptA = `dept_ga_${stamp}`, deptB = `dept_gb_${stamp}`;

async function call(token: string, method: string, path: string, body?: unknown) {
  const r = await fetch(`${base}${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, body: json };
}
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await r.text();
  const data = text.split("\n").find((l) => l.startsWith("data: "));
  const msg = JSON.parse(data ? data.slice(6) : text);
  const inner = msg.result?.content?.[0]?.text;
  try { return JSON.parse(inner); } catch { return { raw: inner ?? msg }; }
}
const putGrants = (token: string, nodeId: string, grants: unknown) => call(token, "PUT", `/api/nodes/${nodeId}/grants`, { grants });
async function scheduleFor(target: string, name: string): Promise<string> {
  const r = await call(user.boss.token, "POST", "/api/scheduled-tasks", {
    network_id: net, name, target_node_id: target, task: `${name} task`, timezone: "UTC", schedule: { type: "interval", every_seconds: 86400 },
  });
  expect(r.status).toBe(201);
  return r.body.schedule.schedule_id;
}
const listIds = async (token: string) => ((await mcp(token, "schedule_list", {})).schedules ?? []).map((s: any) => s.schedule_id);

let schedA = "", schedB = "";

beforeAll(async () => {
  const boss = register(`ng_boss_${stamp}`, PW);
  net = boss.network_id!;
  user.boss = { id: boss.user!.user_id, name: `ng_boss_${stamp}`, token: boss.token! };
  for (const k of ["own", "lead"] as const) {
    const name = `ng_${k}_${stamp}`;
    const u = register(name, PW);
    user[k] = { id: u.user!.user_id, name, token: u.token! };
    expect(addNetworkMember(net, user[k].id, "member", user.boss.id, { agentAccess: "all" }).ok).toBe(true);
  }
  // mgr 是被授权的节点（主人 own）；a 在部门 A，b 在部门 B。
  for (const [key, owner] of [["mgr", "own"], ["a", "boss"], ["b", "boss"]] as const) {
    const alias = `ng-${key}-${stamp}`, id = `n_ng_${key}_${stamp}`;
    const t = createNetworkTokenForNode(user[owner].id, net, alias, id);
    expect(t.ok).toBe(true);
    node[key] = { id, alias, token: t.token! };
    db.run("INSERT INTO sessions (resume_id, alias, status, node_id, network_id) VALUES (?1, ?2, 'idle', ?3, ?4)", [`r_${id}`, alias, id, net]);
  }
  db.run("INSERT INTO network_departments (network_id, department_id, name, parent_id, sort, created_by, leader_user_id) VALUES (?1, ?2, 'A', NULL, 0, ?3, ?4)", [net, deptA, user.boss.id, user.lead.id]);
  db.run("INSERT INTO network_departments (network_id, department_id, name, parent_id, sort, created_by) VALUES (?1, ?2, 'B', NULL, 1, ?3)", [net, deptB, user.boss.id]);
  // board 判「卡的负责人所在部门」⇒ 成员要先有部门。
  db.run("UPDATE network_members SET department_id = ?1 WHERE network_id = ?2 AND user_id IN (?3, ?4)", [deptA, net, user.own.id, user.lead.id]);
  db.run("UPDATE network_members SET department_id = ?1 WHERE network_id = ?2 AND user_id = ?3", [deptB, net, user.boss.id]);
  db.run("UPDATE nodes SET department_id = ?1 WHERE node_id = ?2", [deptA, node.a.id]);
  db.run("UPDATE nodes SET department_id = ?1 WHERE node_id = ?2", [deptB, node.b.id]);
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
  schedA = await scheduleFor(node.a.id, "for-a");
  schedB = await scheduleFor(node.b.id, "for-b");
}, 60_000);
afterAll(() => { server?.stop?.(true); });

describe("PUT /api/nodes/:id/grants —— 谁能授", () => {
  test("/health 报 node_grants", async () => {
    const h = await (await fetch(`${base}/health`)).json() as any;
    expect(h.capabilities).toContain("node_grants");
  });
  test("网络 owner 可授全网；GET 读回；[] 清空", async () => {
    const r = await putGrants(user.boss.token, node.mgr.id, [{ capability: "schedules", scope_kind: "network", level: "read" }]);
    expect(r.status).toBe(200);
    expect(r.body.grants).toEqual([expect.objectContaining({ capability: "schedules", scope_kind: "network", scope_id: "", level: "read" })]);
    expect((await call(user.own.token, "GET", `/api/nodes/${node.mgr.id}/grants`)).body.grants.length).toBe(1);
    expect((await putGrants(user.boss.token, node.mgr.id, [])).body.grants).toEqual([]);
  });
  test("节点主人（普通成员）不能给自己的节点授权", async () => {
    const r = await putGrants(user.own.token, node.mgr.id, [{ capability: "schedules", scope_kind: "network", level: "edit" }]);
    expect(r.status).toBe(403);
  });
  test("部门负责人：授自己部门 OK，授全网 / 别的部门 403", async () => {
    expect((await putGrants(user.lead.token, node.mgr.id, [{ capability: "schedules", scope_kind: "department", scope_id: deptA, level: "edit" }])).status).toBe(200);
    expect((await putGrants(user.lead.token, node.mgr.id, [{ capability: "schedules", scope_kind: "network", level: "edit" }])).status).toBe(403);
    expect((await putGrants(user.lead.token, node.mgr.id, [{ capability: "schedules", scope_kind: "department", scope_id: deptB, level: "edit" }])).status).toBe(403);
    await putGrants(user.boss.token, node.mgr.id, []);
  });
  test("未知能力 400；board（第二期已开闸）200 且可读回；不存在的部门 404", async () => {
    expect((await putGrants(user.boss.token, node.mgr.id, [{ capability: "nope", scope_kind: "network" }])).body.error).toBe("invalid_capability");
    // 第二期：board 与 requirements 读写判定同批上线 ⇒ 写入不再被拒。
    expect((await putGrants(user.boss.token, node.mgr.id, [{ capability: "board", scope_kind: "network", level: "read" }])).status).toBe(200);
    const readBack = await call(user.boss.token, "GET", `/api/nodes/${node.mgr.id}/grants?network_id=${net}`);
    expect((readBack.body.grants || []).some((g: any) => g.capability === "board" && g.level === "read")).toBe(true);
    await putGrants(user.boss.token, node.mgr.id, []);
    expect((await putGrants(user.boss.token, node.mgr.id, [{ capability: "schedules", scope_kind: "department", scope_id: "dept_missing" }])).status).toBe(404);
  });

  test("部门负责人只能授本部门的 board（跨部门 403）", async () => {
    expect((await putGrants(user.lead.token, node.mgr.id, [{ capability: "board", scope_kind: "department", scope_id: deptA, level: "read" }])).status).toBe(200);
    expect((await putGrants(user.lead.token, node.mgr.id, [{ capability: "board", scope_kind: "department", scope_id: deptB, level: "read" }])).status).toBe(403);
    await putGrants(user.boss.token, node.mgr.id, []);
  });
});

describe("定时任务 —— 授权让节点看得到 / 改得了", () => {
  test("没授权：看不到别人的计划", async () => {
    await putGrants(user.boss.token, node.mgr.id, []);
    const ids = await listIds(node.mgr.token);
    expect(ids).not.toContain(schedA);
    expect((await mcp(node.mgr.token, "schedule_get", { schedule_id: schedA })).error).toBe("schedule_not_found");
  });
  test("network·read：看得到、改不了", async () => {
    await putGrants(user.boss.token, node.mgr.id, [{ capability: "schedules", scope_kind: "network", level: "read" }]);
    const ids = await listIds(node.mgr.token);
    expect(ids).toContain(schedA); expect(ids).toContain(schedB);
    expect((await mcp(node.mgr.token, "schedule_update", { schedule_id: schedA, name: "x" })).error).toBe("not_schedule_creator");
  });
  test("department(A)·edit：只覆盖目标在 A 的；能改能取消；审计一行", async () => {
    await putGrants(user.boss.token, node.mgr.id, [{ capability: "schedules", scope_kind: "department", scope_id: deptA, level: "edit" }]);
    const ids = await listIds(node.mgr.token);
    expect(ids).toContain(schedA); expect(ids).not.toContain(schedB);
    const upd = await mcp(node.mgr.token, "schedule_update", { schedule_id: schedA, name: "renamed by grant" });
    expect(upd.ok).toBe(true);
    expect(upd.schedule.name).toBe("renamed by grant");
    expect((await mcp(node.mgr.token, "schedule_update", { schedule_id: schedB, name: "nope" })).error).toBe("schedule_not_found");
    const audit = db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'schedule_changed_via_node_grant' AND target_id = ?1", schedA);
    expect(Number(audit!.n)).toBeGreaterThanOrEqual(1);
  });
  test("只读模式的节点：edit 降为 read", async () => {
    db.run("UPDATE nodes SET permission_mode = 'readonly' WHERE node_id = ?1", [node.mgr.id]);
    try {
      const r = await mcp(node.mgr.token, "schedule_update", { schedule_id: schedA, name: "should fail" });
      expect(r.ok).toBe(false);
    } finally {
      db.run("UPDATE nodes SET permission_mode = 'normal' WHERE node_id = ?1", [node.mgr.id]);
    }
  });
  test("撤销（[]）当场生效", async () => {
    await putGrants(user.boss.token, node.mgr.id, []);
    expect(await listIds(node.mgr.token)).not.toContain(schedA);
  });
});

// ── 第二期：任务看板（board）───────────────────────────────────────────────
// 判「卡的负责人所在部门」，与定时任务按「目标节点所在部门」不是一回事。
// 卡：A 的负责人在 deptA（部门负责人 lead 本人），B 的负责人在 deptB（网络 owner boss）。
// 被授权的节点 mgr 的主人是 own（deptA），但它看不到别人的卡 —— 所以下面看到 A 一定是授权带来的。
describe("任务看板 —— 授权让节点看得到 / 改得了", () => {
  let cardA = "", cardB = "";
  const cardIds = async (token: string) => ((await mcp(token, "requirements_list", { network_id: net })).requirements ?? []).map((r: any) => r.id);

  beforeAll(async () => {
    // 🔴 必须在 enforce 下测：默认 "log" 时节点根本不做范围收窄（nodeTaskCaller 返回 null），
    //    那样「授权后才看得到」和「撤销后看不到」都测不出来（无论有没有授权都看得见）。
    process.env.COMMHUB_NODE_PERMISSIONS = "enforce";
    const mk = async (name: string, ownerId: string) => {
      const r = await mcp(user.boss.token, "requirements_create", { network_id: net, name, owner: { kind: "user", id: ownerId } });
      const id = r.requirement?.id;
      expect(typeof id).toBe("string");
      return id as string;
    };
    cardA = await mk(`board A ${stamp}`, user.lead.id);
    cardB = await mk(`board B ${stamp}`, user.boss.id);
  });
  afterAll(() => { delete process.env.COMMHUB_NODE_PERMISSIONS; });

  test("没授权：别人的卡看不到，也改不了", async () => {
    await putGrants(user.boss.token, node.mgr.id, []);
    const ids = await cardIds(node.mgr.token);
    expect(ids).not.toContain(cardA); expect(ids).not.toContain(cardB);
    const upd = await mcp(node.mgr.token, "requirements_update", { network_id: net, id: cardA, description: "nope" });
    expect(upd.ok).not.toBe(true);
  });

  test("department(A)·read：看得到 A、看不到 B；B 是 not_found；改不了", async () => {
    await putGrants(user.boss.token, node.mgr.id, [{ capability: "board", scope_kind: "department", scope_id: deptA, level: "read" }]);
    const ids = await cardIds(node.mgr.token);
    expect(ids).toContain(cardA); expect(ids).not.toContain(cardB);
    expect((await mcp(node.mgr.token, "requirements_get", { network_id: net, id: cardB })).error).toBe("requirement_not_found");
    expect((await mcp(node.mgr.token, "requirements_update", { network_id: net, id: cardA, description: "read only" })).ok).not.toBe(true);
  });

  test("department(A)·edit：能改 A，审计 requirement_changed_via_node_grant；B 仍 not_found", async () => {
    await putGrants(user.boss.token, node.mgr.id, [{ capability: "board", scope_kind: "department", scope_id: deptA, level: "edit" }]);
    const upd = await mcp(node.mgr.token, "requirements_update", { network_id: net, id: cardA, description: "changed by grant" });
    expect(upd.ok).toBe(true);
    const audit = db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'requirement_changed_via_node_grant' AND target_id = ?1", cardA);
    expect(Number(audit!.n)).toBeGreaterThanOrEqual(1);
    expect((await mcp(node.mgr.token, "requirements_update", { network_id: net, id: cardB, description: "nope" })).error).toBe("requirement_not_found");
  });

  test("network·read：两张卡都能看到（不拼巨大 IN 列表）", async () => {
    await putGrants(user.boss.token, node.mgr.id, [{ capability: "board", scope_kind: "network", level: "read" }]);
    const ids = await cardIds(node.mgr.token);
    expect(ids).toContain(cardA); expect(ids).toContain(cardB);
  });

  test("只读模式的节点：edit 降为 read，改不动", async () => {
    await putGrants(user.boss.token, node.mgr.id, [{ capability: "board", scope_kind: "department", scope_id: deptA, level: "edit" }]);
    db.run("UPDATE nodes SET permission_mode = 'readonly' WHERE node_id = ?1", [node.mgr.id]);
    try {
      expect((await mcp(node.mgr.token, "requirements_update", { network_id: net, id: cardA, description: "should fail" })).ok).not.toBe(true);
      // 但看还是能看
      expect(await cardIds(node.mgr.token)).toContain(cardA);
    } finally {
      db.run("UPDATE nodes SET permission_mode = 'normal' WHERE node_id = ?1", [node.mgr.id]);
    }
  });

  test("撤销（[]）当场生效", async () => {
    await putGrants(user.boss.token, node.mgr.id, []);
    expect(await cardIds(node.mgr.token)).not.toContain(cardA);
  });
});
