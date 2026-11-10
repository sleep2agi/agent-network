import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { testWorkRoot } from "./test-work-root";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SOURCE_DIRECTORY_CAPABILITY as DIR_CAP } from "../../contracts/session-source-directory";
import { PROJECT_CREATE_ROOT as P, PROJECT_CREATE_CAPABILITY as CAP, SESSION_ATTACH_CAPABILITY as ACAP } from "../../contracts/session-project-create";
import { observeHostSharedServe } from "../../agent-node/src/runtime/opencode-host-shared-observer";
import { createSourceDirectoryReader } from "../../agent-node/src/runtime/session-source-directory";
import { createSessionControlPin } from "../../agent-node/src/runtime/session-control-bridge";
import { createSessionSourceTransportWorker } from "../../agent-node/src/runtime/session-source-transport";

const root = mkdtempSync(join(testWorkRoot(), "project-create-http-")); process.env.COMMHUB_DB ||= join(root, "hub.db");
const gates = ["COMMHUB_SOURCE_DIRECTORY_PREVIEW", "COMMHUB_PROJECT_NEW_SESSION_PREVIEW", "COMMHUB_SESSION_ATTACH_PREVIEW"];
const previous = gates.map(g => process.env[g]);
const D = "/api/node-session-control/source/directory", serverId = `osrv_${randomUUID()}`;
const home = join(root, "home"), daemonDir = join(root, "daemon"), project = join(root, "project");
let db: any, human: any, outsider: any, daemon: any, source: any, net: string, boot: any, hub: any, base: string;
let worker: ReturnType<typeof createSessionSourceTransportWorker>, proxy: ReturnType<typeof Bun.serve>, posts = 0, registrations = 0, serial = 0;
let mode = "ok", nativeCalls: string[] = [], postBodies: any[] = [], fetchOverride: typeof fetch | undefined;
let sessions = new Set<string>(), workerEnabled = true, currentEpoch = 0, cliFixtureRoot: string | null = null;
let nativeLaunchOverride: Parameters<typeof createSessionSourceTransportWorker>[0]["nativeLaunch"];
const native = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(r) {
  const u = new URL(r.url); nativeCalls.push(`${r.method} ${u.pathname}`);
  if (r.headers.get("authorization") !== `Basic ${Buffer.from("opencode:synthetic-project-password").toString("base64")}`) return new Response("", { status: 401 });
  if (u.pathname === "/api/info") return Response.json({ version: "2.0.22", pid: process.pid });
  if (u.pathname === "/api/project") return Response.json([{ id: "prj_Selected", canonical: project, name: "Existing project", sandboxes: [], time: { created: 1, updated: 1, active: 1 } }]);
  if (["/api/provider", "/api/model", "/api/model/default"].includes(u.pathname)) {
    if (r.headers.get("x-opencode-directory") !== project) return new Response("", { status: 400 });
    return Response.json({ location: { directory: project }, data: u.pathname === "/api/provider" ? [{ id: "stub", activation: "enabled" }]
      : u.pathname === "/api/model" ? [{ id: "model", providerID: "stub" }] : mode === "no-default-model" ? null : { id: "model", providerID: "stub" } });
  }
  if (u.pathname === "/api/session/active") return Response.json({ data: {} });
  if (u.pathname === "/api/session" && r.method === "GET") return Response.json({ data: [...sessions].map(id => ({ id, projectID: "prj_Selected", location: { directory: project } })), cursor: {} });
  if (u.pathname === "/api/session" && r.method === "POST") {
    posts++; postBodies.push(await r.json()); const id = `ses_New${serial}_${posts}`.replace(/_/g, "").replace(/^ses/, "ses_"); sessions.add(id);
    if (mode === "lost-create") return new Response("");
    return Response.json({ data: { id, projectID: "prj_Selected", location: { directory: project } } });
  }
  if (u.pathname.startsWith("/api/session/")) {
    const id = u.pathname.slice("/api/session/".length);
    if (!sessions.has(id)) return new Response("", { status: 404 });
    return Response.json({ data: { id, projectID: "prj_Selected", location: { directory: mode === "delegate-foreign-session" ? root : project }, model: { providerID: "stub", id: "model" } } });
  }
  return Response.json({ data: {} });
} });
async function registerChild(token: string, body: any) {
  const { resolveToken } = await import("./auth"), a = resolveToken(token);
  if (!a?.tokenId || mode === "refuse-register") return false;
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js"), { registerTools } = await import("./tools");
  const handlers: Record<string, any> = {}, mcp = new McpServer({ name: "project-registration-fixture", version: "0" }), tool = mcp.tool.bind(mcp);
  (mcp as any).tool = (name: string, desc: string, schema: any, handler: any) => { handlers[name] = handler; return tool(name, desc, schema, handler); };
  registerTools(mcp, undefined, net, a.user.user_id, body.alias, true, a.tokenId);
  try {
    const response = await handlers.report_status({ resume_id: `project_${body.node_id}`, alias: body.alias, node_id: body.node_id,
      session_id: body.session_id, status: "idle", agent: "synthetic-project-child" });
    const ok = JSON.parse(response.content[0].text).ok !== false;
    // Match the fixture receipt clock to Bun's virtual clock in the long-human-
    // selection test. SQLite datetime('now') otherwise uses a different clock.
    if (ok && mode === "virtual-time") db.run("UPDATE sessions SET last_seen_at=?1 WHERE node_id=?2 AND session_id=?3",
      [new Date(Date.now()).toISOString(), body.node_id, body.session_id]);
    if (ok) registrations++; return ok;
  } finally { await mcp.close(); }
}
const api = async (token: string, path: string, value?: any) => {
  const r = await fetch(`${base}${path}`, { method: value === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) }); return { status: r.status, body: await r.json() as any };
};
const poll = (id: string, token = human.token, network = net) => api(token, `${P}/${id}?network_id=${network}`);
const selection = () => ({ network_id: net, source_node_id: "p_source", daemon_node_id: "p_daemon" });
const authorityPath = join(daemonDir, ".anet", "opencode-directory-authorities.json");
function grant(allow = true) { writeFileSync(authorityPath, JSON.stringify({ version: 1, grants: [{ server_id: serverId, network_id: net, source_node_id: "p_source",
  directories: [project], allow_new_session: allow, opencode_unsafe_tools: allow }] }), { mode: 0o600 }); }
function makeWorker() {
  const hubUrl = `http://127.0.0.1:${proxy.port}`;
  return createSessionSourceTransportWorker({ hubUrl, home, daemonWorkDir: daemonDir, directoryEnabled: true, projectEnabled: workerEnabled, attachEnabled: workerEnabled, forkEnabled: false,
    nativeLaunch: nativeLaunchOverride ?? { command: process.execPath, argsPrefix: [join(import.meta.dir, "../../agent-node/src/runtime/fixtures/source-resume-child.ts")],
      env: { HOME: home, PATH: "/usr/local/bin:/usr/bin:/bin", ...(mode === "lost-health" ? { SOURCE_TEST_DROP_HEALTH: "1" } : {}) }, timeoutMs: 1500 },
    pin: createSessionControlPin({ hubUrl, token: daemon.token, nodeId: "p_daemon", networkId: net, epoch: 0, currentEpoch: () => currentEpoch,
      currentToken: () => daemon.token, signal: new AbortController().signal, fetch: (async (...args: any[]) => (fetchOverride ?? fetch)(...args)) as typeof fetch }) });
}
beforeAll(async () => {
  ({ db } = await import("./db")); const { register, createNetworkTokenForNode } = await import("./auth");
  register("project_bootstrap", "Fixture-Project-4150!"); human = register("project_owner", "Fixture-Project-4150!"); outsider = register("project_outsider", "Fixture-Project-4150!");
  net = human.network_id; daemon = createNetworkTokenForNode(human.user.user_id, net, "project-daemon", "p_daemon"); source = createNetworkTokenForNode(human.user.user_id, net, "project-source", "p_source");
  expect(daemon.ok && source.ok).toBe(true);
  db.run("UPDATE nodes SET runtime='opencode-cli',config_snapshot=?1 WHERE node_id='p_source'", [JSON.stringify({ flags: { opencodeGeneration: "v2", opencodeMode: "copresence" } })]);
  db.run("INSERT INTO sessions (resume_id,alias,node_id,network_id,env_transport,last_seen_at) VALUES ('project_daemon','project-daemon','p_daemon',?1,'loopback',datetime('now'))", [net]);
  for (const d of [home, daemonDir, project, join(home, ".anet"), join(daemonDir, ".anet"), join(project, ".anet"), join(project, ".anet", "nodes"), join(project, ".anet", "nodes", "source")]) mkdirSync(d, { mode: 0o700 });
  writeFileSync(join(project, ".anet", "nodes", "source", "opencode-launch-health.json"), JSON.stringify({ generation: "ses_Source", bridge: { pid: process.pid } }), { mode: 0o600 });
  writeFileSync(join(home, ".anet", "password"), "synthetic-project-password", { mode: 0o600 });
  writeFileSync(join(home, ".anet", "opencode-shared-server.json"), JSON.stringify({ url: `http://127.0.0.1:${native.port}`, passwordFile: join(home, ".anet", "password") }), { mode: 0o600 });
  for (const g of gates) process.env[g] = "1"; ({ bootServer: boot } = await import("./server"));
});
beforeEach(() => {
  setSystemTime(); posts = 0; registrations = 0; serial++; mode = "ok"; nativeCalls = []; postBodies = []; sessions = new Set(); fetchOverride = undefined; workerEnabled = true; currentEpoch = 0;
  nativeLaunchOverride = undefined;
  db.run("UPDATE network_members SET role='owner' WHERE user_id=?1 AND network_id=?2", [human.user.user_id, net]);
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='p_daemon'", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { source_directory_read: DIR_CAP, project_new_session: CAP, session_attach: ACAP } })]);
  grant(); hub = boot({ port: 0, hostname: "127.0.0.1" }); base = `http://127.0.0.1:${hub.port}`;
  proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(r) {
    const u = new URL(r.url);
    if (u.pathname === "/fixture-register") {
      const ok = await registerChild(r.headers.get("authorization")?.replace(/^Bearer /, "") ?? "", await r.json()); return Response.json({ ok }, { status: ok ? 200 : 403 });
    }
    return fetch(`${base}${u.pathname}${u.search}`, { method: r.method, headers: r.headers, ...(r.method === "GET" ? {} : { body: await r.text() }), redirect: "error" });
  } }); worker = makeWorker();
});
afterEach(async () => { setSystemTime(); await worker.stop(); proxy.stop(true); hub.stop(true); if (cliFixtureRoot) { rmSync(cliFixtureRoot, { recursive: true, force: true }); cliFixtureRoot = null; } });
afterAll(() => { native.stop(true); db.close(); rmSync(root, { recursive: true, force: true }); gates.forEach((g, i) => { if (previous[i] === undefined) delete process.env[g]; else process.env[g] = previous[i]; }); });
async function directory() {
  await worker.tick(); const q = await api(human.token, D, selection()); expect(q.status).toBe(200); await worker.tick();
  const first = (await api(human.token, `${D}/${q.body.request_id}?network_id=${net}`)).body;
  const q2 = await api(human.token, D, { ...selection(), server_id: serverId, selection_scope: first.request_id }); expect(q2.status).toBe(200); await worker.tick();
  const s = (await api(human.token, `${D}/${q2.body.request_id}?network_id=${net}`)).body; expect(s.status).toBe("ready"); expect(s.snapshot.projects).toHaveLength(1); return s;
}
const value = (s: any, intent = `new-${serial}`) => ({ selection_scope: s.request_id, snapshot_id: s.snapshot.snapshot_id,
  project_id: s.snapshot.projects[0].project_id, child_name: `project-child-${serial}`, intent_id: intent });
function delegateGrant(override = {}) {
  writeFileSync(authorityPath, JSON.stringify({ version: 1, grants: [{ server_id: serverId, network_id: net, source_node_id: "p_source",
    directories: [project], opencode_unsafe_tools: true, allow_attach_existing: { enabled: true, policy_id: randomUUID(), daemon_id: "p_daemon",
      directories: [project], expires_at: Date.now() + 86400000, grant_ttl_ms: 120000, ...override } }] }), { mode: 0o600 });
}
test("delegated existing-directory policy derives exact one-shot grant from real GET/OS pin, concurrent children share one bridge, unknown never regenerates", async () => {
  const id = `ses_Delegate${serial}`; sessions.add(id); delegateGrant(); const s = await directory();
  const value = (n: number) => ({ selection_scope: s.request_id, snapshot_id: s.snapshot.snapshot_id, session_id: s.snapshot.sessions[0].session_id,
    child_name: `delegated-${serial}-${n}`, intent_id: `delegated-${serial}-${n}` });
  const [a, b] = await Promise.all([api(human.token, P, value(1)), api(human.token, P, value(2))]); expect(a.status).toBe(200); expect(b.status).toBe(200);
  const tokensBefore = db.get("SELECT COUNT(*) n FROM api_tokens").n; await worker.tick();
  const receipts = await Promise.all([poll(a.body.request_id), poll(b.body.request_id)]);
  expect(receipts.map(r => r.body.status).sort()).toEqual(["registration_confirmed", "unknown_rotation_required"]);
  expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(tokensBefore + 1); expect(registrations).toBe(1);
  const dir = join(project, ".anet", "session-attach-grants"), paths = readdirSync(dir);
  const records = paths.map(p => readFileSync(join(dir, p), "utf8")).filter(t => JSON.parse(t).derived_grant?.intent_id?.startsWith(`delegated-${serial}-`));
  expect(records).toHaveLength(2);
  for (const text of records) { const c = JSON.parse(text), row = db.get("SELECT * FROM session_project_creates WHERE request_id=?1", c.request_id);
    expect(c.session_id).toBe(id); expect(c.derived_grant.server_pid).toBe(process.pid); expect(c.derived_grant.expires_at).toBe(row.accepted_at + 120000);
    expect(c.derived_grant.intent_id).toBe(row.intent_id); expect(text).not.toContain("synthetic-project-password"); }
  await worker.tick(); for (const n of [1, 2]) expect((await api(human.token, P, value(n))).body.request_id).toBe([a, b][n - 1].body.request_id);
  expect(readdirSync(dir)).toEqual(paths); expect(registrations).toBe(1); expect(nativeCalls.filter(x => x.startsWith("POST "))).toEqual([]);
  const accepted = db.get("SELECT accepted_at FROM session_project_creates WHERE request_id=?1", a.body.request_id).accepted_at;
  setSystemTime(accepted + 120001); await worker.tick();
  expect(readdirSync(dir)).toEqual(paths); expect(registrations).toBe(1); expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(tokensBefore + 1);
}, 15000);
for (const invalid of ["disabled", "expired", "wrong-daemon", "out-of-scope-directory", "unbounded-ttl", "foreign-native-session"]) test(`delegated policy ${invalid} cannot authorize or enlarge scope`, async () => {
  const id = `ses_BadDelegate${serial}`; sessions.add(id);
  delegateGrant(invalid === "disabled" ? { enabled: false } : invalid === "expired" ? { expires_at: Date.now() - 1 }
    : invalid === "wrong-daemon" ? { daemon_id: "other" } : invalid === "out-of-scope-directory" ? { directories: [root] }
    : invalid === "unbounded-ttl" ? { grant_ttl_ms: 300001 } : {});
  const s = await directory(); if (invalid === "foreign-native-session") mode = "delegate-foreign-session";
  const tokens = db.get("SELECT COUNT(*) n FROM api_tokens").n, q = await api(human.token, P, { selection_scope: s.request_id,
    snapshot_id: s.snapshot.snapshot_id, session_id: s.snapshot.sessions[0].session_id, child_name: `bad-delegate-${serial}`, intent_id: `bad-delegate-${serial}` });
  await worker.tick(); expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required");
  expect(registrations).toBe(0); expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(tokens); expect(nativeCalls.filter(x => x.startsWith("POST "))).toEqual([]);
});
for (const permission of ["read_only", "new_only"]) test(`${permission} private directory permission cannot implicitly delegate attach`, async () => {
  sessions.add(`ses_NoDelegate${serial}`);
  writeFileSync(authorityPath, JSON.stringify({ version: 1, grants: [{ server_id: serverId, network_id: net, source_node_id: "p_source",
    directories: [project], opencode_unsafe_tools: true, ...(permission === "new_only" ? { allow_new_session: true } : {}) }] }), { mode: 0o600 });
  const s = await directory(), tokens = db.get("SELECT COUNT(*) n FROM api_tokens").n;
  const value = { selection_scope: s.request_id, snapshot_id: s.snapshot.snapshot_id, session_id: s.snapshot.sessions[0].session_id,
    child_name: `not-delegated-${serial}`, intent_id: `not-delegated-${serial}` };
  expect((await api(human.token, P, { ...value, allow_attach_existing: { enabled: true } })).status).toBe(400);
  const q = await api(human.token, P, value); await worker.tick();
  expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required"); expect(registrations).toBe(0);
  expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(tokens); expect(nativeCalls.filter(x => x.startsWith("POST "))).toEqual([]);
});
function attachGrant(id: string, override = {}) {
  const observed = observeHostSharedServe(`http://127.0.0.1:${native.port}`);
  expect(observed.ok).toBe(true); if (!observed.ok) throw Error("fixture_observation_failed");
  writeFileSync(authorityPath, JSON.stringify({ version: 1, grants: [{ server_id: serverId, network_id: net, source_node_id: "p_source",
    directories: [project], opencode_unsafe_tools: true, attach_sessions: [{ grant_id: randomUUID(), daemon_id: "p_daemon", directory: project,
      session_id: id, server_pid: observed.processEvidence.pid, server_start_ticks: observed.processEvidence.startTicks, expires_at: Date.now() + 120000, ...override }] }] }), { mode: 0o600 });
}
test("HTTP attach five-field opaque intent -> existing exact child registration; zero native writes and single mint/launch", async () => {
  const id = `ses_Attach${serial}`; sessions.add(id); attachGrant(id);
  const s = await directory(), v = { selection_scope: s.request_id, snapshot_id: s.snapshot.snapshot_id,
    session_id: s.snapshot.sessions[0].session_id, child_name: `attach-child-${serial}`, intent_id: `attach-${serial}` };
  const q = await api(human.token, P, v); expect(q.status).toBe(200); expect(q.body.session_creation).toBe("not_performed");
  expect(q.body.operation_kind).toBe("attach_existing_session"); await worker.tick();
  expect((await poll(q.body.request_id)).body.status).toBe("registration_confirmed");
  expect(registrations).toBe(1); const count = db.get("SELECT COUNT(*) n FROM api_tokens").n;
  expect((await api(human.token, P, v)).body.request_id).toBe(q.body.request_id); await worker.tick();
  expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(count); expect(registrations).toBe(1);
  expect(nativeCalls.filter(x => x.startsWith("POST "))).toEqual([]);
  const row = db.get("SELECT * FROM session_project_creates WHERE request_id=?1", q.body.request_id);
  expect(row.session_id).toBe(id); expect(row.selected_session_id).toBe(v.session_id); expect(row.project_id).toStartWith("oprj_");
  expect((await api(outsider.token, P, v)).status).toBe(403);
  expect((await api(human.token, P, { ...v, session_id: id })).status).toBe(400);
  expect((await api(human.token, P, { ...v, project_id: row.project_id })).status).toBe(400);
  const copiedDaemon = join(root, `copied-daemon-${serial}`); mkdirSync(copiedDaemon, { mode: 0o700 }); mkdirSync(join(copiedDaemon, ".anet"), { mode: 0o700 });
  writeFileSync(join(copiedDaemon, ".anet", "opencode-directory-authorities.json"), readFileSync(authorityPath), { mode: 0o600 });
  const copiedReader = createSourceDirectoryReader({ home, daemonWorkDir: copiedDaemon, networkId: net, daemonId: "p_daemon", attachSelectionEnabled: true });
  const readTask = { request_id: `srcdir_${randomUUID()}`, network_id: net, source_node_id: "p_source", daemon_node_id: "p_daemon", server_id: serverId, expires_at: Date.now() + 30000 };
  const copiedSnapshot = await copiedReader.read(readTask), accepted = Date.now();
  await expect(copiedReader.selectProject({ request_id: `prjc_${randomUUID()}`, network_id: net, source_node_id: "p_source", daemon_node_id: "p_daemon",
    operation_kind: "attach_existing_session", selection_scope: readTask.request_id, snapshot_id: copiedSnapshot.snapshot_id,
    project_id: copiedSnapshot.projects[0].project_id, selected_session_id: copiedSnapshot.sessions[0].session_id,
    child_name: "copied-grant-child", intent_id: "copied-grant", accepted_at: accepted, expires_at: accepted + 300000 })).rejects.toThrow("project_attach_grant_consumed");
}, 15000);
test("read/new-session grant cannot authorize attach; consumed exact grant cannot assign another child; occupied legacy bridge refuses", async () => {
  const id = `ses_Denied${serial}`; sessions.add(id);
  const submit = async (suffix: string) => { const s = await directory(); return api(human.token, P, { selection_scope: s.request_id,
    snapshot_id: s.snapshot.snapshot_id, session_id: s.snapshot.sessions[0].session_id, child_name: `denied-${serial}-${suffix}`, intent_id: `deny-${serial}-${suffix}` }); };
  let q = await submit("read"); await worker.tick(); expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required");
  attachGrant(id); q = await submit("first"); await worker.tick(); expect((await poll(q.body.request_id)).body.status).toBe("registration_confirmed");
  q = await submit("second"); await worker.tick(); expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required");
  sessions.clear(); sessions.add("ses_Source"); attachGrant("ses_Source");
  q = await submit("occupied"); await worker.tick(); expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required");
  expect(nativeCalls.filter(x => x.startsWith("POST "))).toEqual([]); expect(registrations).toBe(1);
}, 15000);
for (const invalid of ["expired", "wrong-daemon", "wrong-incarnation", "wrong-directory"]) test(`HTTP attach ${invalid} finite grant refuses before mint/launch, zero native writes`, async () => {
  const id = `ses_Grant${serial}`; sessions.add(id);
  attachGrant(id, invalid === "expired" ? { expires_at: Date.now() - 1 } : invalid === "wrong-daemon" ? { daemon_id: "other" }
    : invalid === "wrong-incarnation" ? { server_start_ticks: -1 } : { directory: root });
  const s = await directory(), v = { selection_scope: s.request_id, snapshot_id: s.snapshot.snapshot_id, session_id: s.snapshot.sessions[0].session_id,
    child_name: `bad-grant-${serial}`, intent_id: `bad-grant-${serial}` };
  const tokens = db.get("SELECT COUNT(*) n FROM api_tokens").n, q = await api(human.token, P, v); expect(q.status).toBe(200);
  await worker.tick(); expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required");
  expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(tokens); expect(registrations).toBe(0); expect(nativeCalls.filter(x => x.startsWith("POST "))).toEqual([]);
});
test("HTTP attach default gate, strict fields, current create/visibility and daemon declaration fail closed", async () => {
  const id = `ses_Permissions${serial}`; sessions.add(id); attachGrant(id); const s = await directory();
  const v = { selection_scope: s.request_id, snapshot_id: s.snapshot.snapshot_id, session_id: s.snapshot.sessions[0].session_id, child_name: `permission-${serial}`, intent_id: `permission-${serial}` };
  for (const token of [daemon.token, source.token, outsider.token]) expect((await api(token, P, v)).status).not.toBe(200);
  for (const extra of [{ session_id: id }, { path: project }, { token: "fake" }, { url: "http://127.0.0.1:1" }, { daemon_node_id: "p_daemon" }, { session_id: `oses_${randomUUID()}` }])
    expect((await api(human.token, P, { ...v, ...extra })).status).not.toBe(200);
  db.run("UPDATE network_members SET role='viewer' WHERE user_id=?1 AND network_id=?2", [human.user.user_id, net]);
  expect((await api(human.token, P, v)).status).toBe(403);
  db.run("UPDATE network_members SET role='owner' WHERE user_id=?1 AND network_id=?2", [human.user.user_id, net]);
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='p_daemon'", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { source_directory_read: DIR_CAP, project_new_session: CAP } })]);
  expect((await api(human.token, P, v)).status).toBe(403);
  delete process.env.COMMHUB_SESSION_ATTACH_PREVIEW; const gated = boot({ hostname: "127.0.0.1", port: 0 });
  try { expect((await fetch(`http://127.0.0.1:${gated.port}${P}`, { method: "POST", headers: { authorization: `Bearer ${human.token}`, "content-type": "application/json" }, body: JSON.stringify(v) })).status).toBe(404); }
  finally { gated.stop(true); process.env.COMMHUB_SESSION_ATTACH_PREVIEW = "1"; }
  expect(nativeCalls.filter(x => x.startsWith("POST "))).toEqual([]);
});
for (const delegated of [false, true]) test(`HTTP ${delegated ? "delegated" : "manual"} attach lost one-shot delivery + worker/Hub reconstruction stays unknown, no remint/relaunch or native mutation`, async () => {
  const id = `ses_Lost${serial}`; sessions.add(id); if (delegated) delegateGrant(); else attachGrant(id); const s = await directory();
  const v = { selection_scope: s.request_id, snapshot_id: s.snapshot.snapshot_id, session_id: s.snapshot.sessions[0].session_id, child_name: `lost-attach-${serial}`, intent_id: `lost-attach-${serial}` };
  const q = await api(human.token, P, v); let dropped = false;
  fetchOverride = (async (input: any, init: any) => { const response = await fetch(input, init);
    if (!dropped && String(input).endsWith(`${P}/pull`) && (await response.clone().json()).task?.phase === "deliver") { dropped = true; throw Error("synthetic_attach_delivery_lost"); } return response; }) as typeof fetch;
  await expect(worker.tick()).rejects.toThrow(); const count = db.get("SELECT COUNT(*) n FROM api_tokens").n;
  const grantDir = join(project, ".anet", "session-attach-grants"), grantFiles = readdirSync(grantDir);
  await worker.stop(); worker = makeWorker(); hub.stop(true); hub = boot({ hostname: "127.0.0.1", port: 0 }); base = `http://127.0.0.1:${hub.port}`;
  expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required"); expect((await api(human.token, P, v)).body.request_id).toBe(q.body.request_id);
  await worker.tick(); expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(count); expect(registrations).toBe(0); expect(nativeCalls.filter(x => x.startsWith("POST "))).toEqual([]);
  expect(readdirSync(grantDir)).toEqual(grantFiles);
});
test("actual HTTP directory -> project intent -> one native empty create -> exact shared resume child -> real registration confirmation; same intent stays single", async () => {
  const s = await directory(), v = value(s), q = await api(human.token, P, v); expect(q.status).toBe(200);
  expect((await api(human.token, P, v)).body.request_id).toBe(q.body.request_id);
  await worker.tick(); const r = await poll(q.body.request_id); expect(r.body.status).toBe("registration_confirmed");
  expect(r.body.registration_is_health).toBe(false); expect(r.body.native_acceptance).toBe("not_verified"); expect(posts).toBe(1); expect(registrations).toBe(1);
  expect(postBodies).toEqual([{ location: { directory: project } }]);
  expect(nativeCalls.filter(x => x.startsWith("POST "))).toEqual(["POST /api/session"]);
  expect((await api(human.token, P, v)).body.request_id).toBe(q.body.request_id); await worker.tick(); expect(posts).toBe(1);
  const row = db.get("SELECT * FROM session_project_creates WHERE request_id=?1", q.body.request_id);
  const config = JSON.parse(readFileSync(join(project, ".anet", "nodes", v.child_name, "config.json"), "utf8"));
  expect(config.sessionId).toBe(row.session_id); expect(config.sourceDelivery.operation_kind).toBe("project_new_session");
  expect(db.get("SELECT expires_at FROM api_tokens WHERE token_id=?1", row.child_token_id).expires_at).toBeNull();
  expect(JSON.stringify(row)).not.toContain(config.token); expect(JSON.stringify(r.body)).not.toContain("ses_"); expect(JSON.stringify(r.body)).not.toContain(project);
  const health = JSON.parse(readFileSync(join(project, ".anet", "nodes", v.child_name, "source-resume-health.json"), "utf8"));
  await worker.stop(); expect(() => process.kill(health.pid, 0)).toThrow(); expect(() => process.kill(process.pid, 0)).not.toThrow();
  expect(JSON.parse(readFileSync(join(project, ".anet", "nodes", "source", "opencode-launch-health.json"), "utf8")).generation).toBe("ses_Source");
  expect((await poll(q.body.request_id)).body.status).toBe("registration_confirmed"); // receipt, NOT ongoing online
}, 15000);
for (const operation of ["new", "manual", "delegated"]) test(`${operation} HTTP chain uses actual anet CLI -> paired agent-node CLI -> exact shared resume -> actual Hub registration with synthetic native package`, async () => {
  const attach = operation !== "new";
  await worker.stop(); const prefix = mkdtempSync(join(testWorkRoot(), "project-cli-fixture-")); cliFixtureRoot = prefix;
  const pkg = join(prefix, "node_modules", "@opencode", "cli"); mkdirSync(join(pkg, "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(join(prefix, "bin"), { mode: 0o700 }); mkdirSync(join(prefix, "safe"), { mode: 0o700 });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@opencode/cli", version: "2.0.22", bin: { opencode: "bin/opencode.exe" } }));
  writeFileSync(join(pkg, "bin", "opencode.exe"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'opencode v2.0.22'; exit 0; fi\nexit 77\n", { mode: 0o700 });
  symlinkSync(join(pkg, "bin", "opencode.exe"), join(prefix, "bin", "opencode"));
  const nodePackage = join(prefix, "node_modules", "@sleep2agi", "agent-node"); mkdirSync(nodePackage, { recursive: true, mode: 0o700 });
  writeFileSync(join(nodePackage, "package.json"), readFileSync(join(import.meta.dir, "../../agent-node/package.json")));
  for (const dep of ["@anthropic-ai", "@openai", "node-pty"]) symlinkSync(join(import.meta.dir, "../../agent-node/node_modules", dep), join(prefix, "node_modules", dep));
  const dist = join(nodePackage, "dist"), built = await Bun.build({ entrypoints: [join(import.meta.dir, "../../agent-node/src/cli.ts")], outdir: dist, target: "bun",
    external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "node-pty"] }); expect(built.success).toBe(true);
  nativeLaunchOverride = { command: process.execPath, argsPrefix: [join(import.meta.dir, "../../agent-network/bin/cli.ts")],
    env: { PATH: `${join(prefix, "bin")}:/usr/local/bin:/usr/bin:/bin`, HOME: home, ANET_AGENT_NODE_BIN: join(dist, "cli.js"), ANET_OPENCODE_SAFE_BASE: join(prefix, "safe") }, timeoutMs: 7000 };
  const existing = `ses_ActualAttach${serial}`;
  if (attach) { sessions.add(existing); if (operation === "delegated") delegateGrant(); else attachGrant(existing); }
  worker = makeWorker(); const s = await directory(), v = attach ? { selection_scope: s.request_id, snapshot_id: s.snapshot.snapshot_id,
    session_id: s.snapshot.sessions[0].session_id, child_name: `actual-attach-${serial}`, intent_id: `actual-attach-${serial}` } : value(s);
  const q = await api(human.token, P, v); expect(q.status).toBe(200);
  await worker.tick(); const r = await poll(q.body.request_id); expect(r.body.status).toBe("registration_confirmed"); expect(posts).toBe(attach ? 0 : 1);
  const row = db.get("SELECT * FROM session_project_creates WHERE request_id=?1", q.body.request_id);
  expect(db.get("SELECT session_id FROM sessions WHERE node_id=?1 ORDER BY last_seen_at DESC LIMIT 1", row.child_node_id).session_id).toBe(row.session_id);
  expect(nativeCalls.filter(x => x.startsWith("POST "))).toEqual(attach ? [] : ["POST /api/session"]);
  if (attach) {
    expect(row.session_id).toBe(existing); const count = db.get("SELECT COUNT(*) n FROM api_tokens").n;
    expect((await api(human.token, P, v)).body.request_id).toBe(q.body.request_id); await worker.tick();
    expect(db.get("SELECT COUNT(*) n FROM api_tokens").n).toBe(count);
    const healthPath = join(project, ".anet", "nodes", v.child_name, "source-resume-health.json");
    const h = JSON.parse(readFileSync(healthPath, "utf8")); expect(h.session_id).toBe(existing);
    await worker.stop(); expect(() => process.kill(h.pid, 0)).toThrow(); expect(sessions.has(existing)).toBe(true);
  }
}, 20000);
test("HTTP raw inputs, foreign caller/network, wrong snapshot/project/daemon, node caller, intent conflict and stale selection fail closed", async () => {
  const s = await directory(), v = value(s);
  for (const token of [daemon.token, source.token, outsider.token]) expect((await api(token, P, v)).status).not.toBe(200);
  for (const extra of [{ path: project }, { url: "http://127.0.0.1:1" }, { token: "forged" }, { network_id: "other" }, { daemon_node_id: "p_source" },
    { snapshot_id: `snap_${randomUUID()}` }, { project_id: `oprj_${randomUUID()}` }, { project_id: `oses_${randomUUID()}` }, { selection_scope: `srcdir_${randomUUID()}` }]) {
    expect((await api(human.token, P, { ...v, ...extra })).status).not.toBe(200);
  }
  const q = await api(human.token, P, v); expect(q.status).toBe(200);
  expect((await api(human.token, P, { ...v, child_name: "different" })).status).not.toBe(200);
  expect((await poll(q.body.request_id, outsider.token)).status).toBe(403); expect((await poll(q.body.request_id, human.token, "other")).status).toBe(403);
  db.run("UPDATE nodes SET config_snapshot='{}' WHERE node_id='p_daemon'");
  expect((await api(human.token, P, { ...v, intent_id: "wrong-daemon" })).status).toBe(403); expect(posts).toBe(0);
});
test("project selection remains usable for ten minutes, not thirty seconds; accepted operation has its own five-minute deadline", async () => {
  const s = await directory(), v = value(s), at = s.expires_at + 120000; setSystemTime(at);
  // Refresh the SAME process declaration; no native writes or user re-selection.
  await worker.tick(); expect((await api(human.token, `${D}/${s.request_id}?network_id=${net}`)).status).toBe(403);
  const q = await api(human.token, P, v); expect(q.status).toBe(200); expect(q.body.accepted_at).toBe(at); expect(q.body.expires_at).toBe(at + 300000);
  setSystemTime(s.snapshot.selection_expires_at + 1); await worker.tick();
  expect((await api(human.token, P, { ...v, intent_id: "expired-new" })).status).toBe(403);
  expect((await api(human.token, P, v)).body.request_id).toBe(q.body.request_id);
  expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required"); expect(posts).toBe(0);
});
test("lost native create response persists unknown; same intent, worker reconstruction and Hub reconstruction never POST or mint again", async () => {
  const s = await directory(), v = value(s), q = await api(human.token, P, v); mode = "lost-create";
  const tokensBefore = db.get("SELECT count(*) n FROM api_tokens").n;
  await worker.tick(); expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required"); expect(posts).toBe(1);
  expect((await poll(q.body.request_id)).body.session_creation).toBe("unknown");
  expect(db.get("SELECT count(*) n FROM api_tokens").n).toBe(tokensBefore);
  expect((await api(human.token, P, v)).body.status).toBe("unknown_rotation_required");
  await worker.stop(); worker = makeWorker(); await worker.tick(); hub.stop(true); hub = boot({ port: 0, hostname: "127.0.0.1" }); base = `http://127.0.0.1:${hub.port}`;
  expect((await api(human.token, P, v)).body.status).toBe("unknown_rotation_required"); await worker.tick(); expect(posts).toBe(1);
  expect(db.get("SELECT count(*) n FROM api_tokens").n).toBe(tokensBefore);
});
test("accepted near ten-minute selection deadline finishes after selection/read expiry under a separate workflow deadline", async () => {
  const s = await directory(), v = value(s); mode = "virtual-time";
  setSystemTime(s.snapshot.selection_expires_at - 1000); await worker.tick();
  const q = await api(human.token, P, v); expect(q.status).toBe(200);
  setSystemTime(s.snapshot.selection_expires_at + 60000); await worker.tick();
  const r = await poll(q.body.request_id); expect(r.body.status).toBe("registration_confirmed"); expect(posts).toBe(1); expect(registrations).toBe(1);
  expect((await api(human.token, P, v)).body.request_id).toBe(q.body.request_id);
}, 15000);
test("lost create ACK body can only continue original delivery, never POST or mint twice", async () => {
  const s = await directory(), v = value(s), q = await api(human.token, P, v); let dropped = false;
  fetchOverride = (async (input: any, init: any) => {
    const response = await fetch(input, init);
    if (!dropped && String(input).endsWith(`${P}/ack`) && JSON.parse(init.body).result.status === "session_ready") { dropped = true; throw Error("synthetic_ack_lost"); }
    return response;
  }) as typeof fetch;
  await expect(worker.tick()).rejects.toThrow(); expect(posts).toBe(1); const tokens = db.get("SELECT count(*) n FROM api_tokens").n;
  expect((await api(human.token, P, v)).body.status).toBe("delivery_pending"); await worker.tick();
  expect((await poll(q.body.request_id)).body.status).toBe("registration_confirmed"); expect(posts).toBe(1); expect(db.get("SELECT count(*) n FROM api_tokens").n).toBe(tokens);
}, 15000);
test("missing native project default model fails before Session POST or credential mint, never guesses a model", async () => {
  const s = await directory(), q = await api(human.token, P, value(s)); mode = "no-default-model";
  const tokens = db.get("SELECT count(*) n FROM api_tokens").n; await worker.tick();
  expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required"); expect(posts).toBe(0); expect(registrations).toBe(0);
  expect(db.get("SELECT count(*) n FROM api_tokens").n).toBe(tokens);
});
test("lost one-shot delivery and Hub reconstruction revoke unknown credential, not remint/relaunch", async () => {
  const s = await directory(), v = value(s), q = await api(human.token, P, v); let dropped = false;
  fetchOverride = (async (input: any, init: any) => {
    const response = await fetch(input, init);
    if (!dropped && String(input).endsWith(`${P}/pull`)) { const body = await response.clone().json(); if (body.task?.phase === "deliver") { dropped = true; throw Error("synthetic_delivery_lost"); } }
    return response;
  }) as typeof fetch;
  await expect(worker.tick()).rejects.toThrow(); expect(posts).toBe(1); const tokens = db.get("SELECT count(*) n FROM api_tokens").n;
  hub.stop(true); hub = boot({ port: 0, hostname: "127.0.0.1" }); base = `http://127.0.0.1:${hub.port}`;
  const r = await poll(q.body.request_id); expect(r.body.status).toBe("unknown_rotation_required");
  const row = db.get("SELECT * FROM session_project_creates WHERE request_id=?1", q.body.request_id); expect(db.get("SELECT revoked_at FROM api_tokens WHERE token_id=?1", row.child_token_id).revoked_at).not.toBeNull();
  await worker.tick(); expect(posts).toBe(1); expect(registrations).toBe(0); expect(db.get("SELECT count(*) n FROM api_tokens").n).toBe(tokens);
});
for (const invalid of ["revoked", "expired"]) test(`${invalid} initial child credential cannot launch, remint or recreate`, async () => {
  const s = await directory(), v = value(s), q = await api(human.token, P, v); let held = false;
  fetchOverride = (async (input: any, init: any) => {
    const response = await fetch(input, init);
    if (!held && String(input).endsWith(`${P}/ack`) && JSON.parse(init.body).result.status === "session_ready") { held = true; throw Error("synthetic_hold_after_create"); }
    return response;
  }) as typeof fetch;
  await expect(worker.tick()).rejects.toThrow(); const row = db.get("SELECT * FROM session_project_creates WHERE request_id=?1", q.body.request_id);
  const tokens = db.get("SELECT count(*) n FROM api_tokens").n;
  if (invalid === "revoked") db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", [row.child_token_id]);
  else setSystemTime(row.credential_expires_at + 1);
  await worker.tick(); expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required"); expect(registrations).toBe(0);
  expect(posts).toBe(1); expect(db.get("SELECT count(*) n FROM api_tokens").n).toBe(tokens);
});
test("directory/read capability alone, absent local write policy, demotion, wrong-daemon ACK and default gate cannot create", async () => {
  workerEnabled = false; await worker.stop(); worker = makeWorker(); const s = await directory(), v = value(s);
  expect((await api(human.token, P, v)).status).toBe(403);
  workerEnabled = true; await worker.stop(); worker = makeWorker(); const s2 = await directory(), v2 = value(s2); grant(false);
  const q = await api(human.token, P, v2); expect(q.status).toBe(200); await worker.tick(); expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required"); expect(posts).toBe(0);
  grant(); const s3 = await directory(), q3 = await api(human.token, P, { ...value(s3), intent_id: "demoted", child_name: `demoted-${serial}` });
  expect(q3.status).toBe(200); db.run("UPDATE network_members SET role='viewer' WHERE user_id=?1 AND network_id=?2", [human.user.user_id, net]);
  expect((await poll(q3.body.request_id)).status).toBe(403); await worker.tick(); expect(posts).toBe(0);
  expect((await api(source.token, `${P}/ack`, { expected: { node_id: "p_daemon", network_id: net }, instance_id: randomUUID(), capability: CAP,
    request_id: q3.body.request_id, result: { status: "session_ready", session_id: "ses_Forged" } })).status).toBe(403);
  delete process.env.COMMHUB_PROJECT_NEW_SESSION_PREVIEW; const gated = boot({ port: 0, hostname: "127.0.0.1" });
  try { const response = await fetch(`http://127.0.0.1:${gated.port}${P}`, { method: "POST", headers: { authorization: `Bearer ${human.token}` }, body: "{}" }); expect(response.status).toBe(404); }
  finally { gated.stop(true); process.env.COMMHUB_PROJECT_NEW_SESSION_PREVIEW = "1"; }
});
test("failed child registration stops only new child; no Session DELETE, source stop or ordinary fallback", async () => {
  const s = await directory(), q = await api(human.token, P, value(s)); mode = "refuse-register";
  await worker.tick(); expect((await poll(q.body.request_id)).body.status).toBe("unknown_rotation_required"); expect(posts).toBe(1); expect(registrations).toBe(0);
  expect(nativeCalls.filter(x => !x.startsWith("GET ") && x !== "POST /api/session")).toEqual([]);
  expect(() => process.kill(process.pid, 0)).not.toThrow(); expect(sessions.size).toBe(1);
}, 15000);
