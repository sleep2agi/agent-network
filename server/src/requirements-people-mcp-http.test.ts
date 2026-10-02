// #473(#469 问题 2)—— Agent 查人 + 人员字段按名字写。
//
// 钉住:
//   1. MCP requirements_people:紧凑行(user_id / username / display_name / role / department / agents),
//      没主人的 Agent 单列;q 按用户名 / 显示名 / 部门 / Agent 别名筛;50 人一页、offset 翻页;一页有字节上限。
//   2. 严格参数:不认识的参数 → -32602,列出能用的参数。
//   3. requirements_create / update / upsert 的 owner / agent_owner / participants 收 {kind:'user', username} 与
//      {kind:'node', alias},在任务所在的网络里解析,存下来仍是 {kind, id}。
//   4. 别名对上多个 Agent → person_ambiguous;找不到 → person_not_in_network;都带 field 和指向 requirements_people 的 hint。
//   5. 绝不跨网络:别的网络的用户名 / 别名都是「找不到」。受限成员看不见的 Agent:通讯录里没有,按别名写也是「找不到」。
//   6. REST GET /api/requirements/people 的形状不变。
//
// 跑法:cd server && COMMHUB_DB=/tmp/x.db bun test src/requirements-people-mcp-http.test.ts
//       PG:COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1(tests/test2123-hub-postgres-ladder 里注册)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { addNetworkMember, register } from "./auth.js";
import { db } from "./db.js";
import { createDepartment, setMemberDepartment } from "./departments.js";
import { registerTools } from "./tools.js";

const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("requirements-people-mcp requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now();
const PW = "PeopleLookup123!";
/** 一页 50 人(每人带部门、1 个 Agent)的字节上限。实测约 12.6 KB(≈ 250 B / 人);上限 16 KB。 */
const PAGE_MAX_BYTES = 16_000;
const EXTRA_MEMBERS = 60;

let server: any;
let base = "";
let netA = "", netB = "";
let boss: { id: string; token: string; username: string };
let alice: { id: string; username: string };
let bob: { id: string; username: string };
let carol: { id: string; username: string };
let ruth: { id: string; username: string };
let deptId = "";
const node = (suffix: string) => `n_pl_${suffix}_${stamp}`;
const ALIAS = { alice: `alice-bot-${stamp}`, dup: `dup-bot-${stamp}`, free: `free-bot-${stamp}`, far: `far-bot-${stamp}` };

type Mcp = { call: (name: string, args: Record<string, unknown>) => Promise<any>; close: () => Promise<void> };
async function connect(userId: string, username: string): Promise<Mcp> {
  const s = new McpServer({ name: "people", version: "1" });
  registerTools(s, undefined, null, userId, username, false, "tok_user");
  const client = new Client({ name: "people-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await s.connect(st);
  await client.connect(ct);
  return {
    call: async (name, args) => {
      const r: any = await client.callTool({ name, arguments: args });
      const text = String(r.content?.[0]?.text ?? "");
      if (r.isError) return { mcpError: true, text };
      return { ...JSON.parse(text), _bytes: Buffer.byteLength(text, "utf8") };
    },
    close: async () => { await client.close(); await s.close(); },
  };
}
let asBoss: Mcp, asRuth: Mcp;

function mk(name: string) {
  const r = register(`${name}_${stamp}`, PW, undefined, name === "alice" ? "爱丽丝" : undefined);
  expect(r.ok).toBe(true);
  return { id: r.user!.user_id, token: r.token!, username: r.user!.username, net: r.network_id! };
}
const insertNode = (id: string, alias: string, net: string, owner: string | null) =>
  db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id) VALUES (?1, ?2, ?2, ?3, ?4)", [id, alias, net, owner]);

beforeAll(async () => {
  const b = mk("boss"); boss = { id: b.id, token: b.token, username: b.username }; netA = b.net;
  const a = mk("alice"); alice = { id: a.id, username: a.username };
  const o = mk("bob"); bob = { id: o.id, username: o.username };
  const c = mk("carol"); carol = { id: c.id, username: c.username }; netB = c.net;
  const r = mk("ruth"); ruth = { id: r.id, username: r.username };
  expect(addNetworkMember(netA, alice.id, "member", boss.id, { agentAccess: "all" }).ok).toBe(true);
  expect(addNetworkMember(netA, bob.id, "member", boss.id, { agentAccess: "all" }).ok).toBe(true);
  // ruth:受限成员(只看授权的 Agent),一个都没授权
  expect(addNetworkMember(netA, ruth.id, "member", boss.id, { agentAccess: "granted" }).ok).toBe(true);
  const dept = createDepartment(netA, boss.id, { name: `研发部${stamp % 1000}` });
  expect(dept.ok).toBe(true);
  deptId = (dept as any).department.id;
  expect(setMemberDepartment(netA, alice.id, deptId).ok).toBe(true);
  insertNode(node("alice"), ALIAS.alice, netA, alice.id);
  insertNode(node("dup1"), ALIAS.dup, netA, null);
  insertNode(node("dup2"), ALIAS.dup, netA, null);
  insertNode(node("free"), ALIAS.free, netA, null);
  insertNode(node("far"), ALIAS.far, netB, carol.id);
  for (let i = 0; i < EXTRA_MEMBERS; i++) {
    const m = register(`pl_m${String(i).padStart(2, "0")}_${stamp}`, PW, undefined, `成员${i}`);
    expect(addNetworkMember(netA, m.user!.user_id, "member", boss.id, { agentAccess: "all" }).ok).toBe(true);
    setMemberDepartment(netA, m.user!.user_id, deptId);
    insertNode(node(`m${i}`), `m${i}-bot-${stamp}`, netA, m.user!.user_id);
  }
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
  asBoss = await connect(boss.id, boss.username);
  asRuth = await connect(ruth.id, ruth.username);
}, 120_000);
afterAll(async () => { await asBoss?.close(); await asRuth?.close(); server?.stop?.(true); });

describe("#473 requirements_people", () => {
  test("compact rows: username, display_name, role, department, owned agents; unowned agents listed once", async () => {
    const r = await asBoss.call("requirements_people", { network_id: netA, q: "alice" });
    expect(r.ok).toBe(true);
    expect(r.people).toEqual([{
      user_id: alice.id, username: alice.username, display_name: "爱丽丝", role: "member",
      department: { id: deptId, name: `研发部${stamp % 1000}` }, agents: [{ node_id: node("alice"), alias: ALIAS.alice }],
    }]);
    const all = await asBoss.call("requirements_people", { network_id: netA, q: String(stamp) });
    expect(all.agents_without_owner.map((a: any) => a.alias).sort()).toEqual([ALIAS.dup, ALIAS.dup, ALIAS.free].sort());
    const bossRow = (await asBoss.call("requirements_people", { network_id: netA, q: boss.username })).people[0];
    expect(bossRow.role).toBe("owner");
    expect(bossRow.display_name).toBe("");
    expect(bossRow.department).toBeNull();
  });

  test("q matches username, display name, department and Agent alias", async () => {
    expect((await asBoss.call("requirements_people", { network_id: netA, q: "爱丽" })).people.map((p: any) => p.user_id)).toEqual([alice.id]);
    expect((await asBoss.call("requirements_people", { network_id: netA, q: ALIAS.alice.toUpperCase() })).people.map((p: any) => p.user_id)).toEqual([alice.id]);
    const dept = await asBoss.call("requirements_people", { network_id: netA, q: `研发部${stamp % 1000}`, limit: 200 });
    expect(dept.total).toBe(EXTRA_MEMBERS + 1);
  });

  test("default page = 50 people under the byte bound; offset pages the rest", async () => {
    const p1 = await asBoss.call("requirements_people", { network_id: netA });
    expect(p1.people.length).toBe(50);
    expect(p1.has_more).toBe(true);
    console.log(`people page of 50: ${p1._bytes} B`);
    expect(p1._bytes).toBeLessThan(PAGE_MAX_BYTES);
    const p2 = await asBoss.call("requirements_people", { network_id: netA, offset: p1.next_offset });
    expect(p2.people.length).toBe(p1.total - 50);
    expect(p2.agents_without_owner).toBeUndefined();
    expect(new Set([...p1.people, ...p2.people].map((p: any) => p.user_id)).size).toBe(p1.total);
  });

  test("strict params: unknown key → -32602 listing the valid ones", async () => {
    const r = await asBoss.call("requirements_people", { network_id: netA, name: "alice" });
    expect(r.mcpError).toBe(true);
    expect(r.text).toContain("-32602");
    expect(r.text).toContain("unknown parameter(s): name; valid parameters: network_id, q, limit, offset");
  });

  test("another network is not readable; a restricted member sees no ungranted Agents", async () => {
    const other = await asBoss.call("requirements_people", { network_id: netB });
    expect(other.ok).toBe(false);
    const r = await asRuth.call("requirements_people", { network_id: netA, q: String(stamp), limit: 200 });
    expect(r.people.every((p: any) => p.agents.length === 0)).toBe(true);
    expect(r.agents_without_owner).toEqual([]);
  });
});

describe("#473 person fields by name", () => {
  test("create / update / upsert accept username and alias; stored as ids in this network", async () => {
    const made = await asBoss.call("requirements_create", {
      network_id: netA, name: `by name ${stamp}`,
      owner: { kind: "user", username: alice.username },
      agent_owner: { kind: "node", alias: ALIAS.alice },
      participants: [{ kind: "user", username: bob.username }, { kind: "node", alias: ALIAS.free }],
    });
    expect(made.ok).toBe(true);
    const req = made.requirement;
    expect(req.owner).toEqual({ kind: "user", id: alice.id });
    expect(req.agent_owner).toEqual({ kind: "node", id: node("alice") });
    expect(req.participants).toEqual([{ kind: "user", id: bob.id }, { kind: "node", id: node("free") }]);

    const upd = await asBoss.call("requirements_update", { id: req.id, network_id: netA, owner: { kind: "user", username: bob.username } });
    expect(upd.requirement.owner).toEqual({ kind: "user", id: bob.id });

    const ups = await asBoss.call("requirements_upsert_by_external_ref", {
      network_id: netA, external_ref: `test:people#${stamp}`, name: "upserted", agent_owner: { kind: "node", alias: ALIAS.alice },
    });
    expect(ups.requirement.agent_owner).toEqual({ kind: "node", id: node("alice") });
    // id 照旧可用,且优先于名字
    const byId = await asBoss.call("requirements_update", { id: req.id, network_id: netA, owner: { kind: "user", id: alice.id, username: bob.username } });
    expect(byId.requirement.owner).toEqual({ kind: "user", id: alice.id });
  });

  test("ambiguous alias → person_ambiguous with field and a requirements_people hint", async () => {
    const r = await asBoss.call("requirements_create", { network_id: netA, name: "amb", agent_owner: { kind: "node", alias: ALIAS.dup } });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("person_ambiguous");
    expect(r.field).toBe("agent_owner");
    expect(r.hint).toContain("requirements_people");
    expect(r.hint).toContain("node_id");
  });

  test("unknown name → person_not_in_network naming the field and requirements_people", async () => {
    const r = await asBoss.call("requirements_create", { network_id: netA, name: "nope", participants: [{ kind: "user", username: `ghost_${stamp}` }] });
    expect(r.error).toBe("person_not_in_network");
    expect(r.field).toBe("participants");
    expect(r.hint).toContain("requirements_people");
  });

  test("never across networks: another network's username / alias is not found", async () => {
    const u = await asBoss.call("requirements_create", { network_id: netA, name: "x", owner: { kind: "user", username: carol.username } });
    expect(u.error).toBe("person_not_in_network");
    const n = await asBoss.call("requirements_create", { network_id: netA, name: "x", agent_owner: { kind: "node", alias: ALIAS.far } });
    expect(n.error).toBe("person_not_in_network");
  });

  test("wrong-kind or missing identifier → invalid_person", async () => {
    for (const bad of [{ kind: "user", alias: ALIAS.alice }, { kind: "node", username: alice.username }, { kind: "user" }]) {
      const r = await asBoss.call("requirements_create", { network_id: netA, name: "bad", participants: [bad] });
      expect(r.error).toBe("invalid_person");
      expect(r.hint).toContain("requirements_people");
    }
  });

  test("a restricted member cannot resolve an Agent alias they are not granted", async () => {
    const r = await asRuth.call("requirements_create", { network_id: netA, name: "hidden", agent_owner: { kind: "node", alias: ALIAS.alice } });
    expect(r.error).toBe("person_not_in_network");
  });

  test("REST GET /api/requirements/people keeps its shape", async () => {
    const res = await fetch(`${base}/api/requirements/people?network_id=${netA}`, { headers: { Authorization: `Bearer ${boss.token}` } });
    const body = await res.json() as any;
    expect(res.status).toBe(200);
    for (const p of body.people) expect(Object.keys(p).sort()).toEqual(["display_name", "id", "kind", "name", "networkId"]);
  });
});
