import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import "./require-explicit-test-db.js";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

// #1027: get_create_request must return network_id so the daemon can write
// it into the child config. Without it, child nodes fail the OpenCode
// runtime binding check and die within 5s.

const NET = "net_1027_hub";
const USER_ID = "u_1027_hub";
const DAEMON_ID = "node_1027_hub_daemon";
const DAEMON_ALIAS = "hub1027-daemon";
const DAEMON_TOK = "tok_1027_hub_daemon";

interface ToolHandler { (args: any, extra?: any): Promise<{ content: Array<{ type: "text"; text: string }> }>; }
interface Reply { ok?: boolean; error?: string; request_id?: string; network_id?: string; node_spec?: any; [k: string]: unknown; }

function cleanup() {
  for (const t of ["node_create_requests", "audit_log", "nodes", "sessions", "api_tokens", "network_members"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM networks WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER_ID]); } catch {}
}
beforeEach(cleanup);
afterAll(cleanup);

function seed() {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))`, [USER_ID]);
  db.run(`INSERT OR REPLACE INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?1, ?2, datetime('now'))`, [NET, USER_ID]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'admin', datetime('now'))`, [USER_ID, NET]);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, config_snapshot, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?2, ?3, ?4, 'host-x', datetime('now'), datetime('now'), 'active')`,
    [DAEMON_ID, DAEMON_ALIAS, NET, JSON.stringify({ role: "host_supervisor", daemon_capabilities: { runtimes_supported: ["opencode-cli"] } })],
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

describe("#1027 get_create_request returns network_id", () => {
  test("network_id is included in the response", async () => {
    seed();
    const t = tools(DAEMON_TOK);
    const r = await call(t.create_node, {
      daemon_node_id: DAEMON_ID,
      node_spec: { name: "child-1027", runtime: "opencode-cli", model: null, flags: {} },
    });
    expect(r.ok).toBe(true);
    expect(r.request_id).toMatch(/^cr_/);

    const g = await call(t.get_create_request, { request_id: r.request_id });
    expect(g.ok).toBe(true);
    expect(g.network_id).toBe(NET);
    expect(g.node_spec?.name).toBe("child-1027");
  });
});
