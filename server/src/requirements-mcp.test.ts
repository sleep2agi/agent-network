// 需求池 MCP 工具:走真 MCP in-process transport。Agent(节点令牌)在自己网络里读 / 建 / 改 / 勾 / upsert、
// 别的网络的节点碰不到、删除不存在于工具里(只有人能在 REST 删)。同步场景:同一个 GitHub issue 同步两次不重复。
// 跑法:cd server && COMMHUB_DB=/tmp/req-mcp.db bun test src/requirements-mcp.test.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-req-mcp-"));
process.env.COMMHUB_DB = join(dir, "hub.db");

const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
const { db } = await import("./db.js");
const { register, createNetworkTokenForNode } = await import("./auth.js");
const { registerTools } = await import("./tools.js");

type Identity = { net: string; user: string; alias: string; isNetworkToken: boolean; tokenId: string };
let owner: Identity, bot: Identity, foreignBot: Identity;
let ownerNet = "";

async function connect(id: Identity) {
  const server = new McpServer({ name: "req-mcp-test", version: "1" });
  registerTools(server, undefined, id.isNetworkToken ? id.net : null, id.user, id.alias, id.isNetworkToken, id.tokenId);
  const client = new Client({ name: "req-mcp-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    const first = r.content?.[0];
    if (r.isError) return { mcpError: true, text: first?.text };
    return JSON.parse(first.text);
  };
  return { server, call, close: async () => { await client.close(); await server.close(); } };
}

beforeAll(() => {
  const o = register(`reqmcp_owner_${Date.now()}`, "ReqMcpOwner123!", undefined, "seed");
  const x = register(`reqmcp_other_${Date.now()}`, "ReqMcpOther123!", undefined, "seed");
  ownerNet = o.network_id!;
  const t1 = createNetworkTokenForNode(o.user!.user_id, ownerNet, "gh-sync", "node_gh_sync");
  const t2 = createNetworkTokenForNode(x.user!.user_id, x.network_id!, "foreign", "node_foreign");
  owner = { net: ownerNet, user: o.user!.user_id, alias: o.user!.username, isNetworkToken: false, tokenId: "tok_user" };
  bot = { net: ownerNet, user: o.user!.user_id, alias: "gh-sync", isNetworkToken: true, tokenId: t1.token_id! };
  foreignBot = { net: x.network_id!, user: x.user!.user_id, alias: "foreign", isNetworkToken: true, tokenId: t2.token_id! };
});
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });

describe("requirements MCP tools", () => {
  test("the seven tools are registered with validated schemas; there is no delete tool", async () => {
    const s = await connect(owner);
    try {
      const reg: Record<string, any> = (s.server as any)._registeredTools;
      for (const n of ["requirements_list", "requirements_get", "requirements_create", "requirements_update", "requirements_checklist_toggle", "requirements_upsert_by_external_ref", "projects_list"]) expect(reg[n], n).toBeDefined();
      expect(Object.keys(reg).some(n => /^requirements_delete/.test(n))).toBe(false);
      // 校验:坏的 status / 负责人种类 / 子任务 id 在协议边界被拒
      expect((await s.call("requirements_list", { status: "nope" })).mcpError).toBe(true);
      expect((await s.call("requirements_create", { name: "x", owner: { kind: "robot", id: "a" } })).mcpError).toBe(true);
      expect((await s.call("requirements_checklist_toggle", { id: "r", item_id: "has space", done: true })).mcpError).toBe(true);
      expect((await s.call("requirements_create", { name: "" })).mcpError).toBe(true);
      // P0–P3:lowest(P3 极低)在建 / 改 / upsert 都能写;不认识的值在协议边界被拒
      expect((await s.call("requirements_create", { name: "x", priority: "urgent" })).mcpError).toBe(true);
      const low = await s.call("requirements_create", { name: "极低", priority: "lowest" });
      expect(low.requirement.priority).toBe("lowest");
      expect((await s.call("requirements_update", { id: low.requirement.id, priority: "high" })).requirement.priority).toBe("high");
      expect((await s.call("requirements_update", { id: low.requirement.id, priority: "lowest" })).requirement.priority).toBe("lowest");
      expect((await s.call("requirements_upsert_by_external_ref", { external_ref: "github:acme/p3#1", name: "同步", priority: "lowest" })).requirement.priority).toBe("lowest");
    } finally { await s.close(); }
  });

  test("an agent syncs a GitHub issue idempotently, edits it, ticks a checklist item and archives it", async () => {
    const s = await connect(bot);
    try {
      const ref = "github:acme/widgets#42";
      const first = await s.call("requirements_upsert_by_external_ref", { external_ref: ref, external_url: "https://github.com/acme/widgets/issues/42", name: "修复登录", description: "issue 正文", checklist: [{ id: "c1", text: "复现" }, { id: "c2", text: "修" }] });
      expect(first.ok).toBe(true);
      expect(first.created).toBe(true);
      const tagged = await s.call("requirements_update", { id: first.requirement.id, tags: ["release"] });
      expect(tagged.requirement.tags).toEqual(["release"]);
      expect(first.requirement.created_by).toEqual({ kind: "node", id: "node_gh_sync" });
      const again = await s.call("requirements_upsert_by_external_ref", { external_ref: ref, name: "修复登录(改了标题)" });
      expect(again.created).toBe(false);
      expect(again.requirement.tags).toEqual(["release"]);
      expect(again.requirement.id).toBe(first.requirement.id);
      const listed = await s.call("requirements_list", { external_ref: ref });
      expect(listed.requirements.length).toBe(1);
      expect(listed.requirements[0].name).toBe("修复登录(改了标题)");
      const dup = await s.call("requirements_create", { name: "重复", external_ref: ref });
      expect(dup.error).toBe("external_ref_exists");
      expect(dup.existing_id).toBe(first.requirement.id);
      expect(dup.status).toBe(409);
      const id = first.requirement.id;
      expect((await s.call("requirements_update", { id, column: "doing", agent_owner: { kind: "node", id: "node_gh_sync" } })).requirement.column).toBe("doing");
      const ticked = await s.call("requirements_checklist_toggle", { id, item_id: "c1", done: true });
      expect(ticked.requirement.checklist.map((i: any) => i.done)).toEqual([true, false]);
      expect((await s.call("requirements_get", { id })).requirement.agent_owner).toEqual({ kind: "node", id: "node_gh_sync" });
      expect((await s.call("requirements_list", { status: "doing", agent_owner: "node:node_gh_sync" })).requirements.map((r: any) => r.id)).toContain(id);
      expect((await s.call("requirements_update", { id, owner: { kind: "node", id: "node_gh_sync" }, agent_owner: null })).error).toBe("owner_must_be_human");
      expect((await s.call("requirements_update", { id, archived: true })).requirement.archived).toBe(true);
      expect((await s.call("requirements_list", {})).requirements.some((r: any) => r.id === id)).toBe(false);
      expect((await s.call("requirements_list", { include_archived: true })).requirements.some((r: any) => r.id === id)).toBe(true);
      expect(Array.isArray((await s.call("projects_list", {})).projects)).toBe(true);
      // 子需求:建子卡、父卡上的进度、按父卡 / 顶层过滤
      const child = await s.call("requirements_create", { name: "子需求", parent_id: id });
      expect(child.requirement.parent_id).toBe(id);
      expect((await s.call("requirements_get", { id })).requirement.children.total).toBe(1);
      expect((await s.call("requirements_list", { parent_id: id })).requirements.map((r: any) => r.id)).toEqual([child.requirement.id]);
      expect((await s.call("requirements_list", { top_level: true, include_archived: true })).requirements.some((r: any) => r.id === child.requirement.id)).toBe(false);
      expect((await s.call("requirements_update", { id, parent_id: child.requirement.id })).error).toBe("parent_cycle");
    } finally { await s.close(); }
  });

  test("a node token from another network cannot see or touch these tasks, nor write into this network", async () => {
    const mine = await connect(bot);
    const theirs = await connect(foreignBot);
    try {
      const made = await mine.call("requirements_create", { name: "只属于本网络" });
      const id = made.requirement.id;
      expect((await theirs.call("requirements_get", { id })).error).toBe("requirement_not_found");
      expect((await theirs.call("requirements_update", { id, name: "越界" })).error).toBe("requirement_not_found");
      expect((await theirs.call("requirements_checklist_toggle", { id, item_id: "x", done: true })).error).toBe("requirement_not_found");
      expect((await theirs.call("requirements_list", { network_id: ownerNet })).requirements.some((r: any) => r.id === id)).toBe(false);
      const planted = await theirs.call("requirements_create", { name: "塞进去", network_id: ownerNet });
      expect(planted.ok).toBe(true);
      const row = db.get<{ network_id: string }>("SELECT network_id FROM requirements WHERE requirement_id = ?1", planted.requirement.id)!;
      expect(row.network_id).toBe(foreignBot.net);
      expect((await mine.call("requirements_get", { id })).requirement.name).toBe("只属于本网络");
    } finally { await mine.close(); await theirs.close(); }
  });

  test("a user token keeps working through the same tools", async () => {
    const s = await connect(owner);
    try {
      const made = await s.call("requirements_create", { name: "人建的", network_id: ownerNet, owner: { kind: "user", id: owner.user } });
      expect(made.ok).toBe(true);
      expect(made.requirement.created_by).toEqual({ kind: "user", id: owner.user });
      expect((await s.call("requirements_list", { network_id: ownerNet, owner: `user:${owner.user}` })).requirements.map((r: any) => r.id)).toContain(made.requirement.id);
    } finally { await s.close(); }
  });
});
