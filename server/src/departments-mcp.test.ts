// #1894 —— 组织架构的 MCP 面：Agent 用 API 就能建部门、把 Agent 归进去，
// 不用人手动点。这里跑的是真实的 in-process MCP transport（不是直接调函数），
// 因为要验的正是「工具真的注册上、参数真的能过 schema、权限真的按 caller 判」。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_dept_mcp";
const OWNER = "u_dept_mcp_owner";
const OTHER = "u_dept_mcp_other";
const AGENT_A = "n_dept_mcp_a";
const AGENT_B = "n_dept_mcp_b";

function cleanup() {
  for (const [table, col] of [
    ["audit_log", "network_id"], ["nodes", "network_id"], ["network_departments", "network_id"],
    ["network_members", "network_id"], ["networks", "network_id"],
  ] as const) {
    try { db.run(`DELETE FROM ${table} WHERE ${col} = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id IN (?1, ?2)", [OWNER, OTHER]); } catch {}
}

function seed() {
  cleanup();
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))", [OWNER, OWNER]);
  db.run("INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))", [OTHER, OTHER]);
  db.run("INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))", [NET, NET, OWNER]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))", [OWNER, NET]);
  db.run("INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'member', datetime('now'))", [OTHER, NET]);
  for (const [id, alias] of [[AGENT_A, "dept-agent-a"], [AGENT_B, "dept-agent-b"]] as const) {
    db.run("INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at) VALUES (?1, ?2, ?2, ?3, datetime('now'), datetime('now'))", [id, alias, NET]);
  }
}

async function connect(callerUserId: string, alias = "dept-agent-a") {
  const server = new McpServer({ name: "dept-mcp-test", version: "1" });
  registerTools(server, undefined, NET, callerUserId, alias, true, null);
  const client = new Client({ name: "dept-mcp-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);
  return { client, server };
}

type Result = { content: Array<{ type: string; text?: string }>; isError?: boolean };
const json = (r: Result) => JSON.parse(String(r.content[0]?.text ?? "{}"));

beforeEach(seed);
afterAll(cleanup);

describe("#1894 departments over MCP", () => {
  test("owner can list, create, assign and read back the counts", async () => {
    const { client, server } = await connect(OWNER);
    try {
      const before = json(await client.callTool({ name: "departments", arguments: { action: "list" } }) as Result);
      expect(before.ok).toBe(true);
      expect(before.unassigned_agents).toBe(2);

      const created = json(await client.callTool({
        name: "departments", arguments: { action: "create", name: "TMAI", department_id: "dept_test_tmai" },
      }) as Result);
      expect(created.ok).toBe(true);
      expect(created.department.id).toBe("dept_test_tmai");

      const child = json(await client.callTool({
        name: "departments", arguments: { action: "create", name: "TMAI-内容", parent_id: "dept_test_tmai" },
      }) as Result);
      expect(child.ok).toBe(true);
      expect(child.department.parent_id).toBe("dept_test_tmai");

      const assigned = json(await client.callTool({
        name: "departments", arguments: { action: "assign_agent", alias: "dept-agent-a", department_id: "dept_test_tmai" },
      }) as Result);
      expect(assigned.ok).toBe(true);
      expect(assigned.node_id).toBe(AGENT_A);

      const after = json(await client.callTool({ name: "departments", arguments: { action: "list" } }) as Result);
      expect(after.unassigned_agents).toBe(1);
      const tmai = after.departments.find((d: any) => d.id === "dept_test_tmai");
      expect(tmai.agent_count).toBe(1);
      const agent = after.agents.find((a: any) => a.node_id === AGENT_A);
      expect(agent.department_id).toBe("dept_test_tmai");

      // 清空归属同样要能通过 API 做
      const cleared = json(await client.callTool({
        name: "departments", arguments: { action: "assign_agent", node_id: AGENT_A, department_id: null },
      }) as Result);
      expect(cleared.ok).toBe(true);
      expect(cleared.department_id).toBeNull();
    } finally {
      await server.close();
    }
  });

  test("a plain member cannot write departments", async () => {
    const { client, server } = await connect(OTHER, "dept-agent-b");
    try {
      const read = json(await client.callTool({ name: "departments", arguments: { action: "list" } }) as Result);
      expect(read.ok).toBe(true);
      const created = json(await client.callTool({
        name: "departments", arguments: { action: "create", name: "不该被建出来" },
      }) as Result);
      expect(created.ok).toBe(false);
      const assigned = json(await client.callTool({
        name: "departments", arguments: { action: "assign_agent", node_id: AGENT_B, department_id: null },
      }) as Result);
      expect(assigned.ok).toBe(false);
    } finally {
      await server.close();
    }
  });

  test("deleting a department that still has agents is refused", async () => {
    const { client, server } = await connect(OWNER);
    try {
      json(await client.callTool({ name: "departments", arguments: { action: "create", name: "B 站", department_id: "dept_test_b" } }) as Result);
      json(await client.callTool({ name: "departments", arguments: { action: "assign_agent", node_id: AGENT_B, department_id: "dept_test_b" } }) as Result);
      const refused = json(await client.callTool({ name: "departments", arguments: { action: "delete", department_id: "dept_test_b" } }) as Result);
      expect(refused.ok).toBe(false);
    } finally {
      await server.close();
    }
  });
});
