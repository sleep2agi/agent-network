// #4685 —— send_message 的 steer 参数（与 control:"interrupt" 并列）：
//   1. steer 与 control 互斥（两个都给 → steer_conflicts_with_control）；
//   2. steer:true 落库 meta_json={"delivery":"steer"}，type 仍为 message（不新增 type，不惊动唤醒分叉）；
//   3. 响应带 delivery:"steer"；不传 steer 时 meta_json 为 null（回归）。
import { afterAll, beforeEach, afterEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { __resetSSEClientsForTest } from "./push.js";

const NET = "steer-test-net", OWNER = "steer-owner", RECV = "steer-recv";
type ToolHandler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  for (const t of ["inbox", "tasks", "task_events"]) { try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {} }
  try { db.run("DELETE FROM sessions WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM network_members WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [OWNER]); } catch {}
}
function seed() {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))`, [OWNER]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET, OWNER]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [OWNER, NET]);
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state) VALUES (?1, ?2, ?2, ?3, 'host', datetime('now'), datetime('now'), 'active')`, [`node_${RECV}`, RECV, NET]);
  db.run(`INSERT INTO sessions (resume_id, alias, status, node_id, network_id, updated_at, last_seen_at) VALUES (?1, ?2, 'idle', ?3, ?4, datetime('now'), datetime('now'))`, [`res_${RECV}`, RECV, `node_${RECV}`, NET]);
}

beforeEach(() => { cleanup(); seed(); });
afterEach(() => { __resetSSEClientsForTest(); });
afterAll(cleanup);

function buildHandlers(alias: string): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, schema: any, handler: ToolHandler) => {
    tools[name] = handler;
    return origTool(name, _desc, schema, handler);
  };
  registerTools(server, undefined, NET, OWNER, alias, true, null);
  return tools;
}
async function call(handler: ToolHandler, args: any): Promise<Record<string, any>> {
  const r = await handler(args);
  return JSON.parse(r.content[0].text);
}

describe("#4685 send_message steer", () => {
  test("steer 与 control 互斥 → steer_conflicts_with_control", async () => {
    const tools = buildHandlers(OWNER);
    const r = await call(tools.send_message, { alias: RECV, message: "x", control: "interrupt", steer: true, network_id: NET });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("steer_conflicts_with_control");
  });

  test("steer:true 落库 meta_json={\"delivery\":\"steer\"}，响应带 delivery", async () => {
    const tools = buildHandlers(OWNER);
    const r = await call(tools.send_message, { alias: RECV, message: "请改口", steer: true, network_id: NET });
    expect(r.ok).toBe(true);
    expect(r.delivery).toBe("steer");
    expect(r.accepted).toBe(true);
    const row = db.get<{ type: string; meta_json: string | null }>("SELECT type, meta_json FROM inbox WHERE network_id = ?1", NET);
    expect(row!.type).toBe("message");
    expect(JSON.parse(row!.meta_json!)).toEqual({ delivery: "steer" });
  });

  test("不传 steer → meta_json 为 null（回归）", async () => {
    const tools = buildHandlers(OWNER);
    const r = await call(tools.send_message, { alias: RECV, message: "普通", network_id: NET });
    expect(r.ok).toBe(true);
    expect(r.delivery).toBeUndefined();
    const row = db.get<{ meta_json: string | null }>("SELECT meta_json FROM inbox WHERE network_id = ?1", NET);
    expect(row!.meta_json).toBeNull();
  });
});
