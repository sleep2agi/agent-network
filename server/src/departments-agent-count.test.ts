// #2822 —— 部门 → Agent 计数（轴2）必须是接口直接给出的，而且要和客户端同一口径。
//
// 背景：admin 看到 Dashboard 部门盘「未分组 105 / TMAI 1 / 其余 0」，客户端同一棵树却是
// 「TMWork 15 / TM智能体空间 2」。根因是**两个轴**被混成了一个：
//   轴1 人    network_members.department_id
//   轴2 Agent nodes.department_id            ← 权威
// 本测试钉住：HTTP `GET …/departments` 与 MCP `departments list` 都直接用 nodes.department_id，
// 并且按 #2596 的口径去重（同 alias 只算一个，保留 updated_at 最新的那一行）。

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { register } from "./auth.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-dept-agent-count-"));
let BASE = "";
let hub: any = null;
const PW = "DeptAgentCountPassw0rd!";
let NET = "";
let TOKEN = "";
const UID: string[] = [];

async function send(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json };
}
const D = () => `/api/networks/${NET}/departments`;

function mkDept(name: string): string {
  const id = `dept_${name.toLowerCase().replace(/[^a-z0-9]/g, "")}_${Math.random().toString(36).slice(2, 8)}`;
  db.run("INSERT INTO network_departments (network_id, department_id, name) VALUES (?1, ?2, ?3)", [NET, id, name]);
  return id;
}
let seq = 0;
function mkNode(alias: string | null, departmentId: string | null, updatedAt: string) {
  const nodeId = `n_c_${Date.now()}_${seq++}`;
  db.run(
    "INSERT INTO nodes (node_id, node_name, alias, runtime, network_id, department_id, updated_at) VALUES (?1, ?2, ?3, 'codex', ?4, ?5, ?6)",
    [nodeId, alias || nodeId, alias, NET, departmentId, updatedAt],
  );
  return nodeId;
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";
  const a = register(`dca_owner_${Date.now()}`, PW, undefined, "Owner");
  expect(a.ok).toBe(true);
  TOKEN = a.token!;
  UID.push(a.user!.user_id);
  NET = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [a.user!.user_id]);
  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("#2822 部门 → Agent 计数走 nodes.department_id（轴2）", () => {
  test("agent_count 只数显式归属的 Agent；agents_unassigned 单独给；人的部门不参与", async () => {
    const work = mkDept("TMWork");
    const space = mkDept("TM智能体空间");
    const infra = mkDept("TM基建");

    // 轴2：TMWork 3 个（其中两个同 alias，旧的应被去重掉）→ 期望 2
    mkNode("alice", work, "2026-10-01 00:00:00");
    mkNode("alice", work, "2026-10-20 00:00:00"); // 更新 ⇒ 保留这一行
    mkNode("bob", work, "2026-10-20 00:00:00");
    // TM智能体空间 1 个
    mkNode("carol", space, "2026-10-20 00:00:00");
    // TM基建：同 alias 但更新的一行被移到了别的部门 ⇒ 计数要跟着最新那一行走
    mkNode("dave", infra, "2026-10-01 00:00:00");
    mkNode("dave", space, "2026-10-25 00:00:00");
    // 未归属 2 个
    mkNode("eve", null, "2026-10-20 00:00:00");
    mkNode("frank", "", "2026-10-20 00:00:00");
    // 把负责人放进 TM基建（轴1）—— 轴1 有任何值都不能影响轴2 的计数
    db.run("UPDATE network_members SET department_id = ?2 WHERE network_id = ?1 AND user_id = ?3", [NET, infra, UID[0]]);

    const r = await send(TOKEN, "GET", D());
    expect(r.status).toBe(200);
    const byName = new Map<string, any>((r.body.departments as any[]).map((d) => [d.name, d]));

    expect(byName.get("TMWork").agent_count).toBe(2);      // alice 去重后 + bob
    expect(byName.get("TM智能体空间").agent_count).toBe(2); // carol + dave（最新那一行在这里）
    expect(byName.get("TM基建").agent_count).toBe(0);      // dave 已被移走；人的部门不算
    expect(r.body.agents_unassigned).toBe(2);              // eve + frank（domain: department_id 空）

    // 轴1 仍然是直属人数，不受影响
    expect(byName.get("TM基建").member_count).toBe(1);
    expect(byName.get("TMWork").member_count).toBe(0);
  });

  test("MCP departments list 与 HTTP 同一口径（不再各自算一遍）", async () => {
    // 真的走 in-process MCP transport（不是直调函数）：要验的正是「工具返回的就是同一份口径」。
    const server = new McpServer({ name: "dept-agent-count", version: "1" });
    registerTools(server, undefined, NET, UID[0], "owner-agent", true, null);
    const client = new Client({ name: "dept-agent-count-client", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    try {
      const raw: any = await client.callTool({ name: "departments", arguments: { action: "list" } });
      const mcp = JSON.parse(String(raw.content?.[0]?.text ?? "{}"));
      const http = (await send(TOKEN, "GET", D())).body;
      const httpByName = new Map<string, any>((http.departments as any[]).map((d) => [d.name, d]));
      expect(mcp.departments.length).toBeGreaterThan(0);
      for (const d of mcp.departments as any[]) expect(d.agent_count).toBe(httpByName.get(d.name).agent_count);
      expect(mcp.unassigned_agents).toBe(http.agents_unassigned);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
