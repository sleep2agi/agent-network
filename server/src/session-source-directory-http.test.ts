import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { SOURCE_DIRECTORY_CAPABILITY as CAP } from "../../contracts/session-source-directory";
import { createSessionControlPin } from "../../agent-node/src/runtime/session-control-bridge";
import { createSessionSourceTransportWorker } from "../../agent-node/src/runtime/session-source-transport";

const root = mkdtempSync(join(tmpdir(), "source-directory-http-"));
process.env.COMMHUB_DB ||= join(root, "hub.db");
const previousGate = process.env.COMMHUB_SOURCE_DIRECTORY_PREVIEW;
let db: any, human: any, outsider: any, daemon: any, source: any, hub: any, boot: any, net: string;
let base: string, worker: ReturnType<typeof createSessionSourceTransportWorker>, epoch = 0;
const home = join(root, "home"), daemonDir = join(root, "daemon"), project = join(root, "project");
const authority = join(daemonDir, ".anet", "opencode-directory-authorities.json"), serverId = `osrv_${randomUUID()}`;
const ROOT = "/api/node-session-control/source/directory";
let mode = "ok", calls: string[] = [];
const native = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
  const u = new URL(req.url); calls.push(`${req.method} ${u.pathname}${u.search}`);
  if (mode !== "no-auth" && req.headers.get("authorization") !== `Basic ${Buffer.from("opencode:synthetic-directory-password").toString("base64")}`) return new Response("", { status: 401 });
  if (mode === "down") return new Response("", { status: 503 });
  if (mode === "redirect") return new Response("", { status: 302, headers: { location: "http://foreign.invalid" } });
  if (mode === "large") return new Response("x".repeat(270000));
  if (u.pathname === "/api/info") return Response.json({ version: mode === "wrong-version" ? "2.0.23" : "2.0.22", pid: process.pid });
  if (u.pathname === "/api/project") return mode === "malformed-project" ? Response.json([{}]) : Response.json([{ id: "prj_fixture", canonical: project, name: mode === "secret-title" ? "/private/token" : "Fixture project",
    sandboxes: [], time: { created: 1, updated: 1, active: 1 } }, { id: "prj_not_allowed", canonical: "/unauthorized", name: "Not visible" }]);
  if (u.pathname === "/api/session/active") return Response.json({ data: { ses_Running: { type: "running" } } });
  if (u.pathname === "/api/session") {
    if (u.searchParams.get("directory") !== project || u.searchParams.get("project") !== "prj_fixture") return new Response("", { status: 400 });
    if (u.searchParams.has("cursor")) return Response.json({ data: [], cursor: { previous: null, next: null } });
    const data = ["ses_Running", "ses_UnboundCandidate"].map(id => ({ id, projectID: "prj_fixture", location: { directory: mode === "wrong-directory" ? "/unauthorized" : project },
      title: mode === "secret-title" ? "Bearer synthetic-secret" : id === "ses_Running" ? "Busy task" : "Existing candidate" }));
    return Response.json({ data: mode === "too-many" ? Array.from({ length: 101 }, (_, i) => ({ ...data[0], id: `ses_${i}` })) : data,
      cursor: { previous: "native-private-cursor-previous", next: "native-private-cursor-next" } });
  }
  return new Response("", { status: 404 });
} });
const api = async (token: string, path = "", value?: any) => {
  const r = await fetch(`${base}${ROOT}${path}`, { method: value === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { status: r.status, body: await r.json() as any };
};
const selection = () => ({ network_id: net, source_node_id: "dir_source", daemon_node_id: "dir_daemon" });
const read = (id: string, token = human.token, network = net) => api(token, `/${id}?network_id=${network}`);
const binding = () => ({ expected: { node_id: "dir_daemon", network_id: net }, capability: CAP, instance_id: "11111111-1111-4111-8111-111111111111" });
const writeAuthority = () => writeFileSync(authority, JSON.stringify({ version: 1, grants: [ { server_id: serverId, network_id: net,
  source_node_id: "dir_source", directories: [project] } ] }), { mode: 0o600 });
beforeAll(async () => {
  ({ db } = await import("./db"));
  const { register, createNetworkTokenForNode } = await import("./auth");
  register("directory_bootstrap", "Fixture-Directory-4150!");
  human = register("directory_owner", "Fixture-Directory-4150!"); outsider = register("directory_outsider", "Fixture-Directory-4150!");
  net = human.network_id;
  daemon = createNetworkTokenForNode(human.user.user_id, net, "directory-daemon", "dir_daemon");
  source = createNetworkTokenForNode(human.user.user_id, net, "directory-source", "dir_source");
  expect(daemon.ok && source.ok).toBe(true);
  db.run("UPDATE nodes SET runtime='opencode-cli',config_snapshot=?1 WHERE node_id='dir_source'", [JSON.stringify({ flags: { opencodeGeneration: "v2", opencodeMode: "copresence" } })]);
  db.run("INSERT INTO sessions (resume_id,alias,node_id,network_id,env_transport,last_seen_at) VALUES ('directory_daemon','directory-daemon','dir_daemon',?1,'loopback',datetime('now'))", [net]);
  // Deliberately NO node_create_requests or node_daemon_bindings relation.
  for (const path of [home, daemonDir, project, join(home, ".anet"), join(daemonDir, ".anet")]) mkdirSync(path, { mode: 0o700 });
  writeFileSync(join(home, ".anet", "password"), "synthetic-directory-password", { mode: 0o600 });
  writeFileSync(join(home, ".anet", "opencode-shared-server.json"), JSON.stringify({ url: `http://127.0.0.1:${native.port}`, passwordFile: join(home, ".anet", "password") }), { mode: 0o600 });
  process.env.COMMHUB_SOURCE_DIRECTORY_PREVIEW = "1";
  ({ bootServer: boot } = await import("./server"));
});
beforeEach(() => {
  mode = "ok"; calls = []; epoch = 0; setSystemTime();
  db.run("UPDATE network_members SET role='owner' WHERE user_id=?1 AND network_id=?2", [human.user.user_id, net]);
  db.run("UPDATE api_tokens SET revoked_at=NULL WHERE token_id=?1", [daemon.token_id]);
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='dir_daemon'", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { source_directory_read: CAP } })]);
  db.run("UPDATE sessions SET env_transport='loopback' WHERE resume_id='directory_daemon'");
  writeAuthority(); chmodSync(authority, 0o600);
  hub = boot({ port: 0, hostname: "127.0.0.1" }); base = `http://127.0.0.1:${hub.port}`;
  worker = createSessionSourceTransportWorker({ hubUrl: base, home, daemonWorkDir: daemonDir, directoryEnabled: true, forkEnabled: false,
    pin: createSessionControlPin({ hubUrl: base, token: daemon.token, nodeId: "dir_daemon", networkId: net, epoch: 0,
      currentEpoch: () => epoch, currentToken: () => daemon.token, signal: new AbortController().signal }) });
});
afterEach(async () => { setSystemTime(); await worker.stop(); hub.stop(true); });
afterAll(() => {
  native.stop(true); db.close(); rmSync(root, { recursive: true, force: true });
  if (previousGate === undefined) delete process.env.COMMHUB_SOURCE_DIRECTORY_PREVIEW; else process.env.COMMHUB_SOURCE_DIRECTORY_PREVIEW = previousGate;
});
async function servers() {
  await worker.tick(); const q = await api(human.token, "", selection()); expect(q.status).toBe(200);
  await worker.tick(); const r = await read(q.body.request_id); expect(r.status).toBe(200); expect(r.body.status).toBe("ready");
  return r.body;
}
async function directory() {
  const s = await servers(); const q = await api(human.token, "", { ...selection(), server_id: serverId, selection_scope: s.request_id });
  expect(q.status).toBe(200); await worker.tick(); return read(q.body.request_id);
}
test("actual Hub HTTP -> frozen daemon worker -> native 2.0.22-shaped GET pages -> typed opaque snapshot, without prior child binding", async () => {
  const result = await directory(); expect(result.status).toBe(200); expect(result.body.status).toBe("ready");
  const s = result.body.snapshot; expect(s.lease_kind).toBe("process_local"); expect(s.selection_expires_at).toBeUndefined(); expect(s.projects).toHaveLength(1); expect(s.sessions).toHaveLength(2);
  expect(s.sessions.map((x: any) => x.activity)).toEqual(["running", "unknown"]);
  expect(s.sessions.every((x: any) => x.binding === "unknown" && !x.attach_authorized)).toBe(true);
  expect(s.sessions[0].session_id).toMatch(/^oses_/); expect(s.projects[0].project_id).toMatch(/^oprj_/);
  const json = JSON.stringify(result.body);
  for (const secret of [project, "127.0.0.1", "synthetic-directory-password", "ses_Running", "native-private-cursor", "prj_fixture", "Not visible", "ntok_"]) expect(json).not.toContain(secret);
  expect(calls.filter(x => x.includes("cursor="))).toHaveLength(1); expect(calls.every(x => x.startsWith("GET "))).toBe(true);
  expect(existsSync(join(daemonDir, ".anet", "source-execution-journal"))).toBe(false);
  expect(db.get("SELECT count(*) AS n FROM node_create_requests WHERE child_node_id='dir_source'").n).toBe(0);
});
test("HTTP requires human create/source visibility, exact network, explicit daemon capability and secure channel; rejects raw inputs", async () => {
  await worker.tick();
  for (const token of [daemon.token, source.token, outsider.token]) expect((await api(token, "", selection())).status).not.toBe(200);
  for (const extra of [{ url: "http://127.0.0.1:1" }, { path: project }, { token: "forged" }, { server_id: serverId }, { network_id: "other" }, { daemon_node_id: "dir_source" }]) {
    expect((await api(human.token, "", { ...selection(), ...extra })).status).not.toBe(200);
  }
  db.run("UPDATE network_members SET role='viewer' WHERE user_id=?1 AND network_id=?2", [human.user.user_id, net]);
  expect((await api(human.token, "", selection())).status).toBe(403);
  db.run("UPDATE network_members SET role='owner' WHERE user_id=?1 AND network_id=?2", [human.user.user_id, net]);
  db.run("UPDATE sessions SET env_transport=NULL WHERE resume_id='directory_daemon'");
  expect((await api(human.token, "", selection())).status).toBe(403);
  db.run("UPDATE sessions SET env_transport='loopback' WHERE resume_id='directory_daemon'");
  db.run("UPDATE nodes SET config_snapshot='{}' WHERE node_id='dir_daemon'");
  expect((await api(human.token, "", selection())).status).toBe(403); expect(calls).toEqual([]);
});
test("HTTP polling/selection scope cannot cross caller/network/daemon or survive expiry, permission revocation, daemon restart", async () => {
  const s = await servers();
  expect((await read(s.request_id, outsider.token)).status).toBe(403);
  expect((await read(s.request_id, human.token, "other")).status).toBe(403);
  expect((await read(s.request_id, daemon.token)).status).toBe(403);
  expect((await api(human.token, "", { ...selection(), server_id: `osrv_${randomUUID()}`, selection_scope: s.request_id })).status).toBe(403);
  db.run("UPDATE network_members SET role='viewer' WHERE user_id=?1 AND network_id=?2", [human.user.user_id, net]);
  expect((await read(s.request_id)).status).toBe(403);
  db.run("UPDATE network_members SET role='owner' WHERE user_id=?1 AND network_id=?2", [human.user.user_id, net]);
  const s2 = await servers(); setSystemTime(s2.expires_at + 1);
  expect((await read(s2.request_id)).status).toBe(403);
  expect((await api(human.token, "", { ...selection(), server_id: serverId, selection_scope: s2.request_id })).status).toBe(403);
  setSystemTime(); const s3 = await servers();
  expect((await api(daemon.token, "/daemon", binding())).status).toBe(200);
  expect((await read(s3.request_id)).status).toBe(403);
});
test("wrong daemon/instance/capability and revoked requester cannot ACK; claimed reads are not redelivered", async () => {
  const b = binding(); expect((await api(daemon.token, "/daemon", b)).status).toBe(200);
  const q = await api(human.token, "", selection()); const pull = await api(daemon.token, "/pull", b); expect(pull.body.task.request_id).toBe(q.body.request_id);
  expect((await api(daemon.token, "/pull", b)).body.task).toBeNull();
  const ack = { ...b, request_id: q.body.request_id, result: { error: "directory_read_failed" } };
  expect((await api(source.token, "/ack", ack)).status).toBe(403);
  expect((await api(daemon.token, "/ack", { ...ack, instance_id: randomUUID() })).status).toBe(403);
  expect((await api(daemon.token, "/ack", { ...ack, capability: "version-guessed" })).status).toBe(403);
  expect((await api(daemon.token, "/ack", { ...ack, result: { error: "directory_read_failed", path: project } })).status).toBe(400);
  db.run("UPDATE network_members SET role='viewer' WHERE user_id=?1 AND network_id=?2", [human.user.user_id, net]);
  expect((await api(daemon.token, "/ack", ack)).status).toBe(403);
});
test("Hub rejects a daemon snapshot with raw/private fields, wrong TTL or durable incarnation claim", async () => {
  const b = binding(); await api(daemon.token, "/daemon", b);
  const q = await api(human.token, "", selection()); await api(daemon.token, "/pull", b);
  const snapshot = { snapshot_id: `snap_${randomUUID()}`, expires_at: q.body.expires_at, selection_expires_at: q.body.expires_at + 600000, lease_kind: "process_local",
    servers: [{ server_id: serverId, title: "Server" }], projects: [], sessions: [], completeness: "authorized_scope_only" };
  for (const bad of [{ ...snapshot, url: "http://127.0.0.1:1" }, { ...snapshot, expires_at: snapshot.expires_at + 1 },
    { ...snapshot, servers: [{ server_id: serverId, title: project }] }, { ...snapshot, lease_kind: "durable_incarnation" }]) {
    expect((await api(daemon.token, "/ack", { ...b, request_id: q.body.request_id, result: bad })).status).toBe(400);
  }
  expect((await api(daemon.token, "/ack", { ...b, request_id: q.body.request_id, result: snapshot })).status).toBe(200);
});
test("no local authority/private mode means failed, not an empty successful catalog", async () => {
  unlinkSync(authority); await worker.tick(); const q = await api(human.token, "", selection()); await worker.tick();
  expect((await read(q.body.request_id)).body.status).toBe("failed"); expect(calls).toEqual([]);
  writeAuthority(); chmodSync(authority, 0o644); const q2 = await api(human.token, "", selection()); await worker.tick();
  expect((await read(q2.body.request_id)).body.status).toBe("failed"); expect(calls).toEqual([]);
});
for (const failure of ["down", "redirect", "large", "wrong-version", "no-auth", "wrong-directory", "too-many", "malformed-project"]) {
  test(`controlled native ${failure} is failed, never successful empty/truncated directory`, async () => {
    mode = failure; const r = await directory(); expect(r.status).toBe(200); expect(r.body.status).toBe("failed"); expect(r.body.snapshot).toBeUndefined();
  });
}
test("registered server selection fails after local authority removal/cross-network change, never falls back to managed source", async () => {
  const s = await servers();
  writeFileSync(authority, JSON.stringify({ version: 1, grants: [{ server_id: serverId, network_id: outsider.network_id, source_node_id: "dir_source", directories: [project] }] }));
  const q = await api(human.token, "", { ...selection(), server_id: serverId, selection_scope: s.request_id });
  expect(q.status).toBe(200); await worker.tick(); const r = await read(q.body.request_id);
  expect(r.body.status).toBe("failed"); expect(r.body.snapshot).toBeUndefined(); expect(calls).toEqual([]);
});
test("Hub reconstruction cannot resolve an old directory/selection scope, even after the same daemon re-declares", async () => {
  const s = await servers(); hub.stop(true); hub = boot({ port: 0, hostname: "127.0.0.1" }); base = `http://127.0.0.1:${hub.port}`;
  await api(daemon.token, "/daemon", binding());
  expect((await read(s.request_id)).status).toBe(403);
  expect((await api(human.token, "", { ...selection(), server_id: serverId, selection_scope: s.request_id })).status).toBe(403);
  expect(calls).toEqual([]);
});
test("titles sanitized; worker pin rotation prevents subsequent native read; default HTTP gate is closed", async () => {
  mode = "secret-title"; const r = await directory(); expect(r.body.status).toBe("ready");
  expect(r.body.snapshot.projects[0].title).toBe("Project"); expect(r.body.snapshot.sessions[0].title).toBe("Session");
  const count = calls.length; epoch++; await expect(worker.tick()).rejects.toThrow(); expect(calls.length).toBe(count);
  delete process.env.COMMHUB_SOURCE_DIRECTORY_PREVIEW;
  const gated = boot({ port: 0, hostname: "127.0.0.1" });
  try { const response = await fetch(`http://127.0.0.1:${gated.port}${ROOT}`, { method: "POST", headers: { authorization: `Bearer ${human.token}`, "content-type": "application/json" }, body: JSON.stringify(selection()) }); expect(response.status).toBe(404); }
  finally { gated.stop(true); process.env.COMMHUB_SOURCE_DIRECTORY_PREVIEW = "1"; }
});
