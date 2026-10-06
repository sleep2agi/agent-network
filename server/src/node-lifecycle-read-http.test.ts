import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "lifecycle-read-"));
process.env.COMMHUB_DB ||= join(dir, "hub.db");
process.env.COMMHUB_AUTH_TOKEN ||= "lifecycle-read-master-fixture";
let hub: ReturnType<typeof Bun.serve>, base: string;
let db: any, a: any, b: any, limited: any, daemonToken: string;
const ids = { active: "n_read_active", created: "node_read_created", manual: "node_read_manual", daemon: "n_read_daemon" };
const get = async (path: string, token = a.token) => {
  const res = await fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.json() as any };
};
const query = (kind: string, selector: string) => `/api/node-lifecycle-requests?kind=${kind}&${selector}`;

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register } = await import("./auth.js");
  const suffix = Date.now();
  a = register(`read_owner_${suffix}`, "ReadFixture-Strong1!");
  b = register(`read_other_${suffix}`, "ReadFixture-Strong1!");
  limited = register(`read_limited_${suffix}`, "ReadFixture-Strong1!");
  expect(a.ok && b.ok && limited.ok).toBe(true);
  for (const user of [a, b, limited]) db.run("UPDATE users SET role='user' WHERE user_id=?1", [user.user.user_id]);
  db.run("INSERT INTO network_members(network_id,user_id,role,agent_access) VALUES(?1,?2,'viewer','granted')", [a.network_id, limited.user.user_id]);
  for (const [key, id] of Object.entries(ids)) db.run(
    "INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,hostname,config_snapshot) VALUES(?1,?2,?2,?3,?4,'fixture-host',?5)",
    [id, `read-${key}`, a.network_id, a.user.user_id, key === "daemon" ? JSON.stringify({ role: "host_supervisor", daemon_capabilities: { adopt_capable: true } }) : "{}"]);
  for (const status of ["active", "pending", "refused", "revoked"]) {
    const id = status === "active" ? ids.active : `n_read_${status}`;
    if (status !== "active") db.run("INSERT INTO nodes(node_id,node_name,alias,network_id) VALUES(?1,?1,?2,?3)", [id, `read-${status}`, a.network_id]);
    db.run(`INSERT INTO node_daemon_bindings(request_id,network_id,node_id,daemon_node_id,workdir,requested_by,status,error,created_at,updated_at)
      VALUES(?1,?2,?3,?4,'/private/fixture',?5,?6,?7,1,2)`,
      [`adopt_read_${status}`, a.network_id, id, ids.daemon, a.user.user_id, status, status === "refused" ? "adopt_start_evidence_missing" : null]);
  }
  db.run(`INSERT INTO node_create_requests(request_id,daemon_node_id,child_name,network_id,runtime,flags_json,env_keys,status,created_at,created_by_token)
    VALUES('cr_read_created',?1,'created',?2,'codex-sdk','{}','[]','succeeded',1,'private-token')`, [ids.daemon, a.network_id]);
  db.run(`INSERT INTO node_stop_requests(request_id,network_id,daemon_node_id,child_node_id,child_alias,action,created_by_token,status,error,created_at,acked_at)
    VALUES('stop_read_failed',?1,?2,?3,'read-active','stop','private-token','stop_failed','adopt_explicit_private_socket_required',3,4)`, [a.network_id, ids.daemon, ids.active]);
  db.run(`INSERT INTO node_start_requests(request_id,network_id,daemon_node_id,child_node_id,child_alias,created_by_token,status,error,created_at,acked_at)
    VALUES('start_read_failed',?1,?2,?3,'read-active','private-token','start_failed','adopt_start_evidence_missing',5,6)`, [a.network_id, ids.daemon, ids.active]);
  db.run("INSERT INTO sessions(resume_id,alias,node_id,network_id,status,last_seen_at) VALUES('read-daemon-session','read-daemon',?1,?2,'idle',datetime('now'))", [ids.daemon, a.network_id]);
  const { generateNetworkToken, hashToken } = await import("./db.js");
  daemonToken = generateNetworkToken();
  db.run("INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash) VALUES('read-daemon-token',?1,?2,'network','node:read-daemon',?3)", [a.user.user_id, a.network_id, hashToken(daemonToken)]);
  const { bootServer } = await import("./server.js");
  hub = bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${hub.port}`;
}, 30_000);
afterAll(() => hub?.stop(true));

test("authenticated port-0 HTTP projects actual authority, never an id prefix", async () => {
  const { status, body } = await get(`/api/nodes?network_id=${a.network_id}`);
  expect(status).toBe(200);
  const rows = body.nodes;
  expect(rows.find((r: any) => r.node_id === ids.created)).toMatchObject({ managed: "created", adoption: null, lifecycle_controllable: true });
  expect(rows.find((r: any) => r.node_id === ids.manual)).toMatchObject({ managed: "none", adoption: null, lifecycle_controllable: false });
  expect(rows.find((r: any) => r.node_id === ids.active)).toMatchObject({ managed: "adopted", adoption: { status: "active", request_id: "adopt_read_active" }, lifecycle_controllable: true });
  for (const status of ["pending", "refused", "revoked"]) expect(rows.find((r: any) => r.node_id === `n_read_${status}`)).toMatchObject({ managed: "none", adoption: { status } });
});
test("adopt query preserves all persisted states, request id and bounded projection", async () => {
  for (const status of ["pending", "active", "refused", "revoked"]) {
    const r = await get(query("adopt", `request_id=adopt_read_${status}`));
    expect(r.status).toBe(200);
    expect(r.body.request).toMatchObject({ kind: "adopt", status, request_id: `adopt_read_${status}` });
    expect(r.body.request.workdir).toBeUndefined();
    expect(r.body.request.requested_by).toBeUndefined();
  }
});
test("start/stop returns daemon failure codes; node selector returns latest, not success fiction", async () => {
  for (const [kind, error] of [["start", "adopt_start_evidence_missing"], ["stop", "adopt_explicit_private_socket_required"]]) {
    const r = await get(query(kind, `node_id=${ids.active}`));
    expect(r.status).toBe(200);
    expect(r.body.request).toMatchObject({ status: `${kind}_failed`, error, node_id: ids.active });
    expect(r.body.request.created_by_token).toBeUndefined();
  }
  expect((await get(query("start", `node_id=${ids.manual}`))).body.request).toBeNull();
});
test("cross-network request and node guesses do not disclose data", async () => {
  for (const kind of ["adopt", "start", "stop"]) {
    const id = kind === "adopt" ? "adopt_read_active" : `${kind}_read_failed`;
    const denied = await get(query(kind, `request_id=${id}`), b.token);
    expect(denied.status).toBe(404);
    expect(denied.body).toEqual((await get(query(kind, "request_id=nonexistent"), b.token)).body);
    expect((await get(query(kind, `node_id=${ids.active}`), b.token)).status).toBe(404);
    expect((await get(query(kind, `request_id=${id}&network_id=${a.network_id}`), b.token)).status).toBe(403);
  }
});
test("same-network restricted viewer without node grants cannot read requests", async () => {
  for (const kind of ["adopt", "start", "stop"]) {
    expect((await get(query(kind, `node_id=${ids.active}&network_id=${a.network_id}`), limited.token)).status).toBe(404);
    const id = kind === "adopt" ? "adopt_read_active" : `${kind}_read_failed`;
    expect((await get(query(kind, `request_id=${id}&network_id=${a.network_id}`), limited.token)).status).toBe(404);
  }
  expect((await get(`/api/nodes?network_id=${a.network_id}`, limited.token)).body.nodes).toEqual([]);
});
test("current node grant allows reads; revocation immediately closes them", async () => {
  db.run("INSERT INTO network_member_agent_grants(network_id,user_id,node_id,can_message) VALUES(?1,?2,?3,0)", [a.network_id, limited.user.user_id, ids.active]);
  try {
    expect((await get(query("adopt", "request_id=adopt_read_active"), limited.token)).status).toBe(200);
    const nodes = (await get(`/api/nodes?network_id=${a.network_id}`, limited.token)).body.nodes;
    expect(nodes).toHaveLength(1);
    expect(nodes[0].managed).toBe("adopted");
  } finally { db.run("DELETE FROM network_member_agent_grants WHERE user_id=?1 AND node_id=?2", [limited.user.user_id, ids.active]); }
  expect((await get(query("adopt", "request_id=adopt_read_active"), limited.token)).status).toBe(404);
});
test("daemon and legacy master do not gain the new user read surface", async () => {
  for (const token of [daemonToken, process.env.COMMHUB_AUTH_TOKEN!]) {
    expect((await get(query("adopt", "request_id=adopt_read_active"), token)).status).toBe(403);
    const nodes = (await get(`/api/nodes?network_id=${a.network_id}`, token)).body.nodes;
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.every((n: any) => !("managed" in n) && !("adoption" in n))).toBe(true);
  }
  expect((await get(query("adopt", "request_id=adopt_read_active"), "invalid")).status).toBe(401);
  const queryOnly = await fetch(base + query("adopt", `request_id=adopt_read_active&token=${encodeURIComponent(a.token)}`));
  expect([401, 403]).toContain(queryOnly.status);
});
test("host-supervisors capability respects user token and node visibility; absent stays absent", async () => {
  const path = `/api/host-supervisors?network_id=${a.network_id}`;
  expect((await get(path)).body.daemons.find((d: any) => d.daemon_node_id === ids.daemon).adopt_capable).toBe(true);
  for (const token of [limited.token, daemonToken]) {
    const r = await get(path, token);
    expect((r.body.daemons ?? []).every((d: any) => !("adopt_capable" in d))).toBe(true);
  }
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { adopt_capable: false } }), ids.daemon]);
  expect((await get(path)).body.daemons[0].adopt_capable).toBe(false);
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id=?2", [JSON.stringify({ role: "host_supervisor" }), ids.daemon]);
  expect((await get(path)).body.daemons[0].adopt_capable).toBeUndefined();
});
test("invalid selectors rejected rather than listing every lifecycle request", async () => {
  for (const suffix of ["", "kind=adopt", "kind=other&node_id=x", "kind=start&request_id=x&node_id=y", "kind=stop&node_id=x&node_id=y"])
    expect((await get(`/api/node-lifecycle-requests?${suffix}`)).status).toBe(400);
});
test("request state refresh exposes pending, completion and binding-missing failure without caching", async () => {
  for (const [kind, statuses] of [["start", ["pending", "delivered", "started", "start_failed"]], ["stop", ["pending", "delivered", "stopped", "stop_failed", "noop_not_my_child"]]] as const) {
    for (const status of statuses) {
      const error = status.endsWith("failed") ? "adopt_active_binding_required" : null;
      db.run(`UPDATE node_${kind}_requests SET status=?1,error=?2 WHERE request_id=?3`, [status, error, `${kind}_read_failed`]);
      expect((await get(query(kind, `request_id=${kind}_read_failed`))).body.request).toMatchObject({ status, error });
    }
  }
});
test("join refuses a request whose stored network disagrees with its target node", async () => {
  db.run("UPDATE node_start_requests SET network_id=?1 WHERE request_id='start_read_failed'", [b.network_id]);
  try {
    expect((await get(query("start", "request_id=start_read_failed"))).status).toBe(404);
    expect((await get(query("start", "request_id=start_read_failed"), b.token)).status).toBe(404);
  } finally { db.run("UPDATE node_start_requests SET network_id=?1 WHERE request_id='start_read_failed'", [a.network_id]); }
});
