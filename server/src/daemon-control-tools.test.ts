import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { __resetSSEClientsForTest, createSSEStream } from "./push.js";

type Handler = (args: any) => Promise<{ content: Array<{ type: "text"; text: string }> }>;
const NET = "net_daemon_tools";
const OTHER = "net_daemon_tools_other";
const USER = "u_daemon_tools";
const OTHER_USER = "u_daemon_tools_other";
const DAEMON = "node_daemon_tools";
const ALIAS = "daemon-tools";
const TOKEN = "tok_daemon_tools";
const HASH = "b".repeat(64);

function clean() {
  for (const net of [NET, OTHER]) {
    for (const table of ["daemon_node_actions", "daemon_node_inventory", "sessions", "nodes", "api_tokens", "network_members", "networks"]) {
      try { db.run(`DELETE FROM ${table} WHERE network_id=?1`, [net]); } catch {}
    }
  }
  for (const user of [USER, OTHER_USER]) try { db.run("DELETE FROM users WHERE user_id=?1", [user]); } catch {}
}

beforeEach(() => {
  __resetSSEClientsForTest();
  clean();
  db.run("INSERT INTO users (user_id,username,password_hash,role,created_at) VALUES (?1,?1,'x','user',datetime('now'))", [USER]);
  db.run("INSERT INTO users (user_id,username,password_hash,role,created_at) VALUES (?1,?1,'x','user',datetime('now'))", [OTHER_USER]);
  for (const net of [NET, OTHER]) db.run("INSERT INTO networks (network_id,network_name,owner_id,created_at) VALUES (?1,?1,?2,datetime('now'))", [net, USER]);
  db.run("INSERT INTO network_members (user_id,network_id,role,joined_at) VALUES (?1,?2,'admin',datetime('now'))", [USER, NET]);
  db.run("INSERT INTO network_members (user_id,network_id,role,joined_at) VALUES (?1,?2,'admin',datetime('now'))", [OTHER_USER, OTHER]);
  db.run(`INSERT INTO nodes (node_id,node_name,alias,runtime,network_id,config_snapshot,created_at,updated_at)
          VALUES (?1,?2,?2,'claude-agent-sdk',?3,?4,datetime('now'),datetime('now'))`, [DAEMON, ALIAS, NET, JSON.stringify({ role: "host_supervisor" })]);
  db.run(`INSERT INTO api_tokens (token_id,token_hash,user_id,network_id,name,scope,created_at)
          VALUES (?1,'hash',?2,?3,?4,'network',datetime('now'))`, [TOKEN, USER, NET, `node:${ALIAS}`]);
});
afterAll(clean);

function handlers(opts: { user?: string | null; daemon?: boolean; network?: string | null } = {}): Record<string, Handler> {
  const server = new McpServer({ name: "test", version: "0" }) as any;
  const out: Record<string, Handler> = {};
  const orig = server.tool.bind(server);
  server.tool = (name: string, desc: string, schema: any, handler: Handler) => { out[name] = handler; return orig(name, desc, schema, handler); };
  registerTools(server, undefined, opts.network ?? null, opts.user ?? null, null, opts.daemon ?? false, opts.daemon ? TOKEN : "utok-test");
  return out;
}

async function call(h: Handler, args: any) {
  const r = await h(args);
  return JSON.parse(r.content[0].text);
}

const inventory = [{ local_node_id: "node_local_child", alias: "local-child", runtime: "opencode-cli", config_relpath: "local-child/config.json", observed_state: "stopped", config_hash: HASH, config_revision: 1 }];

describe("RFC-031 wired daemon control tools", () => {
  test("daemon sync → admin list/dispatch → daemon pull/ack → admin final status", async () => {
    const daemon = handlers({ daemon: true, network: NET });
    expect(await call(daemon.sync_daemon_inventory, { items: inventory })).toMatchObject({ ok: true, accepted: 1 });

    const admin = handlers({ user: USER });
    expect(await call(admin.list_daemon_nodes, { daemon_node_id: DAEMON, network_id: NET })).toMatchObject({ ok: true, count: 1 });
    const dispatched = await call(admin.dispatch_daemon_node_action, { daemon_node_id: DAEMON, local_node_id: "node_local_child", action: "start", network_id: NET });
    expect(dispatched).toMatchObject({ ok: true, status: "pending" });

    const pulled = await call(daemon.get_daemon_node_action, { action_id: dispatched.action_id });
    expect(pulled).toMatchObject({ ok: true, request: { action: "start", alias: "local-child", status: "delivered" } });
    expect(await call(daemon.ack_daemon_node_action, { action_id: dispatched.action_id, status: "succeeded", observed_state: "running", verified_pid: 4321, config_hash: HASH, config_revision: 1 })).toMatchObject({ ok: true, status: "succeeded" });
    expect(await call(admin.get_daemon_node_action_status, { action_id: dispatched.action_id, network_id: NET })).toMatchObject({ ok: true, action: { status: "succeeded" } });
  });

  test("cross-network read and dispatch do not reveal the managed node", async () => {
    const daemon = handlers({ daemon: true, network: NET });
    await call(daemon.sync_daemon_inventory, { items: inventory });
    const attacker = handlers({ user: OTHER_USER });
    const listed = await call(attacker.list_daemon_nodes, { daemon_node_id: DAEMON, network_id: NET });
    expect(listed.ok).toBe(false);
    expect(JSON.stringify(listed)).not.toContain("local-child");
    const dispatched = await call(attacker.dispatch_daemon_node_action, { daemon_node_id: DAEMON, local_node_id: "node_local_child", action: "start", network_id: NET });
    expect(dispatched.ok).toBe(false);
    expect(JSON.stringify(dispatched)).not.toContain("local-child");
  });

  test("user token cannot impersonate daemon pull or inventory sync", async () => {
    const admin = handlers({ user: USER });
    expect(await call(admin.sync_daemon_inventory, { items: inventory })).toMatchObject({ ok: false, error: "caller_not_a_daemon" });
    expect(await call(admin.get_daemon_node_action, { action_id: "ha_missing" })).toMatchObject({ ok: false, error: "caller_not_a_daemon" });
  });

  test("successful offline edit advances the registered node snapshot only after daemon ack", async () => {
    db.run(`INSERT INTO nodes (node_id,node_name,alias,runtime,model,network_id,config_snapshot,config_revision,created_at,updated_at)
            VALUES ('node_local_child','local-child','local-child','opencode-cli','old-model',?1,?2,1,datetime('now'),datetime('now'))`, [NET, JSON.stringify({ model: "old-model", flags: { maxTurns: 2 } })]);
    const daemon = handlers({ daemon: true, network: NET });
    await call(daemon.sync_daemon_inventory, { items: inventory });
    const admin = handlers({ user: USER });
    const dispatched = await call(admin.dispatch_daemon_node_action, { daemon_node_id: DAEMON, local_node_id: "node_local_child", action: "update", patch: { model: "new-model", flags: { maxTurns: 4 } }, base_revision: 1, network_id: NET });
    expect(db.get<any>("SELECT model,config_revision FROM nodes WHERE node_id='node_local_child'")).toMatchObject({ model: "old-model", config_revision: 1 });
    await call(daemon.get_daemon_node_action, { action_id: dispatched.action_id });
    await call(daemon.ack_daemon_node_action, { action_id: dispatched.action_id, status: "succeeded", observed_state: "stopped", config_revision: 2, config_hash: HASH });
    const row = db.get<any>("SELECT model,config_revision,config_snapshot FROM nodes WHERE node_id='node_local_child'");
    expect(row).toMatchObject({ model: "new-model", config_revision: 2 });
    expect(JSON.parse(row.config_snapshot)).toMatchObject({ model: "new-model", flags: { maxTurns: 4 } });
  });

  test("success ack is fail-closed unless its evidence matches the action", async () => {
    const daemon = handlers({ daemon: true, network: NET });
    await call(daemon.sync_daemon_inventory, { items: inventory });
    const admin = handlers({ user: USER });
    const started = await call(admin.dispatch_daemon_node_action, { daemon_node_id: DAEMON, local_node_id: "node_local_child", action: "start", network_id: NET });
    expect(await call(daemon.get_daemon_node_action, { action_id: started.action_id })).toMatchObject({ ok: true });
    expect(await call(daemon.ack_daemon_node_action, { action_id: started.action_id, status: "succeeded", observed_state: "running" })).toMatchObject({ ok: false, error: "invalid_daemon_action_result" });
    expect(await call(admin.get_daemon_node_action_status, { action_id: started.action_id, network_id: NET })).toMatchObject({ action: { status: "delivered" } });
    expect(await call(daemon.ack_daemon_node_action, { action_id: started.action_id, status: "succeeded", observed_state: "running", verified_pid: 4321, config_hash: HASH, config_revision: 1 })).toMatchObject({ ok: true, status: "succeeded" });
  });

  test("host supervisor is online when SQLite UTC timestamp is fresh under a non-UTC host timezone", async () => {
    const sqliteUtcNow = new Date().toISOString().slice(0, 19).replace("T", " ");
    db.run(`INSERT INTO sessions (resume_id,alias,status,network_id,registered_at,updated_at,last_seen_at)
            VALUES ('resume_daemon_tools',?1,'idle',?2,datetime('now'),datetime('now'),?3)`, [ALIAS, NET, sqliteUtcNow]);
    const admin = handlers({ user: USER });
    const listed = await call(admin.list_host_supervisors, { network_id: NET });
    expect(listed.daemons).toHaveLength(1);
    expect(listed.daemons[0]).toMatchObject({ daemon_node_id: DAEMON, alias: ALIAS, online: true });
  });

  test("live exact-network SSE keeps a daemon online after its stored heartbeat is stale", async () => {
    db.run(`INSERT INTO sessions (resume_id,alias,status,network_id,registered_at,updated_at,last_seen_at)
            VALUES ('resume_daemon_live',?1,'idle',?2,datetime('now'),datetime('now'),'2000-01-01 00:00:00')`, [ALIAS, NET]);
    const live = createSSEStream(ALIAS, NET);
    const reader = live.body!.getReader();
    const admin = handlers({ user: USER });
    const listed = await call(admin.list_host_supervisors, { network_id: NET });
    expect(listed.daemons[0]).toMatchObject({ daemon_node_id: DAEMON, alias: ALIAS, online: true });
    await reader.cancel();
  });

  test("same alias SSE in another network does not make a stale daemon online", async () => {
    db.run(`INSERT INTO sessions (resume_id,alias,status,network_id,registered_at,updated_at,last_seen_at)
            VALUES ('resume_daemon_stale',?1,'idle',?2,datetime('now'),datetime('now'),'2000-01-01 00:00:00')`, [ALIAS, NET]);
    const otherNetwork = createSSEStream(ALIAS, OTHER);
    const reader = otherNetwork.body!.getReader();
    const admin = handlers({ user: USER });
    const listed = await call(admin.list_host_supervisors, { network_id: NET });
    expect(listed.daemons[0]).toMatchObject({ daemon_node_id: DAEMON, alias: ALIAS, online: false });
    await reader.cancel();
  });
});
