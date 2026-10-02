// #475(MCP 任务生命周期测试报告问题 6)—— Agent 写任务时两处常见的坑:
//   - status 当 column 用(列表的筛选参数就叫 status):MCP 的 create / update / upsert 把 status 当 column 的别名,
//     两个都给且不同 → 400 status_conflicts_with_column;REST 不变(仍是 empty_patch + 提示用 column)。
//   - participants 是整体替换,Agent 想「加一个人」时把别人全删了:新增 participants_add / participants_remove,
//     在当前列表上加减、同一次同步读改写里完成;加已有 = 不变,减不在的 = 不变。
// 外加 #476 第 1 部分:项目工具的描述写明节点令牌只能读项目(行为本来就是 403 user_token_required)。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-req-status-part-"));
let BASE = "";
let hub: any = null;
const PW = "ReqStatusPartPassw0rd!xyz";
let NET = "";
const U: Record<string, { token: string; id: string }> = {};

async function rest(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
async function rpc(token: string, method: string, params: Record<string, unknown>) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const raw = await res.text();
  const lines = raw.split("\n").filter(x => x.startsWith("data:"));
  return lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
}
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const out = await rpc(token, "tools/call", { name, arguments: args });
  const text = out.result?.content?.[0]?.text ?? "";
  try { return JSON.parse(text); } catch { return { raw: out, text }; }
}
const keys = (refs: { kind: string; id: string }[]) => refs.map(r => `${r.kind}:${r.id}`).sort();
const row = (id: string) => db.get<{ column_name: string; participants_json: string; updated_at: string }>("SELECT column_name, participants_json, updated_at FROM requirements WHERE requirement_id = ?1", id)!;
const participantEvents = (id: string) => db.get<{ n: number }>("SELECT COUNT(*) AS n FROM requirement_events WHERE requirement_id = ?1 AND field = 'participants'", id)!.n;

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`sp_owner_${Date.now()}`, PW, undefined, "Owner");
  U.owner = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const username = `sp_member_${Date.now()}`;
  expect((await rest(U.owner.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role: "member" })).status).toBe(200);
  const login = await rest("", "POST", "/api/auth/login", { username, password: PW });
  U.member = { token: login.body.token, id: login.body.user.user_id };
  for (const [k, alias] of [["nodeA", "示例-甲"], ["nodeB", "示例-乙"], ["nodeC", "示例-丙"]] as const) {
    const nodeId = `node_sp_${k}`;
    U[k] = { token: createNetworkTokenForNode(U.owner.id, NET, alias, nodeId).token!, id: nodeId };
  }
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("status is an alias of column (MCP)", () => {
  test("create / update / upsert with status land exactly where column would", async () => {
    const viaStatus = (await mcp(U.nodeA.token, "requirements_create", { name: "示例:status 建", status: "doing" })).requirement;
    const viaColumn = (await mcp(U.nodeA.token, "requirements_create", { name: "示例:column 建", column: "doing" })).requirement;
    expect(viaStatus.column).toBe("doing");
    expect(viaStatus.column).toBe(viaColumn.column);

    const done = await mcp(U.nodeA.token, "requirements_update", { id: `#${viaStatus.seq}`, status: "done" });
    expect(done.requirement.column).toBe("done");
    expect(done.requirement.completedAt).toBeTruthy(); // same side effects as column=done
    expect(row(viaStatus.id).column_name).toBe("done");

    const same = await mcp(U.nodeA.token, "requirements_update", { id: viaColumn.id, status: "pool", column: "pool" });
    expect(same.requirement.column).toBe("pool");

    const up = await mcp(U.nodeA.token, "requirements_upsert_by_external_ref", { external_ref: "demo:status-alias-1", name: "示例:upsert", status: "doing" });
    expect(up.created).toBe(true);
    expect(up.requirement.column).toBe("doing");
  });

  test("status and column both sent and different → 400 status_conflicts_with_column with a hint; nothing written", async () => {
    const card = (await mcp(U.nodeA.token, "requirements_create", { name: "示例:冲突", column: "pool" })).requirement;
    const before = row(card.id);
    const r = await mcp(U.nodeA.token, "requirements_update", { id: card.id, status: "doing", column: "done" });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.error).toBe("status_conflicts_with_column");
    expect(r.field).toBe("status");
    expect(r.hint).toContain("only one");
    expect(row(card.id)).toEqual(before);
    const c = await mcp(U.nodeA.token, "requirements_create", { name: "示例:冲突建", status: "doing", column: "done" });
    expect(c.error).toBe("status_conflicts_with_column");
  });

  test("a bad status value is a schema error (-32602), like a bad column", async () => {
    const out = await rpc(U.nodeA.token, "tools/call", { name: "requirements_update", arguments: { id: "#1", status: "finished" } });
    expect(String(out.error?.code ?? out.result?.content?.[0]?.text)).toMatch(/-32602|invalid/i);
  });

  test("REST is unchanged: status on PATCH is still not a writable field", async () => {
    const card = (await mcp(U.nodeA.token, "requirements_create", { name: "示例:REST", column: "pool" })).requirement;
    const r = await rest(U.member.token, "PATCH", `/api/requirements/${card.id}`, { status: "doing" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("empty_patch");
    expect(row(card.id).column_name).toBe("pool");
  });
});

describe("participants_add / participants_remove", () => {
  let card = { id: "", seq: 0 };
  const node = (k: string) => ({ kind: "node", id: U[k].id });
  const user = (k: string) => ({ kind: "user", id: U[k].id });

  test("add keeps the people already there", async () => {
    card = (await mcp(U.nodeA.token, "requirements_create", { name: "示例:参与人", participants: [user("member"), node("nodeA")] })).requirement;
    const r = await mcp(U.nodeA.token, "requirements_update", { id: `#${card.seq}`, participants_add: [node("nodeB")] });
    expect(keys(r.requirement.participants)).toEqual(keys([user("member"), node("nodeA"), node("nodeB")]));
    expect(keys(JSON.parse(row(card.id).participants_json))).toEqual(keys([user("member"), node("nodeA"), node("nodeB")]));
  });

  test("add is idempotent: someone already there → same list, no participants event", async () => {
    const events = participantEvents(card.id);
    const r = await mcp(U.nodeA.token, "requirements_update", { id: card.id, participants_add: [node("nodeB"), node("nodeA")] });
    expect(keys(r.requirement.participants)).toEqual(keys([user("member"), node("nodeA"), node("nodeB")]));
    expect(participantEvents(card.id)).toBe(events);
  });

  test("remove drops only those people; removing someone absent (or no longer in the network) is a no-op", async () => {
    const r = await mcp(U.nodeA.token, "requirements_update", { id: card.id, participants_remove: [user("member"), { kind: "user", id: "u_left_the_network" }] });
    expect(r.ok).toBe(true);
    expect(keys(r.requirement.participants)).toEqual(keys([node("nodeA"), node("nodeB")]));
  });

  test("add and remove in one call are applied together", async () => {
    const r = await mcp(U.nodeA.token, "requirements_update", { id: card.id, participants_add: [node("nodeC"), user("member")], participants_remove: [node("nodeA")] });
    expect(keys(r.requirement.participants)).toEqual(keys([node("nodeB"), node("nodeC"), user("member")]));
  });

  test("concurrent adds from two Agents both stick (no lost update)", async () => {
    const fresh = (await mcp(U.owner.token, "requirements_create", { name: "示例:并发", participants: [user("owner")], network_id: NET })).requirement;
    await Promise.all([
      mcp(U.nodeA.token, "requirements_update", { id: fresh.id, participants_add: [node("nodeA")] }),
      mcp(U.nodeB.token, "requirements_update", { id: fresh.id, participants_add: [node("nodeB")] }),
      mcp(U.nodeC.token, "requirements_update", { id: fresh.id, participants_add: [node("nodeC")] }),
    ]);
    expect(keys(JSON.parse(row(fresh.id).participants_json))).toEqual(keys([user("owner"), node("nodeA"), node("nodeB"), node("nodeC")]));
  });

  test("name forms (#473): add by alias / username, remove by username", async () => {
    const fresh = (await mcp(U.nodeA.token, "requirements_create", { name: "示例:按名字", participants: [node("nodeA")] })).requirement;
    const memberName = db.get<{ username: string }>("SELECT username FROM users WHERE user_id = ?1", U.member.id)!.username;
    const added = await mcp(U.nodeA.token, "requirements_update", { id: fresh.id, participants_add: [{ kind: "node", alias: "示例-乙" }, { kind: "user", username: memberName }] });
    expect(keys(added.requirement.participants)).toEqual(keys([node("nodeA"), node("nodeB"), user("member")]));
    const removed = await mcp(U.nodeA.token, "requirements_update", { id: fresh.id, participants_remove: [{ kind: "user", username: memberName }] });
    expect(keys(removed.requirement.participants)).toEqual(keys([node("nodeA"), node("nodeB")]));
  });

  test("participants is still a full replace", async () => {
    const r = await mcp(U.nodeA.token, "requirements_update", { id: card.id, participants: [node("nodeA")] });
    expect(keys(r.requirement.participants)).toEqual(keys([node("nodeA")]));
  });

  test("bad combinations → 400 with hints, nothing written", async () => {
    const before = row(card.id);
    const both = await mcp(U.nodeA.token, "requirements_update", { id: card.id, participants: [], participants_add: [node("nodeB")] });
    expect(both.status).toBe(400);
    expect(both.error).toBe("participants_conflict");
    expect(both.hint).toContain("participants_add");
    const overlap = await mcp(U.nodeA.token, "requirements_update", { id: card.id, participants_add: [node("nodeB")], participants_remove: [node("nodeB")] });
    expect(overlap.error).toBe("participants_add_remove_overlap");
    const stranger = await mcp(U.nodeA.token, "requirements_update", { id: card.id, participants_add: [{ kind: "node", id: "node_not_here" }] });
    expect(stranger.error).toBe("person_not_in_network");
    expect(stranger.field).toBe("participants_add");
    expect(row(card.id)).toEqual(before);
  });

  test("REST accepts the same keys (additive; old clients never send them)", async () => {
    const r = await rest(U.member.token, "PATCH", `/api/requirements/${card.id}`, { participants_add: [user("member")] });
    expect(r.status).toBe(200);
    // the member has no grant on nodeA, so the response leaves it out — but the stored list keeps it
    expect(keys(JSON.parse(row(card.id).participants_json))).toEqual(keys([node("nodeA"), user("member")]));
    expect(keys(r.body.requirement.participants)).toEqual(keys([user("member")]));
    // …and the member cannot remove an Agent they cannot see (same error as a node that does not exist)
    const hidden = await rest(U.member.token, "PATCH", `/api/requirements/${card.id}`, { participants_remove: [node("nodeA")] });
    expect(hidden.status).toBe(400);
    expect(hidden.body.error).toBe("person_not_in_network");
    expect(keys(JSON.parse(row(card.id).participants_json))).toEqual(keys([node("nodeA"), user("member")]));
  });
});

describe("tool descriptions", () => {
  test("participants says it replaces; projects tools say node tokens only read; node token project write → 403", async () => {
    const tools = (await rpc(U.nodeA.token, "tools/list", {})).result.tools as any[];
    const byName = new Map(tools.map(t => [t.name, t]));
    const update = byName.get("requirements_update");
    expect(update.description).toContain("REPLACES the whole list");
    expect(update.inputSchema.properties.participants.description).toContain("REPLACES");
    expect(Object.keys(update.inputSchema.properties)).toEqual(expect.arrayContaining(["status", "participants_add", "participants_remove"]));
    // #478:节点令牌的 tools/list 里本来就没有 projects_create / projects_update(调了也是 403),那两条的说明从人的列表里读。
    expect(byName.has("projects_create")).toBe(false);
    const human = new Map(((await rpc(U.member.token, "tools/list", {})).result.tools as any[]).map(t => [t.name, t]));
    expect(byName.get("projects_list").description).toMatch(/node \(Agent\) tokens can only read projects/i);
    for (const name of ["projects_create", "projects_update"]) expect(human.get(name).description).toMatch(/node \(Agent\) tokens can only read projects/i);
    const denied = await mcp(U.nodeA.token, "projects_create", { name: "示例项目" });
    expect(denied.status).toBe(403);
    expect(denied.error).toBe("user_token_required");
  });
});
