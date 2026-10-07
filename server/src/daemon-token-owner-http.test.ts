import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { nodeTokenReissueError } from "../../agent-network/src/cli-errors";

process.env.COMMHUB_DB ||= `${mkdtempSync("/tmp/owner678-")}/hub.db`;
let db: any, hub: ReturnType<typeof Bun.serve>, base: string;
let owner: any, member: any, outsider: any, legacy: string, mismatched: string, bound: string;
let wrongBound: string, ownerless: string, revoked: string, crossNetwork: string, requestId: string;
const daemon = "n_owner_fixture_daemon", child = "n_owner_fixture_child";

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  expect(response.status).toBe(200);
  const raw = await response.text(), lines = raw.split("\n").filter(line => line.startsWith("data:"));
  const message = JSON.parse(lines.length ? lines.at(-1)!.slice(5) : raw);
  expect(message.error).toBeUndefined();
  return JSON.parse(message.result.content[0].text);
}
async function mint(token: string, network: string, name: string, nodeId?: string) {
  const response = await fetch(`${base}/api/auth/node-token`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ network_id: network, node_name: name, ...(nodeId ? { node_id: nodeId } : {}) }),
  });
  return { status: response.status, body: await response.json() as any };
}
beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register } = await import("./auth.js");
  const { generateNetworkToken, hashToken } = await import("./db.js");
  owner = register("owner678", "Fixture-Strong1!");
  member = register("member678", "Fixture-Strong1!");
  outsider = register("outside678", "Fixture-Strong1!");
  db.run("UPDATE users SET role='user' WHERE user_id IN (?1,?2)", [member.user.user_id, outsider.user.user_id]);
  db.run("INSERT INTO network_members(network_id,user_id,role) VALUES(?1,?2,'member')", [owner.network_id, member.user.user_id]);
  for (const id of [daemon, child, "n_ownerless_fixture"]) {
    db.run(`INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id,hostname,config_snapshot,lifecycle_state)
      VALUES(?1,?1,?1,?2,?3,'fixture-host',?4,'active')`, [id, owner.network_id,
      id === "n_ownerless_fixture" ? null : owner.user.user_id,
      JSON.stringify(id === daemon ? { role: "host_supervisor", daemon_capabilities: { adopt_capable: true } } : {})]);
  }
  db.run("INSERT INTO sessions(resume_id,alias,node_id,network_id,status,last_seen_at) VALUES(?1,?1,?1,?2,'idle',datetime('now'))", [daemon, owner.network_id]);
  function credential(label: string, user: string, node: string | null = null, alias = daemon, network = owner.network_id) {
    const token = generateNetworkToken();
    db.run(`INSERT INTO api_tokens(token_id,user_id,network_id,scope,name,token_hash,bound_node_id)
      VALUES(?1,?2,?3,'network',?4,?5,?6)`, [label, user, network, `node:${alias}`, hashToken(token), node]);
    return token;
  }
  legacy = credential("owner678_legacy", owner.user.user_id);
  mismatched = credential("owner678_mismatch", member.user.user_id);
  bound = credential("owner678_bound", member.user.user_id, daemon);
  wrongBound = credential("owner678_wrong_bound", member.user.user_id, "n_absent_bound");
  ownerless = credential("owner678_ownerless", member.user.user_id, null, "n_ownerless_fixture");
  db.run("UPDATE api_tokens SET node_identity_epoch=1 WHERE token_id='owner678_ownerless'");
  revoked = credential("owner678_revoked", owner.user.user_id);
  db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id='owner678_revoked'");
  crossNetwork = credential("owner678_cross", outsider.user.user_id, daemon, daemon, outsider.network_id);
  const { bootServer } = await import("./server.js");
  hub = bootServer({ port: 0, hostname: "127.0.0.1" }); base = `http://127.0.0.1:${hub.port}`;
  const request = await call(owner.token, "request_adopt_node", { node_id: child, daemon_node_id: daemon, workdir: "/fixture/project" });
  expect(request.ok).toBe(true); requestId = request.request_id;
}, 60000);
afterAll(() => hub?.stop(true));

test("name-only issuance checks existing ownership atomically", async () => {
  const count = () => db.get("SELECT COUNT(*) AS n FROM api_tokens").n;
  const before = count();
  expect(await mint(member.token, owner.network_id, daemon)).toEqual({ status: 400, body: { ok: false, error: "node_owner_mismatch" } });
  expect(await mint(owner.token, owner.network_id, "n_ownerless_fixture")).toEqual({ status: 400, body: { ok: false, error: "node_owner_mismatch" } });
  expect(count()).toBe(before);
  // Legacy owner refresh and a new node name remain supported.
  const refresh = await mint(owner.token, owner.network_id, daemon);
  expect(refresh.status).toBe(200);
  expect((await call(refresh.body.token, "list_my_children")).ok).toBe(true);
  expect((await mint(member.token, owner.network_id, "fresh678")).status).toBe(200);
  expect((await mint(member.token, owner.network_id, daemon, daemon)).body.error).toBe("node_owner_mismatch");
});

// Every daemon-facing handler must fail at the shared identity boundary,
// not incidentally at request lookup or argument validation.
const endpoints: [string, Record<string, unknown>][] = [
  ["list_my_pending_create_requests", {}], ["list_my_pending_lifecycle_requests", {}],
  ["get_create_request", { request_id: "cr_fixture_absent" }],
  ["ack_create_request", { request_id: "cr_fixture_absent", status: "started" }],
  ["get_stop_request", { request_id: "sr_fixture_absent" }],
  ["ack_stop_request", { request_id: "sr_fixture_absent", status: "stopped" }],
  ["get_start_request", { request_id: "start_fixture_absent" }],
  ["ack_start_request", { request_id: "start_fixture_absent", status: "started" }],
  ["list_my_children", {}], ["get_adopt_request", {}], ["ack_adopt_request", { status: "adopted" }],
  ["get_probe_request", { probe_id: "probe_fixture_absent" }],
  ["ack_probe_request", { probe_id: "probe_fixture_absent", status: "ok", latency_ms: 1 }],
];
for (const [name, arguments_] of endpoints) {
  test(`daemon identity boundary: ${name}`, async () => {
    const args = name.includes("adopt_request") ? { ...arguments_, request_id: requestId } : arguments_;
    for (const token of [mismatched, wrongBound, ownerless, owner.token, member.token]) {
      expect(await call(token, name, args)).toMatchObject({ ok: false, error: "caller_not_a_daemon" });
    }
    expect(db.get("SELECT status FROM node_daemon_bindings WHERE request_id=?1", requestId).status).toBe("pending");
  });
}

test("legacy owner and exact bound identity remain supported", async () => {
  expect(db.get("SELECT bound_node_id FROM api_tokens WHERE token_id='owner678_legacy'").bound_node_id).toBeNull();
  for (const token of [legacy, bound]) {
    expect((await call(token, "list_my_children")).ok).toBe(true);
    expect((await call(token, "list_my_pending_create_requests")).ok).toBe(true);
    expect((await call(token, "list_my_pending_lifecycle_requests")).ok).toBe(true);
    expect((await call(token, "get_adopt_request", { request_id: requestId })).ok).toBe(true);
  }
  // An explicit binding does not bypass the network or revocation boundaries.
  expect(await call(crossNetwork, "list_my_children")).toMatchObject({ ok: false, error: "caller_not_a_daemon" });
  const denied = await fetch(`${base}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${revoked}` } });
  expect(denied.status).toBe(401);
  expect(await call(legacy, "ack_adopt_request", { request_id: requestId, status: "adopted" })).toMatchObject({ ok: true, status: "active" });
  expect((await call(legacy, "list_my_children")).children).toContainEqual({ child_node_id: child, alias: child, lifecycle_state: "active", managed: "adopted" });
  const stop = await call(owner.token, "stop_node", { node_id: child, network_id: owner.network_id });
  expect(stop.ok).toBe(true);
  expect((await call(legacy, "get_stop_request", { request_id: stop.request_id })).ok).toBe(true);
  expect((await call(legacy, "ack_stop_request", { request_id: stop.request_id, status: "stopped" })).ok).toBe(true);
  const start = await call(owner.token, "start_node", { node_id: child, network_id: owner.network_id });
  expect(start.ok).toBe(true);
  expect((await call(legacy, "get_start_request", { request_id: start.request_id })).ok).toBe(true);
  expect(await call(legacy, "ack_start_request", { request_id: start.request_id, status: "started", child_pid: 4321 })).toMatchObject({ ok: true, status: "started" });
});

test("ownerless legacy daemon remains supported without rewriting its owner", async () => {
  db.run("UPDATE api_tokens SET node_identity_epoch=0 WHERE token_id='owner678_ownerless'");
  try {
    expect((await call(ownerless, "list_my_children")).ok).toBe(true);
    const refresh = await mint(member.token, owner.network_id, "n_ownerless_fixture");
    expect(refresh.status).toBe(200);
    expect(refresh.body.node_id).toBe("n_ownerless_fixture");
    expect((await call(refresh.body.token, "list_my_children")).ok).toBe(true);
    const withId = await mint(member.token, owner.network_id, "n_ownerless_fixture", "n_ownerless_fixture");
    expect(withId.status).toBe(200);
    expect(db.get("SELECT owner_user_id FROM nodes WHERE node_id='n_ownerless_fixture'").owner_user_id).toBeNull();
    expect((await mint(owner.token, owner.network_id, "n_ownerless_fixture")).status).toBe(400);
  } finally { db.run("UPDATE api_tokens SET node_identity_epoch=1 WHERE token_id='owner678_ownerless'"); }
});

test("new name-only registration binds once and its holder can refresh with either shape", async () => {
  const first = await mint(member.token, owner.network_id, "refresh_fixture");
  expect(first.status).toBe(200);
  expect(db.get("SELECT node_identity_epoch FROM api_tokens WHERE token_id=?1", first.body.token_id).node_identity_epoch).toBe(2);
  const result = await call(first.body.token, "report_status", {
    resume_id: "refresh-fixture-session", alias: "refresh_fixture", status: "idle", node_id: "n_refresh_fixture",
  });
  expect(result.ok).toBe(true);
  expect(db.get("SELECT bound_node_id FROM api_tokens WHERE token_id=?1", first.body.token_id).bound_node_id).toBe("n_refresh_fixture");
  expect(db.get("SELECT owner_user_id FROM nodes WHERE node_id='n_refresh_fixture'").owner_user_id).toBeNull();
  for (const id of [undefined, "n_refresh_fixture"]) {
    const refresh = await mint(member.token, owner.network_id, "refresh_fixture", id);
    expect(refresh.status).toBe(200);
    expect(refresh.body.node_id).toBe("n_refresh_fixture");
    expect((await call(refresh.body.token, "list_my_children")).ok).toBe(true);
  }
  expect((await mint(owner.token, owner.network_id, "refresh_fixture")).status).toBe(400);
});

test("fresh ID cannot mint another node alias", async () => {
  const before = db.get("SELECT COUNT(*) AS n FROM api_tokens").n;
  expect((await mint(member.token, owner.network_id, daemon, "n_fresh_impostor")).status).toBe(400);
  expect(db.get("SELECT node_id FROM nodes WHERE node_id='n_fresh_impostor'")).toBeNull();
  expect(db.get("SELECT COUNT(*) AS n FROM api_tokens").n).toBe(before);
  expect((await call(legacy, "list_my_children")).ok).toBe(true);
});

test("duplicate legacy aliases use bound IDs and unbound ambiguity fails closed", async () => {
  // Historical duplicate rows: the member's row was inserted first. Neither
  // lookup order nor alias can redirect the later owner's exact-bound token.
  const { hashToken, generateNetworkToken } = await import("./db.js");
  const tokens: string[] = [];
  for (const [id, user] of [["n_duplicate_first", member.user.user_id], ["n_duplicate_owner", owner.user.user_id]]) {
    db.run("INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id) VALUES(?1,'duplicate_fixture','duplicate_fixture',?2,?3)", [id, owner.network_id, user]);
    const token = generateNetworkToken(); tokens.push(token);
    db.run("INSERT INTO api_tokens(token_id,token_hash,user_id,network_id,name,scope,bound_node_id) VALUES(?1,?2,?3,?4,'node:duplicate_fixture','network',?1)", [id, hashToken(token), user, owner.network_id]);
    db.run("INSERT INTO node_daemon_bindings(request_id,network_id,node_id,daemon_node_id,workdir,requested_by,status,created_at,updated_at) VALUES(?1,?2,?1,?1,'/fixture',?3,'pending',1,1)", [id, owner.network_id, user]);
  }
  for (let i = 0; i < tokens.length; i++) {
    const result = await call(tokens[i], "list_my_children");
    expect(result.ok).toBe(true);
    const ownId = i === 0 ? "n_duplicate_first" : "n_duplicate_owner";
    expect((await call(tokens[i], "get_adopt_request", { request_id: ownId })).ok).toBe(true);
    expect((await call(tokens[i], "get_adopt_request", { request_id: i === 0 ? "n_duplicate_owner" : "n_duplicate_first" })).ok).toBe(false);
  }
  db.run("UPDATE api_tokens SET bound_node_id=NULL WHERE token_id='n_duplicate_owner'");
  expect(await call(tokens[1], "list_my_children")).toMatchObject({ ok: false, error: "caller_not_a_daemon" });
  db.run("UPDATE api_tokens SET bound_node_id=NULL WHERE token_id='n_duplicate_first'");
  expect(await call(tokens[0], "list_my_children")).toMatchObject({ ok: false, error: "caller_not_a_daemon" });
  expect((await mint(owner.token, owner.network_id, "duplicate_fixture", "n_third_duplicate")).status).toBe(400);
});

test("all production token issuers explicitly mark the rollout epoch", () => {
  const root = `${import.meta.dir}/../..`;
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
      const path = `${dir}/${entry.name}`;
      return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    });
  }
  const sourceFiles = ["server/src", "agent-network/src", "agent-network/bin", "agent-node/src"].flatMap(dir => sources(`${root}/${dir}`));
  let count = 0;
  for (const file of sourceFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/INSERT\s+INTO\s+api_tokens\s*\(([^)]+)\)/gi)) {
      expect(match[1]).toContain("node_identity_epoch"); count++;
    }
  }
  expect(count).toBe(9);
  expect(readFileSync(`${root}/agent-network/bin/cli.ts`, "utf8")).toContain("'admin-reset', 'user', 1)");
});

test("revoked ownerless credential cannot be reclaimed by doctor and gives actionable guidance", async () => {
  db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE name='node:n_ownerless_fixture'");
  const result = await mint(member.token, owner.network_id, "n_ownerless_fixture");
  expect(result.status).toBe(400);
  expect(result.body.error).toBe("node_owner_mismatch");
  expect(nodeTokenReissueError(result.body)).toContain("这个节点没有归属，请联系管理员认领（#682）");
  expect(nodeTokenReissueError({ error: "node_owner_unclaimed" })).toContain("请联系管理员认领（#682）");
  expect(nodeTokenReissueError({ error: "network_not_found" })).toBe("network_not_found");
  expect(readFileSync(`${import.meta.dir}/../../agent-network/bin/cli.ts`, "utf8")).toContain("body ? nodeTokenReissueError(body) : r.status");
});
