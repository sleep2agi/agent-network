import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";

const NET = "net_start_node"; const USER = "u_start_node";
const DAEMON = "node_start_daemon"; const DAEMON_ALIAS = "start-daemon";
const CHILD = "node_start_child"; const CHILD_ALIAS = "start-child";

function cleanup() {
  for (const table of ["node_start_requests", "node_create_requests", "audit_log", "nodes", "api_tokens", "network_members", "networks"]) {
    try { db.run(`DELETE FROM ${table} WHERE network_id = ?1`, [NET]); } catch {}
  }
  try { db.run("DELETE FROM users WHERE user_id=?1", USER); } catch {}
}
beforeEach(() => { cleanup();
  db.run(`INSERT INTO users(user_id,username,password_hash,role,created_at) VALUES(?1,?1,'x','user',datetime('now'))`, USER);
  db.run(`INSERT INTO networks(network_id,network_name,owner_id,created_at) VALUES(?1,?1,?2,datetime('now'))`, [NET, USER]);
  db.run(`INSERT INTO network_members(user_id,network_id,role,joined_at) VALUES(?1,?2,'owner',datetime('now'))`, [USER, NET]);
  db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,config_snapshot,hostname,created_at,updated_at,lifecycle_state) VALUES(?1,?2,?2,?3,'{}','h',datetime('now'),datetime('now'),'active')`, [DAEMON, DAEMON_ALIAS, NET]);
  db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,config_snapshot,hostname,created_at,updated_at,lifecycle_state) VALUES(?1,?2,?2,?3,'{}','h',datetime('now'),datetime('now'),'stopped')`, [CHILD, CHILD_ALIAS, NET]);
  db.run(`INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash) VALUES('tok_start_daemon',?1,?2,'network',?3,'h')`, [USER, NET, `node:${DAEMON_ALIAS}`]);
  db.run(`INSERT INTO node_create_requests(request_id,daemon_node_id,child_name,network_id,runtime,model,flags_json,env_keys,status,created_at,created_by_token,child_node_id) VALUES('cr_start_child',?1,?2,?3,'codex-sdk','x','{}','[]','succeeded',1,'t',?4)`, [DAEMON, CHILD_ALIAS, NET, CHILD]);
});
afterAll(cleanup);

function handlers(user: string | null, daemon = false) {
  const s = new McpServer({ name: "t", version: "0" }) as any; const out: any = {};
  const orig = s.tool.bind(s); s.tool = (n: string, d: string, schema: any, h: any) => { out[n] = h; return orig(n,d,schema,h); };
  registerTools(s, undefined, daemon ? NET : null, user, null, daemon, daemon ? "tok_start_daemon" : null); return out;
}
async function call(h: any, args: any) { return JSON.parse((await h(args)).content[0].text); }

describe("start_node Hub -> daemon lifecycle", () => {
  test("dispatch, authenticated pull, ack transitions stopped -> starting -> active", async () => {
    const u = handlers(USER); const dispatch = await call(u.start_node, { child_node_id: CHILD, network_id: NET });
    expect(dispatch.ok).toBe(true); expect(dispatch.lifecycle_state).toBe("starting");
    const d = handlers(null, true); const pulled = await call(d.get_start_request, { request_id: dispatch.request_id });
    expect(pulled).toMatchObject({ ok: true, child_node_id: CHILD, child_alias: CHILD_ALIAS });
    const ack = await call(d.ack_start_request, { request_id: dispatch.request_id, status: "started", child_pid: 4321 });
    expect(ack.ok).toBe(true);
    expect(db.get<any>(`SELECT lifecycle_state FROM nodes WHERE node_id=?1`, CHILD)?.lifecycle_state).toBe("active");
    expect(db.all<any>(`SELECT action FROM audit_log WHERE target_id=?1 ORDER BY id`, dispatch.request_id).map((x:any)=>x.action)).toEqual(["start_node_dispatched", "start_node_completed"]);
  });
  test("active child and caller-supplied wrong daemon fail closed", async () => {
    const u = handlers(USER);
    db.run(`UPDATE nodes SET lifecycle_state='active' WHERE node_id=?1`, CHILD);
    expect((await call(u.start_node, { child_node_id: CHILD, network_id: NET })).error).toBe("node_not_stopped");
    db.run(`UPDATE nodes SET lifecycle_state='stopped' WHERE node_id=?1`, CHILD);
    expect((await call(u.start_node, { child_node_id: CHILD, daemon_node_id: "node_wrong", network_id: NET })).error).toBe("daemon_child_mismatch");
  });
});
