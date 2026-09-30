// 任务短号 seq:新建领号(并发不撞)、按网络各自编号、按 #N 查 / 改、删除和归档不回收号、MCP 工具也收 #N。
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-req-seq-"));
process.env.COMMHUB_DB = join(dir, "hub.db");

let server: { port: number; stop?: (force?: boolean) => void };
let base = "";
let ownerToken = "", otherToken = "", nodeToken = "";
let ownerNet = "", otherNet = "", ownerId = "", otherId = "";

async function api(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init?.headers || {}) } });
  return { status: res.status, body: await res.json() as any };
}
const create = (token: string, body: Record<string, unknown>, query = "") => api(token, `/api/requirements${query}`, { method: "POST", body: JSON.stringify(body) });

beforeAll(async () => {
  const { register, createNetworkTokenForNode } = await import("./auth.js");
  // 第一个注册的用户是 Hub 管理员、作用域是全部网络;让它先占掉,下面两个是普通用户(各自一个网络)。
  register(`seq_admin_${Date.now()}`, "SeqAdmin123!x", undefined, "seed");
  const o = register(`seq_owner_${Date.now()}`, "SeqOwner123!x", undefined, "seed");
  const x = register(`seq_other_${Date.now()}`, "SeqOther123!x", undefined, "seed");
  ownerToken = o.token!; ownerNet = o.network_id!; ownerId = o.user!.user_id;
  otherToken = x.token!; otherNet = x.network_id!; otherId = x.user!.user_id;
  nodeToken = createNetworkTokenForNode(ownerId, ownerNet, "seq-node").token!;
  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("requirement short numbers (#N)", () => {
  test("capability is advertised and create returns seq", async () => {
    const list = await api(ownerToken, "/api/requirements");
    expect(list.body.capabilities).toContain("requirement_seq");
    const first = await create(ownerToken, { name: "第一张" });
    expect(first.status).toBe(201);
    expect(first.body.requirement.seq).toBe(1);
    expect(first.body.requirement.id).toMatch(/^req_/);
    const got = await api(ownerToken, `/api/requirements/${first.body.requirement.id}`);
    expect(got.body.requirement.seq).toBe(1);
    expect((await api(ownerToken, "/api/requirements")).body.requirements[0].seq).toBe(1);
  });

  test("concurrent creates get distinct, gap-free seqs", async () => {
    const before = (await create(ownerToken, { name: "before" })).body.requirement.seq as number;
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => create(i % 2 ? nodeToken : ownerToken, { name: `并发 ${i}` })));
    expect(results.every(r => r.status === 201)).toBe(true);
    const seqs = results.map(r => r.body.requirement.seq as number).sort((a, b) => a - b);
    expect(new Set(seqs).size).toBe(40);
    expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => before + 1 + i));
  });

  test("seq is per network", async () => {
    const a = await create(otherToken, { name: "别的网络第一张" });
    expect(a.body.requirement.seq).toBe(1);
    const b = await create(otherToken, { name: "别的网络第二张" });
    expect(b.body.requirement.seq).toBe(2);
    // 同一个 #1 在两个网络各指各的卡
    expect((await api(ownerToken, "/api/requirements/%231")).body.requirement.name).toBe("第一张");
    expect((await api(otherToken, "/api/requirements/%231")).body.requirement.name).toBe("别的网络第一张");
    // 别的网络的号查不到对方的卡
    expect((await api(otherToken, "/api/requirements/%2310")).status).toBe(404);
  });

  test("lookup and patch by #N; list filter ?seq=; malformed forms rejected", async () => {
    const c = (await create(ownerToken, { name: "按号查", checklist: [{ id: "a", text: "一" }] })).body.requirement;
    const ref = `%23${c.seq}`;
    const got = await api(ownerToken, `/api/requirements/${ref}`);
    expect(got.status).toBe(200);
    expect(got.body.requirement.id).toBe(c.id);
    const patched = await api(nodeToken, `/api/requirements/${ref}`, { method: "PATCH", body: JSON.stringify({ column: "doing" }) });
    expect(patched.status).toBe(200);
    expect(patched.body.requirement.column).toBe("doing");
    expect(patched.body.requirement.seq).toBe(c.seq); // 改卡不改号
    const ticked = await api(ownerToken, `/api/requirements/${ref}/checklist/a`, { method: "PATCH", body: JSON.stringify({ done: true }) });
    expect(ticked.body.requirement.checklist[0].done).toBe(true);
    const listed = await api(ownerToken, `/api/requirements?seq=${c.seq}`);
    expect(listed.body.requirements.map((r: any) => r.id)).toEqual([c.id]);
    expect((await api(ownerToken, "/api/requirements?seq=abc")).status).toBe(400);
    expect((await api(ownerToken, "/api/requirements?seq=0")).status).toBe(400);
    // 旧 id 照常;裸数字、「#」「#0」「#-1」都不是短号,按 id 查 → 404
    expect((await api(ownerToken, `/api/requirements/${c.id}`)).body.requirement.seq).toBe(c.seq);
    for (const bad of [String(c.seq), "%23", "%230", "%23-1", `%23${c.seq}x`]) expect((await api(ownerToken, `/api/requirements/${bad}`)).status).toBe(404);
  });

  test("deleting or archiving never frees a number", async () => {
    const top = (await create(ownerToken, { name: "最大号" })).body.requirement;
    expect((await api(ownerToken, `/api/requirements/%23${top.seq}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(ownerToken, `/api/requirements/%23${top.seq}`)).status).toBe(404);
    const next = (await create(ownerToken, { name: "删之后" })).body.requirement;
    expect(next.seq).toBe(top.seq + 1);
    await api(ownerToken, `/api/requirements/${next.id}`, { method: "PATCH", body: JSON.stringify({ archived: true }) });
    expect((await create(ownerToken, { name: "归档之后" })).body.requirement.seq).toBe(next.seq + 1);
    // 归档的卡按号照样能查到
    expect((await api(ownerToken, `/api/requirements/%23${next.seq}`)).body.requirement.archived).toBe(true);
  });

  test("a create that loses on client_id / external_ref does not burn a number", async () => {
    const a = (await create(ownerToken, { name: "幂等", client_id: "seq-client-1" })).body.requirement;
    const again = await create(ownerToken, { name: "幂等", client_id: "seq-client-1" });
    expect(again.body.requirement.seq).toBe(a.seq);
    await create(ownerToken, { name: "外部", external_ref: "github:acme/seq#1" });
    expect((await create(ownerToken, { name: "外部", external_ref: "github:acme/seq#1" })).status).toBe(409);
    const after = (await create(ownerToken, { name: "之后" })).body.requirement;
    expect(after.seq).toBe(a.seq + 2);
    // upsert 新建也领号,改的时候号不变
    const up = await api(ownerToken, "/api/requirements/upsert", { method: "POST", body: JSON.stringify({ name: "同步", external_ref: "github:acme/seq#2" }) });
    expect(up.body.requirement.seq).toBe(after.seq + 1);
    const up2 = await api(ownerToken, "/api/requirements/upsert", { method: "POST", body: JSON.stringify({ name: "同步改名", external_ref: "github:acme/seq#2" }) });
    expect(up2.body.requirement.seq).toBe(after.seq + 1);
  });

  test("a user whose scope spans two networks gets 409 ambiguous_seq for #N, and network_id resolves it", async () => {
    const { db } = await import("./db.js");
    const { addNetworkMember } = await import("./auth.js");
    // 看全网的成员(RFC-038 §9 之前的语义):这里测的是跨网络 #N 歧义,不是任务范围。
    addNetworkMember(otherNet, ownerId, "member", otherId, { taskAccess: "all" });
    const both = await api(ownerToken, "/api/requirements/%231");
    expect(both.status).toBe(409);
    expect(both.body.error).toBe("ambiguous_seq");
    expect(both.body.networks.sort()).toEqual([ownerNet, otherNet].sort());
    expect(both.body.message).toContain("pass network_id");
    // MCP 上用户令牌(跨两个网络)同样:清楚的错误 + 带 network_id 就能查到
    {
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
      const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
      const { registerTools } = await import("./tools.js");
      const mcp = new McpServer({ name: "seq-mcp-user", version: "1" });
      registerTools(mcp, undefined, null, ownerId, "seq-owner", false, "tok_user");
      const client = new Client({ name: "seq-mcp-user-client", version: "1" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await mcp.connect(st); await client.connect(ct);
      const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })) as any).content[0].text);
      try {
        const amb = await call("requirements_get", { id: "#1" });
        expect(amb.ok).toBe(false);
        expect(amb.error).toBe("ambiguous_seq");
        expect(amb.status).toBe(409);
        expect(amb.message).toContain("pass network_id");
        expect((await call("requirements_update", { id: "#1", priority: "low" })).error).toBe("ambiguous_seq");
        expect((await call("requirements_get", { id: "#1", network_id: otherNet })).requirement.name).toBe("别的网络第一张");
        expect((await call("requirements_get", { id: "#1", network_id: ownerNet })).requirement.name).toBe("第一张");
      } finally { await client.close(); await mcp.close(); }
    }
    // 旧 id 不受影响
    const firstId = (await api(ownerToken, `/api/requirements/%231?network_id=${ownerNet}`)).body.requirement.id;
    expect((await api(ownerToken, `/api/requirements/${firstId}`)).status).toBe(200);
    const scoped = await api(ownerToken, `/api/requirements/%231?network_id=${otherNet}`);
    expect(scoped.status).toBe(200);
    expect(scoped.body.requirement.name).toBe("别的网络第一张");
    db.run("DELETE FROM network_members WHERE network_id = ?1 AND user_id = ?2", [otherNet, ownerId]);
  });

  test("MCP tools accept #N and expose seq", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    const { registerTools } = await import("./tools.js");
    const { db } = await import("./db.js");
    const tokenId = db.get<{ token_id: string }>("SELECT token_id FROM api_tokens WHERE network_id = ?1 AND name LIKE 'node:%' LIMIT 1", ownerNet)?.token_id ?? null;
    const mcp = new McpServer({ name: "seq-mcp", version: "1" });
    registerTools(mcp, undefined, ownerNet, ownerId, "seq-node", true, tokenId);
    const client = new Client({ name: "seq-mcp-client", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await mcp.connect(st); await client.connect(ct);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r: any = await client.callTool({ name, arguments: args });
      return r.isError ? { mcpError: true } : JSON.parse(r.content[0].text);
    };
    try {
      const made = await call("requirements_create", { name: "MCP 建的", checklist: [{ id: "k", text: "一" }] });
      expect(Number.isInteger(made.requirement.seq)).toBe(true);
      const n = `#${made.requirement.seq}`;
      expect((await call("requirements_get", { id: n })).requirement.id).toBe(made.requirement.id);
      expect((await call("requirements_update", { id: n, priority: "high" })).requirement.priority).toBe("high");
      expect((await call("requirements_checklist_toggle", { id: n, item_id: "k", done: true })).requirement.checklist[0].done).toBe(true);
      const listed = await call("requirements_list", { seq: made.requirement.seq });
      expect(listed.requirements.map((r: any) => r.id)).toEqual([made.requirement.id]);
      expect((await call("requirements_list", { seq: 0 })).mcpError).toBe(true);
      expect((await call("requirements_get", { id: "#1" })).requirement.name).toBe("第一张"); // 节点令牌只看自己网络的 #1
    } finally { await client.close(); await mcp.close(); }
  });
});
