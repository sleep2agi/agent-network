import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./require-explicit-test-db.js";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { finalizeCreateOnFirstRegister } from "./create-node.js";

// 2026-11-14 —— 新建节点时选部门(admin:「创建人可能兼多个部门」→ 不猜,让创建人选)。
//   ① create_node 带 department_id:部门不存在 → department_not_found,不建(不留请求行、不铸令牌)
//   ② 请求行存下部门;节点首次注册(finalize)时写进 nodes.department_id
//   ③ 只填空:节点已经有部门就不覆盖;部门在这期间被删了就跳过
//   ④ 不带 department_id = 老行为(节点没有部门)
const NET = "net_create_dept";
const USER_ID = "u_create_dept_admin";
const DAEMON_ID = "node_create_dept_daemon";
const DAEMON_ALIAS = "create-dept-daemon";
const DAEMON_TOK = "tok_create_dept_daemon";
const ROOT = "/home/user";

interface ToolHandler { (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>; }
interface Reply { ok?: boolean; error?: string; request_id?: string; node_spec?: any; [k: string]: unknown; }

function cleanup() {
  for (const t of ["node_create_requests", "audit_log", "nodes", "sessions", "api_tokens", "network_members", "network_departments"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER_ID]); } catch {}
}
beforeEach(cleanup);
afterAll(cleanup);

function seed(caps: Record<string, unknown>) {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))`, [USER_ID]);
  db.run(`INSERT OR REPLACE INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET, USER_ID]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'admin', datetime('now'))`, [USER_ID, NET]);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, ?4, 'host-x', datetime('now'), datetime('now'), 'active')`,
    [DAEMON_ID, DAEMON_ALIAS, NET, JSON.stringify({ role: "host_supervisor", daemon_capabilities: { runtimes_supported: ["claude-agent-sdk"], ...caps } })],
  );
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [DAEMON_TOK, USER_ID, NET, `node:${DAEMON_ALIAS}`, `hash_${DAEMON_TOK}`],
  );
}

function tools(callerTokenId: string | null = null): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const out: Record<string, ToolHandler> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, d: string, schema: any, handler: ToolHandler) => { out[name] = handler; return origTool(name, d, schema, handler); };
  const origRegisterTool = server.registerTool?.bind(server);
  if (origRegisterTool) {
    server.registerTool = (name: string, cfg: any, handler: ToolHandler) => { out[name] = handler; return origRegisterTool(name, cfg, handler); };
  }
  registerTools(server, undefined, NET, USER_ID, null, true, callerTokenId);
  return out;
}

async function call(h: ToolHandler, args: any): Promise<Reply> {
  return JSON.parse((await h(args)).content[0].text) as Reply;
}

const baseSpec = { name: "dept-child", runtime: "claude-agent-sdk", model: "claude-sonnet-4-5", flags: {} };

function rowCount(): number {
  return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM node_create_requests WHERE daemon_node_id = ?1", DAEMON_ID)?.n ?? -1;
}

const DEPT = "dept_create_a";
function seedDept(id = DEPT) {
  db.run(`INSERT INTO network_departments (network_id, department_id, name, parent_id, leader_user_id, sort, created_by, created_at, updated_at)
          VALUES (?1, ?2, ?2, NULL, NULL, 0, ?3, datetime('now'), datetime('now'))`, [NET, id, USER_ID]);
}
function registerChild(alias: string, nodeId: string, dept: string | null = null) {
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, created_at, updated_at, lifecycle_state, department_id)
          VALUES (?1, ?2, ?2, ?3, datetime('now'), datetime('now'), 'active', ?4)`, [nodeId, alias, NET, dept]);
  return finalizeCreateOnFirstRegister({ node_id: nodeId, alias, network_id: NET });
}
const nodeDept = (id: string) => db.get<{ d: string | null }>("SELECT department_id AS d FROM nodes WHERE node_id = ?1", id)?.d ?? null;

describe("create_node department_id", () => {
  beforeAll(() => {});
  test("🔴 unknown department → department_not_found, nothing queued, no token minted", async () => {
    seed({});
    const tokensBefore = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens WHERE network_id = ?1", NET)!.n;
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: baseSpec, department_id: "dept_missing" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("department_not_found");
    expect(rowCount()).toBe(0);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM api_tokens WHERE network_id = ?1", NET)!.n).toBe(tokensBefore);
  });

  test("🔴 chosen department is stored and lands on the node at first register", async () => {
    seed({}); seedDept();
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: baseSpec, department_id: DEPT });
    expect(r.ok).toBe(true);
    expect(r.department_id).toBe(DEPT);
    expect(db.get<{ d: string }>("SELECT department_id AS d FROM node_create_requests WHERE request_id = ?1", r.request_id)!.d).toBe(DEPT);
    expect(registerChild("dept-child", "node_dept_child").finalized).toBe(1);
    expect(nodeDept("node_dept_child")).toBe(DEPT);
  });

  test("no department_id = old behaviour (node stays unassigned, reply has no department_id key)", async () => {
    seed({}); seedDept();
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: baseSpec });
    expect(r.ok).toBe(true);
    expect("department_id" in r).toBe(false);
    registerChild("dept-child", "node_dept_child2");
    expect(nodeDept("node_dept_child2")).toBeNull();
  });

  test("empty string / null are treated as not set", async () => {
    seed({}); seedDept();
    for (const v of ["", "   ", null]) {
      const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: { ...baseSpec, name: `dept-child-${String(v).trim() || "x"}${Math.random().toString(36).slice(2, 6)}` }, department_id: v });
      expect(r.ok).toBe(true);
      expect("department_id" in r).toBe(false);
    }
  });

  test("only fills a blank: a node someone already placed keeps its department", async () => {
    seed({}); seedDept(); seedDept("dept_other");
    await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: baseSpec, department_id: DEPT });
    registerChild("dept-child", "node_dept_child3", "dept_other");
    expect(nodeDept("node_dept_child3")).toBe("dept_other");
  });

  test("department deleted before the node came online → skipped, no dangling id", async () => {
    seed({}); seedDept();
    await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: baseSpec, department_id: DEPT });
    db.run("DELETE FROM network_departments WHERE network_id = ?1 AND department_id = ?2", [NET, DEPT]);
    registerChild("dept-child", "node_dept_child4");
    expect(nodeDept("node_dept_child4")).toBeNull();
  });

  test("audit detail records the chosen department", async () => {
    seed({}); seedDept();
    const r = await call(tools().create_node, { daemon_node_id: DAEMON_ID, node_spec: baseSpec, department_id: DEPT });
    const a = db.get<{ detail: string }>("SELECT detail FROM audit_log WHERE action = 'create_node_dispatch_attempted' AND target_id = ?1", r.request_id);
    expect(a?.detail ?? "").toContain(DEPT);
  });
});
