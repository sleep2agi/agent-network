// MCP projects_create / projects_update / requirements_events(app 任务页审计 2026-10-02 M3:Agent 能做人能做的)。
// HTTP 集成测试(真实 Bun.serve,私有端口,临时库)。三个工具都走 app 用的同一套 REST 处理(handleRequirementsRequest),
// 所以这里不另抄一份权限规则:对每类调用者(网络 owner、全部任务成员、仅相关任务成员、viewer、节点令牌)都同时调
// MCP 和 REST,断言状态码 / 结果逐项一致。再钉住正向行为(建 / 改名 / 归档 / 取消归档、读流水、"#N")和工具出现在 tools/list 里。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, createNetworkTokenForNode } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-mcp-projects-events-"));
let BASE = "";
let hub: any = null;
const PW = "McpProjectsEventsPassw0rd!x";
let NET = "";
const U: Record<string, { token: string; id: string }> = {};

async function rest(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
async function rpc(token: string, method: string, params?: unknown): Promise<any> {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
  const raw = await res.text();
  const lines = raw.split("\n").filter(x => x.startsWith("data:"));
  return lines.length ? JSON.parse(lines.at(-1)!.slice(5).trim()) : JSON.parse(raw);
}
async function mcp(token: string, name: string, args: Record<string, unknown>): Promise<any> {
  const out = await rpc(token, "tools/call", { name, arguments: args });
  return JSON.parse(out.result.content[0].text);
}
// MCP error bodies from the REST handler carry its status (requirementsCall). Anything else that isn't ok (e.g. a tool-level
// gate) is NOT a success — a body without `status` must never be read as the 2xx (that hid a gate in the first draft).
const mcpStatus = (r: any, okStatus: number) => (r?.ok === true || (r && r.ok === undefined && (r.project || r.events)) ? okStatus : typeof r?.status === "number" ? r.status : -1);

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`mpe_owner_${Date.now()}`, PW, undefined, "Owner");
  expect(a.ok).toBe(true);
  U.owner = { token: a.token!, id: a.user!.user_id };
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [U.owner.id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
  const mk = async (username: string, role: string) => {
    expect((await rest(U.owner.token, "POST", "/api/admin/users", { username, password: PW, network_id: NET, role })).status).toBe(200);
    const login = await rest("", "POST", "/api/auth/login", { username, password: PW });
    expect(login.status).toBe(200);
    return { token: login.body.token as string, id: login.body.user.user_id as string };
  };
  const stamp = Date.now();
  U.member = await mk(`mpe_member_${stamp}`, "member");
  U.scoped = await mk(`mpe_scoped_${stamp}`, "member");
  U.viewer = await mk(`mpe_viewer_${stamp}`, "viewer");
  db.run("UPDATE network_members SET task_access = 'all' WHERE network_id = ?1 AND user_id = ?2", [NET, U.member.id]);
  expect((await rest(U.owner.token, "PUT", `/api/networks/${NET}/members/${U.scoped.id}/task-grants`, { task_access: "scoped", project_grants: [] })).status).toBe(200);
  const node = createNetworkTokenForNode(U.owner.id, NET, "mpe-node", "node_mpe");
  U.node = { token: node.token!, id: "node_mpe" };
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("discoverable", () => {
  test("tools/list carries the three tools with descriptions", async () => {
    const list = await rpc(U.owner.token, "tools/list");
    const byName = new Map((list.result.tools as any[]).map(t => [t.name, t]));
    for (const n of ["projects_create", "projects_update", "requirements_events"]) {
      expect(byName.has(n)).toBe(true);
      expect(String(byName.get(n).description).length).toBeGreaterThan(40);
    }
    expect(String(byName.get("projects_list").description)).toContain("projects_create");
  });
});

describe("projects_create / projects_update", () => {
  test("owner: create, rename, recolour, archive, unarchive — same rows the app sees", async () => {
    const created = await mcp(U.owner.token, "projects_create", { network_id: NET, name: "mpe-项目甲" });
    expect(created.ok).toBe(true);
    const id = created.project.id as string;
    expect(created.project.name).toBe("mpe-项目甲");
    const renamed = await mcp(U.owner.token, "projects_update", { network_id: NET, id, name: "mpe-项目乙", color: "#16a34a" });
    expect(renamed.project.name).toBe("mpe-项目乙");
    expect(renamed.project.color).toBe("#16a34a");
    expect((await mcp(U.owner.token, "projects_update", { network_id: NET, id, archived: true })).project.archived).toBe(true);
    const seen = await rest(U.owner.token, "GET", `/api/requirements/projects?network_id=${NET}`);
    expect(seen.body.projects.find((p: any) => p.id === id).archived).toBe(true);
    expect((await mcp(U.owner.token, "projects_update", { network_id: NET, id, archived: false })).project.archived).toBe(false);
  });

  test("validation comes from the REST handler: duplicate name 409, unknown id 404", async () => {
    await mcp(U.owner.token, "projects_create", { network_id: NET, name: "mpe-重名" });
    const dup = await mcp(U.owner.token, "projects_create", { network_id: NET, name: "mpe-重名" });
    expect(dup.ok).toBe(false);
    expect(dup.status).toBe(409);
    const missing = await mcp(U.owner.token, "projects_update", { network_id: NET, id: "proj_nobody", name: "x" });
    expect(missing.status).toBe(404);
  });

  test("permission parity with the app's REST path, for every kind of caller", async () => {
    const results: Record<string, { mcp: number; rest: number }> = {};
    for (const who of ["owner", "member", "scoped", "viewer", "node"]) {
      const name = `mpe-parity-${who}`;
      const viaMcp = await mcp(U[who].token, "projects_create", { network_id: NET, name: `${name}-mcp` });
      const viaRest = await rest(U[who].token, "POST", `/api/requirements/projects?network_id=${NET}`, { name: `${name}-rest` });
      results[who] = { mcp: mcpStatus(viaMcp, 201), rest: viaRest.status };
    }
    for (const r of Object.values(results)) expect(r.mcp).toBe(r.rest);
    // the rule itself (RFC-038 §9): task-scoped members and viewers can't manage projects; the others can
    expect(results.owner.rest).toBe(201);
    expect(results.member.rest).toBe(201);
    expect(results.scoped.rest).toBe(403);
    expect(results.viewer.rest).toBe(403);
  });
});

describe("requirements_events", () => {
  test("one task's timeline by id and by #N, same rows as GET /api/requirements/events", async () => {
    const card = await rest(U.owner.token, "POST", "/api/requirements", { network_id: NET, name: "mpe-流水示例" });
    expect(card.status).toBe(201);
    const id = card.body.requirement.id as string, seq = card.body.requirement.seq as number;
    expect((await rest(U.owner.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, { priority: "high" })).status).toBe(200);
    const viaMcp = await mcp(U.owner.token, "requirements_events", { network_id: NET, requirement_id: id });
    const viaRest = await rest(U.owner.token, "GET", `/api/requirements/events?network_id=${NET}&requirement_id=${id}`);
    expect(viaMcp.ok).toBe(true);
    expect(viaMcp.events.length).toBeGreaterThan(0);
    expect(viaMcp.events.map((e: any) => e.id)).toEqual(viaRest.body.events.map((e: any) => e.id));
    expect(viaMcp.events.every((e: any) => e.requirement_id === id)).toBe(true);
    const bySeq = await mcp(U.owner.token, "requirements_events", { network_id: NET, requirement_id: `#${seq}` });
    expect(bySeq.events.map((e: any) => e.id)).toEqual(viaMcp.events.map((e: any) => e.id));
    // paging / bad input come from the REST handler too
    expect((await mcp(U.owner.token, "requirements_events", { network_id: NET, since: "not-a-date" })).status).toBe(400);
    expect((await mcp(U.owner.token, "requirements_events", { network_id: NET, requirement_id: "#999999" })).status).toBe(404);
  });

  test("visibility parity: a task-scoped member doesn't get events for a task they can't see", async () => {
    const hidden = await rest(U.owner.token, "POST", "/api/requirements", { network_id: NET, name: "mpe-看不见的" });
    const id = hidden.body.requirement.id as string;
    await rest(U.owner.token, "PATCH", `/api/requirements/${id}?network_id=${NET}`, { priority: "low" });
    for (const who of ["scoped", "member", "node"]) {
      const viaMcp = await mcp(U[who].token, "requirements_events", { network_id: NET, requirement_id: id });
      const viaRest = await rest(U[who].token, "GET", `/api/requirements/events?network_id=${NET}&requirement_id=${id}`);
      expect((viaMcp.events ?? []).map((e: any) => e.id)).toEqual((viaRest.body?.events ?? []).map((e: any) => e.id));
    }
    expect((await mcp(U.scoped.token, "requirements_events", { network_id: NET, requirement_id: id })).events ?? []).toHaveLength(0);
    expect((await mcp(U.member.token, "requirements_events", { network_id: NET, requirement_id: id })).events.length).toBeGreaterThan(0);
  });
});
