import { beforeEach, afterAll, expect, test } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { db } from "./db.js";
import { registerTools } from "./tools.js";
import { buildControllableMap } from "./node-lifecycle-controllable.js";

const NET = "net_adoption_test", USER = "u_adoption_test", CHILD = "n_adoption_child", DAEMON = "node_adoption_daemon";
function cleanup() {
  for (const table of ["node_daemon_bindings", "node_stop_requests", "node_start_requests", "node_create_requests", "audit_log", "sessions", "nodes", "api_tokens", "network_members", "networks"])
    db.run(`DELETE FROM ${table} WHERE network_id=?1`, [NET]);
  db.run("DELETE FROM users WHERE user_id=?1", [USER]);
}
beforeEach(() => {
  cleanup();
  db.run("INSERT INTO users(user_id,username,password_hash,role) VALUES(?1,?1,'x','user')", [USER]);
  db.run("INSERT INTO networks(network_id,network_name,owner_id) VALUES(?1,?1,?2)", [NET, USER]);
  db.run("INSERT INTO network_members(user_id,network_id,role) VALUES(?1,?2,'owner')", [USER, NET]);
  for (const [id, alias, snap] of [[DAEMON, "adoption-daemon", { role: "host_supervisor", daemon_capabilities: { adopt_capable: true } }], [CHILD, "adoption-child", {}]] as const) {
    db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,hostname,config_snapshot,lifecycle_state) VALUES(?1,?2,?2,?3,?4,'test-host',?5,'active')`, [id, alias, NET, USER, JSON.stringify(snap)]);
  }
  db.run("INSERT INTO sessions(resume_id,session_id,alias,network_id,status,last_seen_at) VALUES('adoption-session','adoption-session','adoption-daemon',?1,'idle',datetime('now'))", [NET]);
  db.run("INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash) VALUES('adoption-token',?1,?2,'network','node:adoption-daemon','adoption-hash')", [USER, NET]);
});
afterAll(cleanup);
function handlers(kind: "user" | "daemon" | "stranger" = "user") {
  const server = new McpServer({ name: "adoption-test", version: "0" }) as any;
  const out: any = {}, original = server.tool.bind(server);
  server.tool = (name: string, desc: string, schema: any, handler: any) => { out[name] = handler; return original(name, desc, schema, handler); };
  registerTools(server, undefined, kind === "daemon" ? NET : null, kind === "user" ? USER : null, null, kind === "daemon", kind === "daemon" ? "adoption-token" : null);
  return out;
}
const call = async (handler: any, args: any = {}) => JSON.parse((await handler(args)).content[0].text);
const request = () => call(handlers().request_adopt_node, { node_id: CHILD, daemon_node_id: DAEMON, workdir: "/workspace/project" });
async function adopt() {
  const r = await request(); expect(r.ok).toBe(true);
  expect(await call(handlers("daemon").ack_adopt_request, { request_id: r.request_id, status: "adopted" })).toMatchObject({ ok: true, status: "active" });
  return r.request_id;
}

test("unbound node_ cannot use an explicitly supplied daemon (witnessed red on main)", async () => {
  db.run("UPDATE nodes SET node_id='node_unbound_child' WHERE node_id=?1", [CHILD]);
  expect(await call(handlers().stop_node, { child_node_id: "node_unbound_child", daemon_node_id: DAEMON, network_id: NET })).toMatchObject({ ok: false, error: "daemon_not_resolvable" });
  expect(db.all("SELECT * FROM node_stop_requests WHERE network_id=?1", NET)).toHaveLength(0);
});
test("two-phase binding, daemon-bound pull, controllable map, adopted delete refused", async () => {
  const r = await request(); expect(r.ok).toBe(true);
  expect(await call(handlers().stop_node, { child_node_id: CHILD, daemon_node_id: DAEMON, network_id: NET })).toMatchObject({ ok: false });
  expect(await call(handlers("daemon").get_adopt_request, { request_id: r.request_id })).toMatchObject({ ok: true, node_id: CHILD, alias: "adoption-child", workdir: "/workspace/project" });
  expect(await call(handlers().get_adopt_request, { request_id: r.request_id })).toMatchObject({ ok: false });
  expect(await call(handlers("daemon").ack_adopt_request, { request_id: r.request_id, status: "adopted" })).toMatchObject({ ok: true });
  expect((await call(handlers("daemon").list_my_children)).children).toContainEqual({ child_node_id: CHILD, alias: "adoption-child", lifecycle_state: "active", managed: "adopted" });
  expect(buildControllableMap([], [{ node_id: CHILD, daemon_node_id: DAEMON }]).get(CHILD)).toBe(DAEMON);
  expect(await call(handlers().delete_node, { child_node_id: CHILD, confirm_alias: "adoption-child", network_id: NET })).toMatchObject({ ok: false, error: "adopted_node_delete_unsupported" });
  expect(db.get<any>("SELECT lifecycle_state FROM nodes WHERE node_id=?1", CHILD).lifecycle_state).toBe("active");
});
test("adopted stop/start complete through existing protocol; revocation removes authority", async () => {
  await adopt(); const u = handlers(), d = handlers("daemon");
  const stop = await call(u.stop_node, { child_node_id: CHILD, network_id: NET }); expect(stop.ok).toBe(true);
  expect((await call(d.get_stop_request, { request_id: stop.request_id })).ok).toBe(true);
  expect((await call(d.ack_stop_request, { request_id: stop.request_id, status: "stopped" })).ok).toBe(true);
  expect((await call(d.list_my_children)).children[0].lifecycle_state).toBe("stopped");
  const start = await call(u.start_node, { child_node_id: CHILD, network_id: NET }); expect(start.ok).toBe(true);
  expect((await call(d.get_start_request, { request_id: start.request_id })).ok).toBe(true);
  expect((await call(d.ack_start_request, { request_id: start.request_id, status: "started", child_pid: 4321 })).ok).toBe(true);
  expect((await call(u.unadopt_node, { node_id: CHILD })).ok).toBe(true);
  expect((await call(d.list_my_children)).children).toHaveLength(0);
  expect((await call(u.stop_node, { child_node_id: CHILD, daemon_node_id: DAEMON, network_id: NET })).ok).toBe(false);
});
test("pending cancellation cannot be resurrected; duplicate pending refuses", async () => {
  const r = await request(); expect(r.ok).toBe(true);
  expect((await request()).error).toBe("node_already_managed");
  expect((await call(handlers().unadopt_node, { node_id: CHILD })).ok).toBe(true);
  expect((await call(handlers("daemon").ack_adopt_request, { request_id: r.request_id, status: "adopted" })).error).toBe("request_not_pending");
});
test("human-only and owner/admin fail closed; admin exception audited", async () => {
  const args = { node_id: CHILD, daemon_node_id: DAEMON, workdir: "/workspace/project" };
  expect((await call(handlers("daemon").request_adopt_node, args)).ok).toBe(false);
  expect((await call(handlers("stranger").request_adopt_node, args)).ok).toBe(false);
  db.run("UPDATE network_members SET role='member' WHERE network_id=?1", [NET]);
  db.run("UPDATE nodes SET owner_user_id=NULL WHERE node_id=?1", [CHILD]);
  expect((await request()).error).toBe("adopt_forbidden");
  db.run("UPDATE network_members SET role='owner' WHERE network_id=?1", [NET]);
  expect((await request()).ok).toBe(true);
  expect(db.get("SELECT action FROM audit_log WHERE action='adopt_by_admin' AND network_id=?1", NET)).not.toBeNull();
});
test("viewer owner cannot request; membership loss before ack cannot activate", async () => {
  db.run("UPDATE network_members SET role='viewer' WHERE network_id=?1", [NET]);
  expect((await request()).error).toBe("adopt_forbidden");
  db.run("UPDATE network_members SET role='owner' WHERE network_id=?1", [NET]);
  const r = await request(); expect(r.ok).toBe(true);
  db.run("DELETE FROM network_members WHERE network_id=?1", [NET]);
  expect((await call(handlers("daemon").ack_adopt_request, { request_id: r.request_id, status: "adopted" })).error).toBe("adopt_forbidden");
});
test("wrong daemon cannot pull/ack; refusal releases reservation; in-flight unadopt is refused", async () => {
  const r = await request(); expect(r.ok).toBe(true);
  db.run("UPDATE node_daemon_bindings SET daemon_node_id='other-daemon' WHERE request_id=?1", [r.request_id]);
  const d = handlers("daemon");
  expect((await call(d.get_adopt_request, { request_id: r.request_id })).error).toBe("request_not_found");
  expect((await call(d.ack_adopt_request, { request_id: r.request_id, status: "adopted" })).error).toBe("request_not_found");
  db.run("UPDATE node_daemon_bindings SET daemon_node_id=?1 WHERE request_id=?2", [DAEMON, r.request_id]);
  expect((await call(d.ack_adopt_request, { request_id: r.request_id, status: "refused", error: "adopt_roots_not_configured" })).status).toBe("refused");
  await adopt();
  expect((await call(handlers().stop_node, { child_node_id: CHILD, network_id: NET })).ok).toBe(true);
  expect((await call(handlers().unadopt_node, { node_id: CHILD })).error).toBe("node_lifecycle_in_flight");
});
test("old daemon, hostname mismatch, stale heartbeat and cross-network daemon rejected", async () => {
  db.run("UPDATE nodes SET config_snapshot='{}' WHERE node_id=?1", [DAEMON]);
  expect((await request()).error).toBe("daemon_not_adopt_capable");
  db.run("UPDATE nodes SET config_snapshot=?1,hostname='different' WHERE node_id=?2", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { adopt_capable: true } }), DAEMON]);
  expect((await request()).error).toBe("hostname_mismatch");
  db.run("UPDATE nodes SET hostname='test-host' WHERE node_id=?1", [DAEMON]);
  db.run("UPDATE sessions SET last_seen_at='2000-01-01 00:00:00' WHERE network_id=?1", [NET]);
  expect((await request()).error).toBe("daemon_offline");
  expect((await call(handlers().request_adopt_node, { node_id: CHILD, daemon_node_id: "other_network_daemon", workdir: "/workspace/project" })).error).toBe("daemon_not_found");
});
test("network boundaries apply to both human request and daemon pull/ack", async () => {
  const r = await request(); expect(r.ok).toBe(true);
  db.run("UPDATE node_daemon_bindings SET network_id='net_other_adoption_test' WHERE request_id=?1", [r.request_id]);
  try {
    const d = handlers("daemon");
    expect((await call(d.get_adopt_request, { request_id: r.request_id })).error).toBe("request_not_found");
    expect((await call(d.ack_adopt_request, { request_id: r.request_id, status: "adopted" })).error).toBe("request_not_found");
  } finally { db.run("UPDATE node_daemon_bindings SET network_id=?1 WHERE request_id=?2", [NET, r.request_id]); }
  db.run("UPDATE nodes SET network_id='net_other_adoption_test' WHERE node_id=?1", [DAEMON]);
  try { expect((await request()).error).toBe("daemon_not_found"); }
  finally { db.run("UPDATE nodes SET network_id=?1 WHERE node_id=?2", [NET, DAEMON]); }
  db.run("UPDATE nodes SET network_id='net_other_adoption_test' WHERE node_id=?1", [CHILD]);
  try { expect((await request()).error).toBe("adopt_forbidden"); }
  finally { db.run("UPDATE nodes SET network_id=?1 WHERE node_id=?2", [NET, CHILD]); }
});
