// report_status.session_id is the resumeable runtime session (Claude --session-id,
// Codex thread id, Grok sessionId, OpenCode session id). It is not resume_id.
// Full GET /api/status already selects the column (SESSION_REST_COLUMNS /
// rest-explicit-columns golden `session_id`). This test locks the write:
// a reported id is stored, a later report can replace it, and a report that
// omits it keeps the previous one (COALESCE — a second speaker that does not
// know the runtime session must not wipe it).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";
import { SESSION_REST_COLUMNS } from "./rest-projections.js";

const NET_ID = "net_runtime_session";
const USER_ID = "u_runtime_session";
const NODE_ID = "n_runtime_session";
const ALIAS = "runtime-session-node";
const TOK_ID = "tok_runtime_session";
const RESUME = `sdk-${NODE_ID}`;
const CLAUDE = "6ac06f64-1111-4000-8000-000000000001";
const THREAD = "0199abcd-2222-4000-8000-000000000002";

type ToolHandler = (args: any, extra?: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  for (const [sql, params] of [
    ["DELETE FROM sessions WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM nodes WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM api_tokens WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM network_members WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM networks WHERE network_id = ?1", [NET_ID]],
    ["DELETE FROM users WHERE user_id = ?1", [USER_ID]],
  ] as const) {
    try { db.run(sql, params as any); } catch {}
  }
}
beforeEach(cleanup);
afterAll(cleanup);

function seed() {
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?2, 'x', 'user', datetime('now'))`, [USER_ID, USER_ID]);
  db.run(`INSERT INTO networks (network_id, network_name, owner_id, created_at) VALUES (?1, ?2, ?3, datetime('now'))`, [NET_ID, NET_ID, USER_ID]);
  db.run(`INSERT INTO network_members (user_id, network_id, role, joined_at) VALUES (?1, ?2, 'owner', datetime('now'))`, [USER_ID, NET_ID]);
  db.run(
    `INSERT INTO api_tokens (token_id, user_id, network_id, scope, name, token_hash, expires_at, revoked_at)
     VALUES (?1, ?2, ?3, 'network', ?4, ?5, NULL, NULL)`,
    [TOK_ID, USER_ID, NET_ID, `node:${ALIAS}`, `hash_${TOK_ID}`],
  );
}

function buildHandlers(): Record<string, ToolHandler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const tools: Record<string, ToolHandler> = {};
  const origTool = server.tool.bind(server);
  server.tool = (name: string, _desc: string, _schema: any, handler: ToolHandler) => { tools[name] = handler; return origTool(name, _desc, _schema, handler); };
  const origRegisterTool = server.registerTool?.bind(server);
  if (origRegisterTool) {
    server.registerTool = (name: string, _cfg: any, handler: ToolHandler) => { tools[name] = handler; return origRegisterTool(name, _cfg, handler); };
  }
  registerTools(server, undefined, NET_ID, USER_ID, ALIAS, true, TOK_ID);
  return tools;
}

async function call(handler: ToolHandler, args: any): Promise<any> {
  const r = await handler(args);
  return JSON.parse(r.content[0]!.text);
}

function stored(): { session_id: string | null; resume_id: string; version: string | null }[] {
  return db.all(
    "SELECT session_id, resume_id, version FROM sessions WHERE alias = ?1 AND network_id = ?2",
    [ALIAS, NET_ID],
  ) as { session_id: string | null; resume_id: string; version: string | null }[];
}

describe("report_status.session_id", () => {
  test("full /api/status projection includes session_id (the column the node page reads)", () => {
    expect(SESSION_REST_COLUMNS).toContain("session_id");
  });

  test("a reported resume id is stored; omitting it later keeps it; a new id replaces it", async () => {
    seed();
    const tools = buildHandlers();
    const base = { resume_id: RESUME, alias: ALIAS, status: "idle" as const, network_id: NET_ID, node_id: NODE_ID, version: "2.5.0-preview.126", agent: "agent-node:codex-app-server" };
    const first = await call(tools.report_status!, { ...base, session_id: THREAD });
    expect(first.ok, JSON.stringify(first)).toBe(true);
    expect(stored()).toEqual([{ session_id: THREAD, resume_id: RESUME, version: "2.5.0-preview.126" }]);

    const kept = await call(tools.report_status!, { ...base, status: "working" });
    expect(kept.ok, JSON.stringify(kept)).toBe(true);
    expect(stored()[0]!.session_id).toBe(THREAD);

    const replaced = await call(tools.report_status!, { ...base, status: "idle", session_id: CLAUDE });
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    expect(stored()[0]!.session_id).toBe(CLAUDE);
  });

  test("a second resume_id that omits session_id keeps the runtime id from the row it replaces", async () => {
    seed();
    const tools = buildHandlers();
    const base = { alias: ALIAS, status: "idle" as const, network_id: NET_ID, node_id: NODE_ID };
    expect((await call(tools.report_status!, { ...base, resume_id: RESUME, session_id: THREAD, version: "2.5.0-preview.126" })).ok).toBe(true);
    const other = await call(tools.report_status!, { ...base, resume_id: `grok-cli-${NODE_ID}`, status: "working" });
    expect(other.ok, JSON.stringify(other)).toBe(true);
    const rows = stored();
    expect(rows.length).toBe(1);
    expect(rows[0]!.resume_id).toBe(`grok-cli-${NODE_ID}`);
    expect(rows[0]!.session_id).toBe(THREAD);
    expect(rows[0]!.version).toBe("2.5.0-preview.126");
  });
});
