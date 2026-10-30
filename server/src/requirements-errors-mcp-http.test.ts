// #472(MCP 任务生命周期测试报告问题 4)—— 任务 / 项目接口的错误带上 field / message / hint,`error` 原样。
// 每条提示一个测试(经 MCP,以 Agent / 人的身份),外加一道取集门:requirements.ts 里返回 / 抛出的每个错误码都在
// requirements-errors.ts 的登记表里,新加的错误码没登记 ⇒ 红。
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";
import { __documentedErrorCodes, errorBody } from "./requirements-errors.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-req-errors-"));
let BASE = "";
let hub: any = null;
const PW = "ReqErrorsPassw0rd!xyz";
let NET = "", ownerToken = "", ownerId = "", nodeToken = "", memberToken = "", cardId = "";

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

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`reqerr_owner_${Date.now()}`, PW, undefined, "Owner");
  ownerToken = a.token!; ownerId = a.user!.user_id; NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [ownerId]);
  nodeToken = createNetworkTokenForNode(ownerId, NET, "示例-甲", "node_reqerr_a").token!;
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const username = `reqerr_member_${Date.now()}`;
  expect((await rest(ownerToken, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role: "member" })).status).toBe(200);
  memberToken = (await rest("", "POST", "/api/auth/login", { username, password: PW })).body.token;
  cardId = (await mcp(nodeToken, "requirements_create", { name: "错误提示测试" })).requirement.id;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("each hint, over MCP", () => {
  test("invalid_due: field due, the accepted formats", async () => {
    for (const due of ["下周五", "2026/10/10"]) {
      const r = await mcp(nodeToken, "requirements_update", { id: cardId, due });
      expect(r.error).toBe("invalid_due");
      expect(r.status).toBe(400);
      expect(r.field).toBe("due");
      expect(r.hint).toContain("YYYY-MM-DD");
      expect(r.hint).toContain("ISO 8601");
    }
    expect((await mcp(nodeToken, "requirements_update", { id: cardId, start: "明天" })).field).toBe("start");
  });

  test("person_not_in_network: names the field, explains node_id vs user_id and where to find them", async () => {
    const byAlias = await mcp(nodeToken, "requirements_update", { id: cardId, agent_owner: { kind: "node", id: "示例-甲" } });
    expect(byAlias.error).toBe("person_not_in_network");
    expect(byAlias.field).toBe("agent_owner");
    // #473:人员字段也收名字 —— 提示改为指向 requirements_people,并说明 alias / username 的写法。
    expect(byAlias.hint).toContain("requirements_people");
    expect(byAlias.hint).toContain("{kind:'node', alias}");
    expect((await mcp(nodeToken, "requirements_update", { id: cardId, owner: { kind: "user", id: "u_nobody" } })).field).toBe("owner");
    expect((await mcp(nodeToken, "requirements_update", { id: cardId, participants: [{ kind: "node", id: "node_reqerr_a" }, { kind: "user", id: "u_nobody" }] })).field).toBe("participants");
  });

  test("project_not_in_network: a name is recognised as a name; both point to projects_list", async () => {
    const byName = await mcp(nodeToken, "requirements_update", { id: cardId, project_id: "示例项目" });
    expect(byName.error).toBe("project_not_in_network");
    expect(byName.field).toBe("project_id");
    expect(byName.message).toContain("looks like a project name");
    expect(byName.hint).toContain("projects_list");
    const byId = await mcp(nodeToken, "requirements_update", { id: cardId, project_id: "proj_missing" });
    expect(byId.error).toBe("project_not_in_network");
    expect(byId.message).not.toContain("project name");
    expect(byId.hint).toContain("projects_list");
  });

  test("empty_patch: lists the writable fields; sending status says to use column", async () => {
    // The MCP tool schema strips keys it does not know, so `status` arrives as nothing; REST sees the raw body.
    const viaRest = await rest(nodeToken, "PATCH", `/api/requirements/${cardId}`, { status: "doing" });
    expect(viaRest.status).toBe(400);
    expect(viaRest.body.error).toBe("empty_patch");
    expect(viaRest.body.hint).toContain("use column");
    expect(viaRest.body.hint).toContain("Writable fields: column");
    expect(viaRest.body.message).toContain("status");
    const viaMcp = await mcp(nodeToken, "requirements_update", { id: cardId });
    expect(viaMcp.error).toBe("empty_patch");
    expect(viaMcp.hint).toContain("Writable fields:");
    expect(viaMcp.hint).not.toContain("use column");
  });

  test("user_token_required: says projects are managed by people and what to do instead", async () => {
    const r = await mcp(nodeToken, "projects_create", { name: "节点建项目" });
    expect(r.error).toBe("user_token_required");
    expect(r.status).toBe(403);
    expect(r.message).toContain("node token");
    expect(r.hint).toContain("projects_list");
  });

  test("network_id_required: field network_id and how to fix it", async () => {
    const r = await mcp(memberToken, "projects_create", { name: "成员建项目" });
    expect(r.error).toBe("network_id_required");
    expect(r.field).toBe("network_id");
    expect(r.hint).toContain("network_id");
  });

  test("swept codes carry hints too: checklist_item_not_found, external_ref_exists (existing_id kept), owner_must_be_human, parent_cycle", async () => {
    const ck = await mcp(nodeToken, "requirements_checklist_toggle", { id: cardId, item_id: "nope", done: true });
    expect(ck.error).toBe("checklist_item_not_found");
    expect(ck.hint).toContain("requirements_get");
    await mcp(nodeToken, "requirements_create", { name: "外部", external_ref: "github:example/repo#472" });
    const dup = await mcp(nodeToken, "requirements_create", { name: "外部又一次", external_ref: "github:example/repo#472" });
    expect(dup.error).toBe("external_ref_exists");
    expect(typeof dup.existing_id).toBe("string");
    expect(dup.hint).toContain("requirements_upsert_by_external_ref");
    const own = await mcp(nodeToken, "requirements_update", { id: cardId, owner: { kind: "node", id: "node_reqerr_a" } });
    expect(own.error).toBe("owner_must_be_human");
    expect(own.hint).toContain("agent_owner");
    const cyc = await mcp(nodeToken, "requirements_update", { id: cardId, parent_id: cardId });
    expect(cyc.error).toBe("parent_cycle");
    expect(cyc.field).toBe("parent_id");
  });
});

describe("compatibility", () => {
  test("REST keeps the exact error strings the app matches on; the new keys are additive", async () => {
    const r = await rest(ownerToken, "PATCH", `/api/requirements/${cardId}`, { due: "下周五" });
    expect(r.status).toBe(400);
    expect(r.body.ok).toBe(false);
    expect(r.body.error).toBe("invalid_due");
    expect(Object.keys(r.body).sort()).toEqual(["error", "field", "hint", "message", "ok"]);
    // A code without an entry is exactly the old shape.
    expect(errorBody("some_future_code")).toEqual({ ok: false, error: "some_future_code" });
  });

  test("every error code requirements.ts returns or throws has an entry (a new code must be documented)", () => {
    const src = readFileSync(join(import.meta.dir, "requirements.ts"), "utf8");
    const codes = new Set<string>();
    for (const m of src.matchAll(/jsonError\(\s*["']([a-z_]+)["']/g)) codes.add(m[1]);
    for (const m of src.matchAll(/(?:new (?:Error|RequirementFieldError))\(\s*["']([a-z_]+)["']/g)) codes.add(m[1]);
    for (const m of src.matchAll(/errorBody\(\s*["']([a-z_]+)["']/g)) codes.add(m[1]);
    for (const m of src.matchAll(/return\s+["'](parent_[a-z_]+)["']/g)) codes.add(m[1]);
    expect(codes.size).toBeGreaterThan(40); // the scan really found the codes (not an empty pass)
    const documented = new Set(__documentedErrorCodes());
    expect([...codes].filter(c => !documented.has(c)).sort()).toEqual([]);
  });
});
