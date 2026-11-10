import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { db } from "./db";
import { register, createNetworkTokenForNode } from "./auth";
import { createSessionSourceIssuer, SourceIssuerError, type SourceSelection } from "./session-source-issuer";
import { createSessionSourceGrantStore } from "./session-source-grant";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools";
import { createSessionSourceTransport } from "./session-source-transport";
import { buildConfigSnapshot } from "../../agent-node/src/runtime/config-apply";
import { SOURCE_FORK_CAPABILITY } from "../../contracts/session-source-transport";
import { SOURCE_DELIVERY_CAPABILITY } from "../../contracts/session-source-delivery";

const v2Snapshot = () => buildConfigSnapshot({ runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "copresence" }, false, 0);

const issuer = createSessionSourceIssuer();
let owner: ReturnType<typeof register>, member: ReturnType<typeof register>, bootstrap: ReturnType<typeof register>;
let sourceToken: ReturnType<typeof createNetworkTokenForNode>, daemonToken: ReturnType<typeof createNetworkTokenForNode>;
let selection: SourceSelection;
const request = (token?: string) => new Request("http://isolated.invalid/internal-only", {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});
const counts = () => ["session_source_grants", "node_create_requests"].map(table => db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)!.n);
const inspect = () => issuer.inspect(request(owner.token), selection);
beforeAll(() => {
  bootstrap = register("issuer_bootstrap", "Fixture-Strong-4150!");
  owner = register("issuer_owner", "Fixture-Strong-4150!");
  member = register("issuer_member", "Fixture-Strong-4150!");
  expect(bootstrap.ok && owner.ok && member.ok).toBe(true);
  const net = owner.network_id!, uid = owner.user!.user_id;
  selection = { network_id: net, source_node_id: "n_source", daemon_node_id: "n_daemon", mode: "attach_existing" };
  sourceToken = createNetworkTokenForNode(uid, net, "source", "n_source");
  daemonToken = createNetworkTokenForNode(uid, net, "daemon", "n_daemon");
  expect(sourceToken.ok && daemonToken.ok).toBe(true);
  db.run(`INSERT INTO network_members (network_id,user_id,role,agent_access) VALUES (?1,?2,'member','granted')`, [net, member.user!.user_id]);
  db.run(`INSERT INTO sessions (resume_id,alias,node_id,network_id,last_seen_at) VALUES
    ('issuer_source','source','n_source',?1,datetime('now')),('issuer_daemon','daemon','n_daemon',?1,datetime('now'))`, [net]);
  db.run(`INSERT INTO node_create_requests
    (request_id,daemon_node_id,child_name,network_id,runtime,flags_json,env_keys,status,child_node_id,created_at,created_by_token,workdir)
    VALUES ('cr_original','n_daemon','source',?1,'opencode-cli','{}','[]','succeeded','n_source',1000,?2,'/reported/path')`, [net, owner.token_id!]);
});
beforeEach(() => {
  db.run("UPDATE users SET role='user' WHERE user_id=?1", [owner.user!.user_id]);
  db.run("UPDATE network_members SET role='owner',agent_access='all' WHERE user_id=?1 AND network_id=?2", [owner.user!.user_id, owner.network_id!]);
  db.run("UPDATE network_members SET role='member',agent_access='granted' WHERE user_id=?1 AND network_id=?2", [member.user!.user_id, owner.network_id!]);
  db.run("DELETE FROM network_member_agent_grants WHERE user_id=?1", [member.user!.user_id]);
  db.run("UPDATE api_tokens SET revoked_at=NULL,expires_at=NULL,last_used_at=datetime('now') WHERE user_id=?1", [owner.user!.user_id]);
  db.run("UPDATE api_tokens SET bound_node_id='n_source' WHERE token_id=?1", [sourceToken.token_id!]);
  db.run("UPDATE nodes SET network_id=?1 WHERE node_id IN ('n_source','n_daemon')", [owner.network_id!]);
  db.run("UPDATE nodes SET runtime='opencode-cli',config_snapshot=?1 WHERE node_id='n_source'", [JSON.stringify(v2Snapshot())]);
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_daemon'", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { can_create_nodes: true } })]);
  db.run("UPDATE sessions SET last_seen_at=datetime('now') WHERE resume_id IN ('issuer_source','issuer_daemon')");
  db.run("UPDATE node_create_requests SET status='succeeded',daemon_node_id='n_daemon' WHERE request_id='cr_original'");
  db.run("DELETE FROM node_daemon_bindings WHERE node_id='n_source'");
  db.run("DELETE FROM session_project_creates WHERE request_id='issuer_project'");
});
afterAll(() => db.close());

test("actual CLI registration: explicit V2 copresence admits; SDK/V1/unknown/host and foreign scope refuse", async () => {
  const server = new McpServer({ name: "source-guard-diagnosis", version: "0" }) as any;
  let report: any;
  const original = server.tool.bind(server);
  server.tool = (name: string, desc: string, schema: any, handler: any) => {
    if (name === "report_status") report = handler;
    return original(name, desc, schema, handler);
  };
  registerTools(server, undefined, owner.network_id!, owner.user!.user_id, "source", true, sourceToken.token_id!);
  // project-new mints a bound credential but does not precreate a nodes row.
  db.run("DELETE FROM nodes WHERE node_id='n_source'");
  const registerSnapshot = async (config_snapshot: any, agent = "agent-node:opencode") => report({
    resume_id: "issuer_source", alias: "source", node_id: "n_source", network_id: owner.network_id!,
    status: "idle", agent, session_id: "ses_DiagnosticOnly", config_snapshot });
  const registration = await registerSnapshot(v2Snapshot());
  expect(JSON.parse(registration.content[0].text).error).toBeUndefined();
  const stored = db.get<{ runtime: string }>("SELECT runtime FROM nodes WHERE node_id='n_source'")!;
  expect(stored.runtime).toBe("opencode-sdk");
  expect(inspect()).toMatchObject({ permissions_verified: true });
  const url = new URL("http://isolated.invalid/api/node-session-control/source");
  const transport = createSessionSourceTransport({ enabled: true });
  const post = async (suffix: string, token: string, body: any) => transport(new Request(url + suffix, { method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }), new URL(url + suffix));
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_daemon'", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: {
    source_fork_transport: SOURCE_FORK_CAPABILITY, source_node_delivery: SOURCE_DELIVERY_CAPABILITY } })]);
  db.run("UPDATE sessions SET env_transport='loopback' WHERE node_id='n_daemon'");
  expect((await post("/daemon", daemonToken.token!, { expected: { node_id: "n_daemon", network_id: owner.network_id! },
    capability: SOURCE_FORK_CAPABILITY, instance_id: "11111111-1111-4111-8111-111111111111" }))!.status).toBe(200);
  const input = { network_id: owner.network_id!, source_node_id: "n_source", session_id: "ses_DiagnosticOnly",
    mode: "fork_independent", child_name: "diagnostic-fork", intent_id: "diagnostic-fork" };
  const admitted = await post("", owner.token!, input);
  expect(admitted!.status).toBe(200); expect(await admitted!.json()).toMatchObject({ status: "evidence_pending" });
  for (const config of [{ runtime: "opencode-cli" }, { runtime: "opencode-cli", opencodeGeneration: "v1", opencodeMode: "copresence" },
    { runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "headless" },
    { runtime: "opencode-cli", opencodeGeneration: "v9", opencodeMode: "copresence" },
    { runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "copresence", role: "host_supervisor" }]) {
    await registerSnapshot(buildConfigSnapshot(config, false, 0));
    expect(inspect()).toEqual({ ok: false, error: "source_runtime_unsupported" });
    expect((await post("", owner.token!, input))!.status).toBe(403);
  }
  await registerSnapshot(v2Snapshot(), "agent-node:claude");
  expect(inspect()).toEqual({ ok: false, error: "source_runtime_unsupported" });
  await registerSnapshot(v2Snapshot());
  expect((await post("", bootstrap.token!, input))!.status).toBe(403);
  db.run("UPDATE node_create_requests SET daemon_node_id='other' WHERE request_id='cr_original'");
  expect((await post("", owner.token!, input))!.status).not.toBe(200);
});

test("project-new historical registration is management only, pending/unknown and conflicting daemon refuse", () => {
  db.run("UPDATE node_create_requests SET status='failed' WHERE request_id='cr_original'");
  db.run(`INSERT INTO session_project_creates(request_id,user_id,requester_token_id,network_id,source_node_id,daemon_node_id,
    daemon_token_id,daemon_instance_id,intent_id,selection_scope,snapshot_id,project_id,child_name,accepted_at,expires_at,state,child_node_id)
    VALUES ('issuer_project',?1,?2,?3,'anchor','n_daemon',?4,'instance','issuer_project','scope','snap','project','source',1,2,'delivery_claimed','n_source')`,
    [owner.user!.user_id, owner.token_id!, owner.network_id!, daemonToken.token_id!]);
  expect(inspect()).toEqual({ ok: false, error: "source_daemon_unverified" });
  db.run("UPDATE session_project_creates SET state='registration_confirmed' WHERE request_id='issuer_project'");
  expect(inspect()).toMatchObject({ error: "source_evidence_unavailable", management: "created" });
  db.run("UPDATE node_create_requests SET status='succeeded',daemon_node_id='other' WHERE request_id='cr_original'");
  expect(inspect()).toEqual({ ok: false, error: "source_daemon_mismatch" });
  db.run("UPDATE node_create_requests SET status='failed' WHERE request_id='cr_original'");
  db.run("UPDATE session_project_creates SET state='unknown_rotation_required' WHERE request_id='issuer_project'");
  expect(inspect()).toEqual({ ok: false, error: "source_daemon_unverified" });
});

test("real persisted bearer auth: missing, fabricated, network, expired, revoked and idle tokens refuse", () => {
  const before = counts();
  for (const token of [undefined, "tok_owner_id_is_not_auth", owner.network_token, sourceToken.token]) {
    expect(issuer.issue(request(token), selection)).toEqual({ ok: false, error: "source_auth_required" });
  }
  for (const assignment of ["revoked_at=datetime('now')", "expires_at=datetime('now','-1 minute')",
    "last_used_at=datetime('now','-400 days'),created_at=datetime('now','-400 days')"]) {
    db.run(`UPDATE api_tokens SET ${assignment} WHERE token_id=?1`, [owner.token_id!]);
    expect(inspect()).toEqual({ ok: false, error: "source_auth_required" });
    db.run("UPDATE api_tokens SET revoked_at=NULL,expires_at=NULL,last_used_at=datetime('now') WHERE token_id=?1", [owner.token_id!]);
  }
  expect(counts()).toEqual(before);
});

test("current network membership and source visibility are checked before creation permission", () => {
  expect(issuer.issue(request(bootstrap.token), selection)).toEqual({ ok: false, error: "source_network_forbidden" });
  expect(issuer.issue(request(owner.token), { ...selection, network_id: member.network_id! }))
    .toEqual({ ok: false, error: "source_network_forbidden" });
  expect(issuer.issue(request(member.token), selection)).toEqual({ ok: false, error: "source_read_forbidden" });
  db.run("INSERT INTO network_member_agent_grants (network_id,user_id,node_id,can_message) VALUES (?1,?2,'n_source',0)", [owner.network_id!, member.user!.user_id]);
  expect(issuer.issue(request(member.token), selection)).toEqual({ ok: false, error: "insufficient_role_for_create_node" });
  db.run("UPDATE nodes SET network_id=?1 WHERE node_id='n_source'", [member.network_id!]);
  expect(inspect()).toEqual({ ok: false, error: "source_read_forbidden" });
});

test("create_node role rules recheck demotion and do not infer create permission from source ownership", () => {
  for (const role of ["member", "viewer"]) {
    db.run("UPDATE network_members SET role=?1 WHERE user_id=?2 AND network_id=?3", [role, owner.user!.user_id, owner.network_id!]);
    expect(inspect()).toEqual({ ok: false, error: "insufficient_role_for_create_node" });
  }
  db.run("UPDATE network_members SET role='admin' WHERE user_id=?1 AND network_id=?2", [owner.user!.user_id, owner.network_id!]);
  expect(inspect().error).toBe("source_evidence_unavailable");
  db.run("DELETE FROM network_members WHERE user_id=?1 AND network_id=?2", [owner.user!.user_id, owner.network_id!]);
  expect(inspect()).toEqual({ ok: false, error: "source_network_forbidden" });
  db.run("INSERT INTO network_members (network_id,user_id,role) VALUES (?1,?2,'owner')", [owner.network_id!, owner.user!.user_id]);
});

test("target daemon network/capability and actual managed-source relation are mandatory", () => {
  db.run("UPDATE nodes SET network_id=?1 WHERE node_id='n_daemon'", [member.network_id!]);
  expect(inspect()).toEqual({ ok: false, error: "daemon_not_found" });
  db.run("UPDATE nodes SET network_id=?1,config_snapshot=?2 WHERE node_id='n_daemon'", [owner.network_id!, JSON.stringify({ role: "host_supervisor", daemon_capabilities: { can_create_nodes: false } })]);
  expect(inspect()).toEqual({ ok: false, error: "daemon_cannot_create_nodes" });
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_daemon'", [JSON.stringify({ role: "host_supervisor" })]);
  db.run("UPDATE node_create_requests SET daemon_node_id='other_daemon' WHERE request_id='cr_original'");
  expect(inspect()).toEqual({ ok: false, error: "source_daemon_mismatch" });
  db.run("UPDATE node_create_requests SET status='pending' WHERE request_id='cr_original'");
  expect(inspect()).toEqual({ ok: false, error: "source_daemon_unverified" });
});

test("malformed/ordinary daemon snapshots and non-OpenCode sources are not source authority", () => {
  for (const raw of ["not-json", "[]", "{}", JSON.stringify({ role: "ordinary" }),
    JSON.stringify({ role: "host_supervisor", daemon_capabilities: { runtimes_supported: ["codex-sdk"] } })]) {
    db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_daemon'", [raw]);
    expect(inspect()).toEqual({ ok: false, error: "daemon_cannot_create_nodes" });
  }
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_daemon'", [JSON.stringify({ role: "host_supervisor" })]);
  db.run("UPDATE nodes SET runtime='codex-app-server' WHERE node_id='n_source'");
  expect(inspect()).toEqual({ ok: false, error: "source_runtime_unsupported" });
});

test("acknowledged adoption is a management relation, not canonical-directory or Server authority", () => {
  db.run("UPDATE node_create_requests SET status='failed' WHERE request_id='cr_original'");
  db.run(`INSERT INTO node_daemon_bindings
    (request_id,node_id,network_id,daemon_node_id,workdir,requested_by,status,created_at,updated_at)
    VALUES ('adopt_source','n_source',?1,'n_daemon','http://untrusted.invalid/path',?2,'active',1000,1000)`, [owner.network_id!, owner.user!.user_id]);
  expect(inspect()).toEqual({ ok: false, error: "source_evidence_unavailable", permissions_verified: true,
    management: "adopted", missing: ["server_session_generation", "canonical_directory_ownership"] });
  db.run("UPDATE node_daemon_bindings SET daemon_node_id='other_daemon' WHERE request_id='adopt_source'");
  db.run("UPDATE node_create_requests SET status='succeeded' WHERE request_id='cr_original'");
  expect(inspect()).toEqual({ ok: false, error: "source_daemon_mismatch" });
});

test("freshness uses Hub receipt times and currently valid immutable node credentials", () => {
  for (const offset of ["-5 minutes", "+2 minutes"]) {
    db.run("UPDATE sessions SET last_seen_at=datetime('now',?1) WHERE resume_id='issuer_source'", [offset]);
    expect(inspect()).toEqual({ ok: false, error: "source_evidence_stale" });
  }
  // Within one 3-minute status heartbeat: alive (75 s used to call this stale).
  db.run("UPDATE sessions SET last_seen_at=datetime('now','-2 minutes') WHERE resume_id='issuer_source'");
  expect((inspect() as any).error).not.toBe("source_evidence_stale");
  db.run("UPDATE sessions SET last_seen_at=datetime('now') WHERE resume_id='issuer_source'");
  for (const tokenId of [sourceToken.token_id!, daemonToken.token_id!]) {
    db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", [tokenId]);
    expect(inspect()).toEqual({ ok: false, error: "source_evidence_stale" });
    db.run("UPDATE api_tokens SET revoked_at=NULL WHERE token_id=?1", [tokenId]);
  }
  db.run("UPDATE api_tokens SET expires_at=datetime('now','-1 minute') WHERE token_id=?1", [sourceToken.token_id!]);
  expect(inspect()).toEqual({ ok: false, error: "source_evidence_stale" });
  db.run("UPDATE api_tokens SET expires_at=NULL,bound_node_id=NULL WHERE token_id=?1", [sourceToken.token_id!]);
  expect(inspect()).toEqual({ ok: false, error: "source_evidence_stale" });
});

test("reported binding, directory and URL never become verified proof; issue adds no grant", () => {
  const before = counts();
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_source'", [JSON.stringify({
    ...v2Snapshot(),
    session_id: "ses_Forged", binding_id: "claimed_binding", server_generation: "claimed_generation",
    canonical_directory: "/reported/canonical", server_url: "http://untrusted.invalid" })]);
  for (const mode of ["attach_existing", "fork_independent"] as const) {
    expect(issuer.issue(request(owner.token), { ...selection, mode })).toEqual({ ok: false, error: "source_evidence_unavailable",
      permissions_verified: true, management: "created", missing: ["server_session_generation", "canonical_directory_ownership"] });
  }
  for (const extra of [{ binding: {} }, { canonical_directory: "/client/path" }, { server_url: "http://untrusted.invalid" }, { user_id: owner.user!.user_id }]) {
    expect(issuer.issue(request(owner.token), { ...selection, ...extra })).toEqual({ ok: false, error: "source_selection_invalid" });
  }
  expect(counts()).toEqual(before);
});

test("real revalidation composes with existing admission/store but never consumes an unproven grant", () => {
  // Test-only pre-existing store row, NOT claimed as an issuer-produced proof.
  const store = createSessionSourceGrantStore(db), now = Date.now();
  const ref = store.issue({ ...selection, user_id: owner.user!.user_id, session_id: "ses_Fixture",
    binding_id: "test_only", server_generation: "test_only", canonical_directory: "/test-only" }, now, now + 60_000);
  const before = counts(), callback = issuer.revalidation(request(owner.token), selection);
  expect(() => callback()).toThrow(SourceIssuerError);
  expect(() => issuer.reserve(request(owner.token), selection, ref, "never-launched")).toThrow("source_evidence_unavailable");
  expect(() => issuer.recover(request(owner.token), selection, ref)).toThrow("source_evidence_unavailable");
  db.run("UPDATE network_members SET role='viewer' WHERE user_id=?1 AND network_id=?2", [owner.user!.user_id, owner.network_id!]);
  expect(() => callback()).toThrow("insufficient_role_for_create_node");
  db.run("UPDATE network_members SET role='owner' WHERE user_id=?1 AND network_id=?2", [owner.user!.user_id, owner.network_id!]);
  db.run("UPDATE nodes SET network_id=?1 WHERE node_id='n_source'", [member.network_id!]);
  expect(() => callback()).toThrow("source_read_forbidden");
  db.run("UPDATE nodes SET network_id=?1 WHERE node_id='n_source'", [owner.network_id!]);
  db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", [owner.token_id!]);
  expect(() => callback()).toThrow("source_auth_required");
  expect(counts()).toEqual(before);
  expect(db.get("SELECT state,create_request_id FROM session_source_grants WHERE source_ref=?1", ref))
    .toEqual({ state: "issued", create_request_id: null });
});
