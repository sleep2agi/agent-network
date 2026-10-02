// #470(MCP 任务生命周期测试报告问题 1)—— Agent 经 MCP 把负责人设成节点:以前走旧 App 的兼容改写,
// 人类负责人被静默清空、负责 Agent 被换掉,响应还显示 owner=节点。现在:
//   - MCP 上 owner 传节点(建 / 改 / upsert,节点令牌和用户令牌都一样)→ 400 owner_must_be_human + hint,什么都不写;
//   - MCP 写入的响应就是落库的那一行(和紧接着的 requirements_get 一字不差);
//   - REST 上旧 App ≤ 0.2.142 的兼容路径不变(requirements-http.test.ts「old-app compat」那条钉着)。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-owner-strict-mcp-"));
let BASE = "";
let hub: any = null;
const PW = "OwnerStrictMcpPassw0rd!x";
let NET = "", ownerToken = "", ownerId = "", nodeToken = "";
const human = () => ({ kind: "user", id: ownerId });
const nodeA = { kind: "node", id: "node_strict_a" };
const nodeB = { kind: "node", id: "node_strict_b" };

async function rest(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const lines = raw.split("\n").filter(x => x.startsWith("data:"));
  const out = lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  return JSON.parse(out.result.content[0].text);
}
const stored = (id: string) => db.get<{ owner_json: string | null; agent_owner_json: string | null }>("SELECT owner_json, agent_owner_json FROM requirements WHERE requirement_id = ?1", id)!;

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`strict_owner_${Date.now()}`, PW, undefined, "Owner");
  ownerToken = a.token!; ownerId = a.user!.user_id; NET = a.network_id!;
  nodeToken = createNetworkTokenForNode(ownerId, NET, "strict-a", "node_strict_a").token!;
  createNetworkTokenForNode(ownerId, NET, "strict-b", "node_strict_b");
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("MCP: owner must be a person", () => {
  test("update owner=node → 400 owner_must_be_human + hint; the human owner and the agent owner are untouched", async () => {
    const card = (await mcp(nodeToken, "requirements_create", { name: "负责人保护", owner: human(), agent_owner: nodeB })).requirement;
    expect(card.owner).toEqual(human());
    const r = await mcp(nodeToken, "requirements_update", { id: card.id, owner: nodeA });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("owner_must_be_human");
    expect(r.status).toBe(400);
    expect(r.hint).toContain("agent_owner");
    expect(r.owner_coerced_to_agent_owner).toBeUndefined();
    const row = stored(card.id);
    expect(JSON.parse(row.owner_json!)).toEqual(human());
    expect(JSON.parse(row.agent_owner_json!)).toEqual(nodeB);
    const got = (await mcp(nodeToken, "requirements_get", { id: card.id })).requirement;
    expect(got.owner).toEqual(human());
    expect(got.agent_owner).toEqual(nodeB);
  });

  test("…the same for a user token over MCP, for create (nothing is written) and for upsert", async () => {
    const r = await mcp(ownerToken, "requirements_update", { network_id: NET, id: (await mcp(ownerToken, "requirements_create", { network_id: NET, name: "用户令牌", owner: human() })).requirement.id, owner: nodeA });
    expect(r.error).toBe("owner_must_be_human");
    const before = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM requirements WHERE network_id = ?1", NET)!.n;
    const c = await mcp(nodeToken, "requirements_create", { name: "建时就传节点", owner: nodeA });
    expect(c.error).toBe("owner_must_be_human");
    expect(c.hint).toContain("agent_owner");
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM requirements WHERE network_id = ?1", NET)!.n).toBe(before);
    const u = await mcp(nodeToken, "requirements_upsert_by_external_ref", { external_ref: "github:example/repo#470", name: "upsert", owner: nodeA });
    expect(u.error).toBe("owner_must_be_human");
    expect(db.get("SELECT 1 FROM requirements WHERE external_ref = 'github:example/repo#470'")).toBeNull();
  });

  test("the right way still works: agent_owner = node, owner = person, owner = null", async () => {
    const card = (await mcp(nodeToken, "requirements_create", { name: "正确的写法", owner: human() })).requirement;
    const r = await mcp(nodeToken, "requirements_update", { id: card.id, agent_owner: nodeA });
    expect(r.ok).toBe(true);
    expect(r.requirement.owner).toEqual(human());
    expect(r.requirement.agent_owner).toEqual(nodeA);
    const cleared = await mcp(nodeToken, "requirements_update", { id: card.id, owner: null });
    expect(cleared.requirement.owner).toBeNull();
    // agent_owner given a person is refused the other way round, with its own hint.
    const wrong = await mcp(nodeToken, "requirements_update", { id: card.id, agent_owner: human() });
    expect(wrong.error).toBe("agent_owner_must_be_agent");
    expect(wrong.hint).toContain("owner");
  });

  test("every MCP write's response equals a fresh requirements_get", async () => {
    const card = (await mcp(nodeToken, "requirements_create", { name: "响应即落库", owner: human(), checklist: [{ text: "一" }] })).requirement;
    expect((await mcp(nodeToken, "requirements_get", { id: card.id })).requirement).toEqual(card);
    const patches: Record<string, unknown>[] = [
      { column: "doing" }, { agent_owner: nodeA }, { participants: [nodeB, human()] }, { owner: null }, { owner: human(), priority: "high" },
      { agent_owner: null }, { due: "2026-10-10" }, { archived: true }, { archived: false },
    ];
    for (const p of patches) {
      const r = await mcp(nodeToken, "requirements_update", { id: card.id, ...p });
      expect(r.ok).toBe(true);
      expect(r.owner_coerced_to_agent_owner).toBeUndefined();
      expect(r.requirement).toEqual((await mcp(nodeToken, "requirements_get", { id: card.id })).requirement);
    }
  });
});

describe("REST", () => {
  test("new clients' responses equal a fresh GET (the old-app compat echo is the only exception, pinned in requirements-http.test.ts)", async () => {
    const card = (await rest(ownerToken, "POST", "/api/requirements", { network_id: NET, name: "REST 响应", owner: human() })).body.requirement;
    for (const p of [{ agent_owner: nodeA }, { owner: human(), agent_owner: nodeB }, { participants: [nodeA] }]) {
      const r = await rest(ownerToken, "PATCH", `/api/requirements/${card.id}`, p);
      expect(r.status).toBe(200);
      expect(r.body.requirement).toEqual((await rest(ownerToken, "GET", `/api/requirements/${card.id}`)).body.requirement);
    }
    // A new client (sends agent_owner) passing a node as owner: still strict, now with the hint.
    const strict = await rest(ownerToken, "PATCH", `/api/requirements/${card.id}`, { owner: nodeA, agent_owner: nodeB });
    expect(strict.status).toBe(400);
    expect(strict.body.error).toBe("owner_must_be_human");
    expect(strict.body.hint).toContain("agent_owner");
  });

  test("old-app compat on REST is unchanged: owner=node without agent_owner is still coerced (200 + flag)", async () => {
    const card = (await rest(ownerToken, "POST", "/api/requirements", { network_id: NET, name: "旧 App", owner: human() })).body.requirement;
    const old = await rest(ownerToken, "PATCH", `/api/requirements/${card.id}`, { owner: nodeA });
    expect(old.status).toBe(200);
    expect(old.body.owner_coerced_to_agent_owner).toBe(true);
    const row = stored(card.id);
    expect(row.owner_json).toBeNull();
    expect(JSON.parse(row.agent_owner_json!)).toEqual(nodeA);
  });
});
