// #4315 —— 裸回执（既无 alias 也无 in_reply_to）会把那笔任务留成 expired，
// 攒够 3 条就把节点挡成 target_never_consumes。
// 判据：**这台节点手上恰好一条非终态任务**时才推断 in_reply_to；多条并存保持原拒绝。
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { db, uuidv4 } from "./db.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.js";

const NET = "net_4315";
const SENDER = "sender-4315";
const NODE_ALIAS = "node-4315";
const NODE_ID = "node_4315_x";
const TOKEN_ID = "tok_4315_x";
const USER = "u4315";

function reset() {
  for (const t of ["tasks", "inbox", "task_events"]) {
    try { db.run(`DELETE FROM ${t} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM sessions WHERE network_id = ?1", [NET]); } catch {}
  try { db.run("DELETE FROM nodes WHERE network_id = ?1", [NET]); } catch {}
}

function seed() {
  reset();
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, created_at) VALUES (?1, ?2, ?2, ?3, datetime('now'))`,
    [NODE_ID, NODE_ALIAS, NET],
  );
  try { db.run("DELETE FROM users WHERE user_id = ?1", [USER]); } catch {}
  db.run(`INSERT INTO users (user_id, username, password_hash, role, created_at) VALUES (?1, ?1, 'x', 'user', datetime('now'))`, [USER]);
  try { db.run("DELETE FROM api_tokens WHERE token_id = ?1", [TOKEN_ID]); } catch {}
  db.run(
    `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, bound_node_id, node_identity_epoch)
     VALUES (?1, 'h4315', ?2, ?3, ?4, 'network', ?5, 2)`,
    [TOKEN_ID, USER, NET, `node:${NODE_ALIAS}`, NODE_ID],
  );
}

function makeTask(status: string, content: string): string {
  const id = uuidv4();
  db.run(
    `INSERT INTO tasks (task_id, from_name, to_name, priority, status, content, requires_response, created_at, network_id)
     VALUES (?1, ?2, ?3, 'normal', ?4, ?5, 'reply', datetime('now'), ?6)`,
    [id, SENDER, NODE_ALIAS, status, content, NET],
  );
  return id;
}

function buildNodeTokenTools() {
  const server = new McpServer({ name: "t", version: "0" }) as any;
  const tools: Record<string, any> = {};
  const orig = server.tool.bind(server);
  server.tool = (name: string, desc: string, schema: any, handler: any) => {
    tools[name] = handler;
    return orig(name, desc, schema, handler);
  };
  // bound_node_id 就是「这台节点」——推断靠它定位手上的任务
  registerTools(server, undefined, NET, null, NODE_ALIAS, true, TOKEN_ID);
  return tools;
}

const call = async (h: any, args: any) =>
  JSON.parse((await h(args)).content[0].text);

describe("#4315 裸回执的单候选推断", () => {
  beforeEach(seed);

  test("恰好一条在手任务 ⇒ 推断 in_reply_to，任务被正常结束（不再留 expired）", async () => {
    const tools = buildNodeTokenTools();
    const t = makeTask("delivered", "x4315 single open task");
    const r = await call(tools["send_reply"], { text: "done, single open task" });
    expect(r.ok).toBe(true);
    const row = db.get<{ status: string }>("SELECT status FROM tasks WHERE task_id = ?1", t);
    expect(row?.status).toBe("replied");
  });

  test("两条在手任务 ⇒ 不推断，仍按原样拒绝（宁可拒绝也不赌对象）", async () => {
    const tools = buildNodeTokenTools();
    makeTask("delivered", "x4315 open A");
    makeTask("delivered", "x4315 open B");
    const r = await call(tools["send_reply"], { text: "ambiguous" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("reply_target_required");
  });
});
