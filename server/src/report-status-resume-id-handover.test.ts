// 同一 alias 换 resume_id 上报时,hub 的 report_status 走的是「DELETE 旧行 + INSERT 新行」,
// ON CONFLICT 里的 COALESCE 一次都不会触发 —— 上报里没带的描述性列(version / agent /
// hostname / 遥测 / registered_at)全部变 NULL。
//
// 2026-09-04 DEV 真机(hub 日志):
//   12:46:47 grok-v1 (sdk-n_6c)  → report_status: working       version=2.5.0-preview.64
//   12:46:53 grok-v1 (grok-cli)  → report_status: working       ← TUI 的 MCP 上报,不带 version
//   12:46:54 grok-v1 (sdk-n_6c)  → report_status: idle          ← 又换回来,也不带 version
// 结果:version=NULL、registered_at 被改成 12:46:54。舰队里 grok 3/10、claude 5/15 有 version,
// codex 34/34 有 —— 差别就是有没有第二个上报者。
//
// 判据:换 resume_id 之后,只有一行;上报了的列以上报为准,没上报的列从被替换的那行接手。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NET_ID = "net_handover";
const USER_ID = "u_handover";
const NODE_ID = "n_handover";
const ALIAS = "grok-handover";
const TOK_ID = "tok_handover";
const RESUME_SDK = `sdk-${NODE_ID}`;
const RESUME_CLI = `grok-cli-${NODE_ID}`;
const OLD_REGISTERED_AT = "2026-01-02 03:04:05";

type ToolHandler = (args: any, extra?: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

function cleanup() {
  for (const [sql, params] of [
    ["DELETE FROM agent_telemetry WHERE network_id = ?1", [NET_ID]],
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
    `INSERT INTO nodes (node_id, node_name, alias, network_id, hostname, created_at, updated_at, lifecycle_state)
     VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'), 'active')`,
    [NODE_ID, ALIAS, ALIAS, NET_ID, "dev-box"],
  );
  // agent-node 自己注册的那行:带 version / agent / hostname / 遥测 / 早就存在的 registered_at
  db.run(
    `INSERT INTO sessions (resume_id, alias, status, node_id, network_id, version, agent, hostname, server, project_dir,
                           cpu_cores, mem_total_gb, disk_total_gb, registered_at, updated_at, last_seen_at)
     VALUES (?1, ?2, 'working', ?3, ?4, '2.5.0-preview.64', 'agent-node:grok-build-cli', 'dev-box', 'dev-box', '/home/x/proj',
             8, 61.4, 500, ?5, datetime('now'), datetime('now'))`,
    [RESUME_SDK, ALIAS, NODE_ID, NET_ID, OLD_REGISTERED_AT],
  );
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

type Row = { resume_id: string; status: string; version: string | null; agent: string | null; hostname: string | null;
  cpu_cores: number | null; mem_total_gb: number | null; registered_at: string; task: string | null };
function rows(): Row[] {
  return db.all("SELECT resume_id, status, version, agent, hostname, cpu_cores, mem_total_gb, registered_at, task FROM sessions WHERE alias = ?1 AND network_id = ?2", [ALIAS, NET_ID]) as Row[];
}

describe("report_status: 同 alias 换 resume_id 时,描述性列从被替换的那行接手", () => {
  test("第二个上报者(grok-cli)不带 version/agent/遥测 → 这些列保留,status/task 以本次为准,仍只有一行", async () => {
    seed();
    const tools = buildHandlers();
    const r = await call(tools.report_status!, { resume_id: RESUME_CLI, alias: ALIAS, status: "working", task: "PING 已收到", network_id: NET_ID });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const all = rows();
    expect(all.length).toBe(1);
    const row = all[0]!;
    expect(row.resume_id).toBe(RESUME_CLI);
    expect(row.status).toBe("working");
    expect(row.task).toBe("PING 已收到");
    expect(row.version).toBe("2.5.0-preview.64");
    expect(row.agent).toBe("agent-node:grok-build-cli");
    expect(row.hostname).toBe("dev-box");
    expect(row.cpu_cores).toBe(8);
    expect(row.mem_total_gb).toBe(61.4);
    expect(row.registered_at).toBe(OLD_REGISTERED_AT);
  });

  test("上报里带了的列以上报为准(version 变了就用新的)", async () => {
    seed();
    const tools = buildHandlers();
    const r = await call(tools.report_status!, { resume_id: RESUME_CLI, alias: ALIAS, status: "idle", version: "9.9.9", hostname: "other-box", network_id: NET_ID });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const row = rows()[0]!;
    expect(rows().length).toBe(1);
    expect(row.version).toBe("9.9.9");
    expect(row.hostname).toBe("other-box");
    expect(row.agent).toBe("agent-node:grok-build-cli");
  });

  test("再换回原 resume_id(sdk)也不丢:两个上报者轮流说话,version 始终在", async () => {
    seed();
    const tools = buildHandlers();
    await call(tools.report_status!, { resume_id: RESUME_CLI, alias: ALIAS, status: "working", network_id: NET_ID });
    const r = await call(tools.report_status!, { resume_id: RESUME_SDK, alias: ALIAS, status: "idle", network_id: NET_ID });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const all = rows();
    expect(all.length).toBe(1);
    expect(all[0]!.resume_id).toBe(RESUME_SDK);
    expect(all[0]!.status).toBe("idle");
    expect(all[0]!.version).toBe("2.5.0-preview.64");
    expect(all[0]!.registered_at).toBe(OLD_REGISTERED_AT);
  });

  test("没有别的行可接手时(全新 alias)行为不变:INSERT 一行,registered_at 取 now", async () => {
    seed();
    db.run("DELETE FROM sessions WHERE network_id = ?1", [NET_ID]);
    const tools = buildHandlers();
    const r = await call(tools.report_status!, { resume_id: RESUME_SDK, alias: ALIAS, status: "idle", network_id: NET_ID });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const all = rows();
    expect(all.length).toBe(1);
    expect(all[0]!.version).toBeNull();
    expect(all[0]!.registered_at).not.toBe(OLD_REGISTERED_AT);
  });
});
