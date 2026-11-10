import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { testWorkRoot } from "./test-work-root";
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync, chownSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "./db";
import { register, createNetworkTokenForNode, resolveToken } from "./auth";
import { createSessionSourceEvidenceQueue } from "./session-source-evidence";
import type { SourceSelection } from "./session-source-issuer";
import { createSessionSourceEvidenceReader, handleSessionSourceEvidenceRead, handleSessionSourceLeaseRecheck } from "../../agent-node/src/runtime/session-source-evidence";
import { recordChildWorkdir, forgetChildWorkdir } from "../../agent-node/src/runtime/child-workdir";
import { writeOpenCodeV2CatalogEndpoint } from "../../agent-node/src/runtime/opencode-v2-catalog-endpoint";
import { publishSharedLaunchHealth } from "../../agent-node/src/runtime/opencode-copresence/launcher-health";
import { isSourceReadEvidence } from "../../contracts/session-source-evidence";
import { createSessionSourceExecutionQueue } from "./session-source-execution";
import { createSessionSourceExecutor, handleSessionSourceExecution } from "../../agent-node/src/runtime/session-source-execution";
import { createSessionSourceDeliveryQueue } from "./session-source-delivery";
import { createSessionSourceProfileWorker } from "../../agent-node/src/runtime/session-source-delivery";
import { SOURCE_DELIVERY_CAPABILITY, isSourceNodeDelivery } from "../../contracts/session-source-delivery";
import { stopBackgroundTimersForTest } from "./create-node";
import { createSessionSourceTransport } from "./session-source-transport";
import { createSessionSourceTransportWorker } from "../../agent-node/src/runtime/session-source-transport";
import { createSessionControlPin } from "../../agent-node/src/runtime/session-control-bridge";
import { SOURCE_FORK_ROOT, SOURCE_FORK_CAPABILITY } from "../../contracts/session-source-transport";

let human: ReturnType<typeof register>, daemon: ReturnType<typeof createNetworkTokenForNode>;
let source: ReturnType<typeof createNetworkTokenForNode>, selection: SourceSelection;
const req = (token?: string) => new Request("http://isolated.invalid", { headers: token ? { authorization: `Bearer ${token}` } : {} });
const root = mkdtempSync(join(testWorkRoot(), "source-read-")), project = join(root, "project"), daemonDir = join(root, "daemon");
const nodeDir = join(project, ".anet", "nodes", "source");
let version = "2.0.22", sessionDirectory = project, sessionId = "ses_Selected", authGate = true, redirect = false, large = false;
let forkPosts = 0, loseForkResponse = false, busy = false, busyDelivery = "";
// The native Server persists for the whole suite, as do per-child tombstones.
// A fresh fork must NEVER reuse a previous Session ID when per-test counts reset.
let nativeSessionSerial = 0;
let omitSessionModel = false, omitDefaultModel = false;
const calls: string[] = [];
let sourceTransport = createSessionSourceTransport({ enabled: true });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(r) {
  const u = new URL(r.url); calls.push(`${r.method} ${u.pathname}`);
  const transport = await sourceTransport(r, u); if (transport) return transport;
  if (u.pathname === "/fixture-register") {
    const token = r.headers.get("authorization")?.replace(/^Bearer /, ""), a = resolveToken(token ?? "");
    if (!a) return new Response("", { status: 401 });
    const body: any = await r.json();
    await registerFromPrivateProfile({ token, network_id: selection.network_id, alias: body.alias,
      node_id: body.node_id, sessionId: body.session_id });
    return Response.json({ ok: true });
  }
  if (u.pathname === "/mcp" && r.method === "POST") {
    const token = r.headers.get("authorization")?.replace(/^Bearer /, ""), a = resolveToken(token ?? "");
    if (!a) return new Response("", { status: 401 });
    const body: any = await r.json();
    if (body.params?.name === "report_status") {
      const b = body.params.arguments;
      await registerFromPrivateProfile({ token, network_id: selection.network_id, alias: b.alias, node_id: b.node_id, sessionId: b.session_id });
    }
    return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: JSON.stringify({ ok: true, sessions: [] }) }] } });
  }
  if (authGate && r.headers.get("authorization") !== "Basic b3BlbmNvZGU6Zml4dHVyZQ==") return new Response("", { status: 401 });
  if (redirect) return new Response("", { status: 302, headers: { location: "http://untrusted.invalid" } });
  if (large) return new Response("x".repeat(40000));
  if (u.pathname === "/api/info") return Response.json({ version, pid: process.pid });
  if (u.pathname === "/api/session/active") return Response.json({ data: busy ? { ses_Selected: { type: "running" } } : busyDelivery ? { [busyDelivery]: { type: "running" } } : {} });
  if (u.pathname === "/api/provider") return Response.json({ location: { directory: project }, data: [{ id: "stub", activation: "enabled" }] });
  if (u.pathname === "/api/model") return Response.json({ location: { directory: project }, data: [{ providerID: "stub", id: "stub-model" }] });
  if (u.pathname === "/api/model/default") return Response.json({ location: { directory: project }, data: omitDefaultModel ? null : { providerID: "stub", id: "stub-model" } });
  if (r.method === "POST" && u.pathname === "/api/session/ses_Selected/fork") {
    forkPosts++;
    const id = `ses_Child${++nativeSessionSerial}`;
    return loseForkResponse ? new Response("") : Response.json({ data: { id } });
  }
  return Response.json({ data: { id: u.pathname.includes("ses_Child") ? u.pathname.split("/").at(-1) : sessionId, location: { directory: sessionDirectory }, ...(omitSessionModel ? {} : { model: { providerID: "stub", id: "stub-model" } }) } });
} });
const local = () => ({ networkId: selection.network_id, daemonId: "n_daemon", daemonWorkDir: daemonDir, home: join(root, "home") });
const queue = () => createSessionSourceEvidenceQueue({ enabled: true });
const enqueue = (q: ReturnType<typeof queue>) => q.queue(req(human.token), selection, "ses_Selected")!;
const endpoint = () => writeOpenCodeV2CatalogEndpoint(nodeDir, { url: `http://127.0.0.1:${server.port}`, authorization: "Basic b3BlbmNvZGU6Zml4dHVyZQ==", directory: project });
beforeAll(() => {
  register("evidence_bootstrap", "Fixture-Strong-4150!");
  human = register("evidence_owner", "Fixture-Strong-4150!");
  const net = human.network_id!, uid = human.user!.user_id;
  source = createNetworkTokenForNode(uid, net, "source", "n_source");
  daemon = createNetworkTokenForNode(uid, net, "daemon", "n_daemon");
  expect(source.ok && daemon.ok).toBe(true);
  selection = { network_id: net, source_node_id: "n_source", daemon_node_id: "n_daemon", mode: "attach_existing" };
  db.run("UPDATE nodes SET runtime='opencode-cli',config_snapshot=?1 WHERE node_id='n_source'", [JSON.stringify({ flags: { opencodeGeneration: "v2", opencodeMode: "copresence" } })]);
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_daemon'", [JSON.stringify({ role: "host_supervisor" })]);
  db.run(`INSERT INTO sessions (resume_id,alias,node_id,network_id,last_seen_at) VALUES
    ('ev_source','source','n_source',?1,datetime('now')),('ev_daemon','daemon','n_daemon',?1,datetime('now'))`, [net]);
  db.run(`INSERT INTO node_create_requests (request_id,daemon_node_id,child_name,network_id,runtime,flags_json,env_keys,status,child_node_id,created_at,created_by_token)
    VALUES ('cr_evidence','n_daemon','source',?1,'opencode-cli','{}','[]','succeeded','n_source',1000,?2)`, [net, human.token_id!]);
  mkdirSync(daemonDir, { mode: 0o700 });
  mkdirSync(nodeDir, { recursive: true, mode: 0o700 });
});
beforeEach(() => {
  omitSessionModel = false; omitDefaultModel = false;
  version = "2.0.22"; sessionDirectory = project; sessionId = "ses_Selected"; authGate = true; redirect = false; large = false; calls.length = 0;
  forkPosts = 0; loseForkResponse = false; busy = false; busyDelivery = "";
  for (const p of [project, join(project, ".anet"), join(project, ".anet", "nodes"), nodeDir]) chmodSync(p, 0o700);
  writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ node_id: "n_source", network_id: selection.network_id,
    runtime: "opencode-cli", opencodeGeneration: "v2", alias: "source", flags: { opencodeUnsafeTools: true } }), { mode: 0o600 });
  recordChildWorkdir(daemonDir, "source", project); endpoint();
  publishSharedLaunchHealth(nodeDir, "ses_Selected", process.pid);
  db.run("UPDATE api_tokens SET revoked_at=NULL WHERE token_id=?1", [daemon.token_id!]);
  db.run("UPDATE network_members SET role='owner' WHERE user_id=?1 AND network_id=?2", [human.user!.user_id, selection.network_id]);
  db.run("UPDATE sessions SET last_seen_at=datetime('now') WHERE resume_id IN ('ev_source','ev_daemon')");
  db.run("UPDATE sessions SET env_transport='loopback' WHERE resume_id='ev_daemon'");
});
afterAll(() => { server.stop(true); rmSync(root, { recursive: true, force: true }); db.close(); });

test("actual loopback GET + private files + OS listener observation return challenge-bound evidence", async () => {
  const q = queue(), challenge = enqueue(q), pulled = q.take(req(daemon.token), challenge.request_id)!;
  expect(pulled).toEqual(challenge);
  expect(q.take(req(daemon.token), challenge.request_id)).toBeNull();
  const reader = createSessionSourceEvidenceReader(local()), result = await reader.read(pulled);
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(isSourceReadEvidence(result.evidence)).toBe(true);
  expect(result.evidence.server.pid).toBe(process.pid);
  expect(result.evidence.canonical_directory).toBe(project);
  expect(q.ack(req(daemon.token), result.evidence)).toBe(true);
  expect(q.result(req(human.token), challenge.request_id)).toEqual(result.evidence);
  expect(q.ack(req(daemon.token), result.evidence)).toBe(false);
  expect(await reader.recheck(result.evidence.lease_id)).toBe(true);
  expect(await createSessionSourceEvidenceReader(local()).recheck(result.evidence.lease_id)).toBe(false);
  expect(calls.every(c => c.startsWith("GET /api/info") || c === "GET /api/session/ses_Selected")).toBe(true);
  expect(JSON.stringify(result.evidence)).not.toContain("b3BlbmNvZGU6Zml4dHVyZQ");
  expect(db.get<{ n: number }>("SELECT COUNT(*) n FROM session_source_grants")!.n).toBe(0);
});

test("challenge spoof/replay, wrong daemon/human, missing take and restart cannot acknowledge", async () => {
  const q = queue(), c = enqueue(q), reader = createSessionSourceEvidenceReader(local());
  expect(q.take(req(source.token), c.request_id)).toBeNull();
  expect(q.take(req(human.token), c.request_id)).toBeNull();
  const r = await reader.read(c); expect(r.ok).toBe(true); if (!r.ok) return;
  expect(q.ack(req(daemon.token), r.evidence)).toBe(false);
  q.take(req(daemon.token), c.request_id);
  expect(q.ack(req(source.token), r.evidence)).toBe(false);
  for (const change of [{ challenge: "a".repeat(43) }, { session_id: "ses_Other" }, { source_node_id: "n_other" }, { network_id: "net_other" }]) {
    expect(q.ack(req(daemon.token), { ...r.evidence, request: { ...c, ...change } })).toBe(false);
  }
  expect(queue().ack(req(daemon.token), r.evidence)).toBe(false);
  expect(q.ack(req(daemon.token), { ...r.evidence, url: "http://untrusted.invalid" })).toBe(false);
  expect(q.ack(req(daemon.token), r.evidence)).toBe(true);
  expect(q.result(req(source.token), c.request_id)).toBeNull();
});

test("disabled production default, revoked daemon and demoted requester fail closed", async () => {
  expect(createSessionSourceEvidenceQueue().queue(req(human.token), selection, "ses_Selected")).toBeNull();
  const q = queue(), c = enqueue(q); q.take(req(daemon.token), c.request_id);
  const r = await createSessionSourceEvidenceReader(local()).read(c); expect(r.ok).toBe(true); if (!r.ok) return;
  db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", [daemon.token_id!]);
  expect(q.ack(req(daemon.token), r.evidence)).toBe(false);
  db.run("UPDATE api_tokens SET revoked_at=NULL WHERE token_id=?1", [daemon.token_id!]);
  db.run("UPDATE network_members SET role='viewer' WHERE user_id=?1 AND network_id=?2", [human.user!.user_id, selection.network_id]);
  expect(q.ack(req(daemon.token), r.evidence)).toBe(false);
  expect(q.result(req(human.token), c.request_id)).toBeNull();
});

test("reader refuses expired/foreign challenges, URL/path fields and unregistered legacy fallback before HTTP", async () => {
  const c = enqueue(queue()), reader = createSessionSourceEvidenceReader(local());
  for (const change of [{ expires_at: Date.now() - 1 }, { daemon_node_id: "other" }, { network_id: "other" },
    { url: "http://untrusted.invalid" }, { directory: "/etc" }, { alias: "../escape" }]) {
    expect((await reader.read({ ...c, ...change })).ok).toBe(false);
  }
  forgetChildWorkdir(daemonDir, "source");
  expect((await reader.read(c)).ok).toBe(false);
  expect(calls).toEqual([]);
});

test("wrong API version/session directory/id, redirects, oversized body and absent auth gate refuse", async () => {
  const c = enqueue(queue()), reader = createSessionSourceEvidenceReader(local());
  version = "2.0.23"; expect((await reader.read(c)).ok).toBe(false); version = "2.0.22";
  sessionDirectory = root; expect((await reader.read(c)).ok).toBe(false); sessionDirectory = project;
  sessionId = "ses_Other"; expect((await reader.read(c)).ok).toBe(false); sessionId = "ses_Selected";
  redirect = true; expect((await reader.read(c)).ok).toBe(false); redirect = false;
  large = true; expect((await reader.read(c)).ok).toBe(false); large = false;
  authGate = false; expect((await reader.read(c)).ok).toBe(false);
});

test("real directory permissions/symlinks, wrong source config and dead local binding refuse", async () => {
  const c = enqueue(queue()), reader = createSessionSourceEvidenceReader(local());
  chmodSync(project, 0o777); expect((await reader.read(c)).ok).toBe(false); chmodSync(project, 0o700);
  writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ node_id: "n_other" }));
  expect((await reader.read(c)).ok).toBe(false);
  writeFileSync(join(nodeDir, "config.json"), JSON.stringify({ node_id: "n_source", network_id: selection.network_id,
    runtime: "opencode-cli", opencodeGeneration: "v2", alias: "source" }));
  publishSharedLaunchHealth(nodeDir, "ses_NotSelected", process.pid);
  expect((await reader.read(c)).ok).toBe(false);
  publishSharedLaunchHealth(nodeDir, "ses_Selected", process.pid);
  const link = join(root, "linked"); symlinkSync(project, link);
  recordChildWorkdir(daemonDir, "source", link);
  expect((await reader.read(c)).ok).toBe(false);
  rmSync(link);
});

test("local recheck detects changed endpoint, session and directory without reusing lease after restart", async () => {
  const c = enqueue(queue()), reader = createSessionSourceEvidenceReader(local());
  const r = await reader.read(c); expect(r.ok).toBe(true); if (!r.ok) return;
  sessionDirectory = root;
  expect(await reader.recheck(r.evidence.lease_id)).toBe(false);
  sessionDirectory = project;
  expect(await reader.recheck(r.evidence.lease_id)).toBe(false);
});

test("internal pull/read/recheck/ack handler completes without public endpoint or doorbell", async () => {
  const q = queue(), c = enqueue(q), reader = createSessionSourceEvidenceReader(local());
  const deps = { reader, take: async (id: string) => q.take(req(daemon.token), id),
    ack: async (value: any) => q.ack(req(daemon.token), value) };
  expect(await handleSessionSourceEvidenceRead(c.request_id, deps)).toBe(true);
  expect(q.result(req(human.token), c.request_id)?.kind).toBe("process_local_lease");
  expect(await handleSessionSourceEvidenceRead(c.request_id, deps)).toBe(false);
  db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", [daemon.token_id!]);
  expect(q.result(req(human.token), c.request_id)).toBeNull();
});

test("local opaque lease is retired on endpoint replacement even if old endpoint is restored", async () => {
  const c = enqueue(queue()), reader = createSessionSourceEvidenceReader(local());
  const r = await reader.read(c); expect(r.ok).toBe(true); if (!r.ok) return;
  writeOpenCodeV2CatalogEndpoint(nodeDir, { url: `http://127.0.0.1:${server.port}`, authorization: "Basic bm90LWF1dGg=", directory: project });
  expect(await reader.recheck(r.evidence.lease_id)).toBe(false);
  endpoint();
  expect(await reader.recheck(r.evidence.lease_id)).toBe(false);
});

test("private registry and actual directory uid are required before network reads", async () => {
  const c = enqueue(queue()), reader = createSessionSourceEvidenceReader(local());
  const registry = join(daemonDir, ".anet", "child-workdirs.json");
  chmodSync(registry, 0o644);
  expect((await reader.read(c)).ok).toBe(false);
  chmodSync(registry, 0o600);
  // Docker --user 0 permits a real foreign-owner fixture, never touches host. The unit image runs
  // as a non-root user; there the foreign-owner half cannot be built, so it ends here (the
  // permission checks above still ran).
  if (process.getuid!() !== 0) { console.warn("[session-source-evidence] foreign-owner fixture needs uid 0; skipped that half"); return; }
  chownSync(project, 65534, 65534);
  try { expect((await reader.read(c)).ok).toBe(false); }
  finally { chownSync(project, 0, 0); }
  expect(calls).toEqual([]);
});

test("Hub challenge and daemon lease expiry cannot be revived after the deadline", async () => {
  const q = queue(), c = enqueue(q), reader = createSessionSourceEvidenceReader(local());
  q.take(req(daemon.token), c.request_id);
  const r = await reader.read(c); expect(r.ok).toBe(true); if (!r.ok) return;
  const now = Date.now;
  try {
    Date.now = () => c.expires_at + 1;
    expect(q.ack(req(daemon.token), r.evidence)).toBe(false);
    expect(await reader.recheck(r.evidence.lease_id)).toBe(false);
  } finally { Date.now = now; }
  expect(q.ack(req(daemon.token), r.evidence)).toBe(false);
  expect(await reader.recheck(r.evidence.lease_id)).toBe(false);
});

test("a different actual loopback listener cannot reuse a process-local lease", async () => {
  const c = enqueue(queue()), reader = createSessionSourceEvidenceReader(local());
  const r = await reader.read(c); expect(r.ok).toBe(true); if (!r.ok) return;
  const second = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(r) {
    if (!r.headers.has("authorization")) return new Response("", { status: 401 });
    return Response.json(new URL(r.url).pathname === "/api/info" ? { version: "2.0.22", pid: process.pid }
      : { data: { id: "ses_Selected", location: { directory: project } } });
  } });
  try {
    writeOpenCodeV2CatalogEndpoint(nodeDir, { url: `http://127.0.0.1:${second.port}`, authorization: "Basic b3BlbmNvZGU6Zml4dHVyZQ==", directory: project });
    expect(await reader.recheck(r.evidence.lease_id)).toBe(false);
    endpoint();
    expect(await reader.recheck(r.evidence.lease_id)).toBe(false);
  } finally { second.stop(true); }
});

const admissionCounts = () => ({
  grants: db.get<{ n: number }>("SELECT COUNT(*) n FROM session_source_grants")!.n,
  reservations: db.get<{ n: number }>("SELECT COUNT(*) n FROM node_create_requests WHERE source_ref IS NOT NULL")!.n,
  tokens: db.get<{ n: number }>("SELECT COUNT(*) n FROM api_tokens")!.n,
});
async function prepared(mode: SourceSelection["mode"] = "attach_existing") {
  const q = queue(), reader = createSessionSourceEvidenceReader(local());
  const c = q.queue(req(human.token), { ...selection, mode }, "ses_Selected")!;
  expect(await handleSessionSourceEvidenceRead(c.request_id, { reader,
    take: async id => q.take(req(daemon.token), id), ack: async v => q.ack(req(daemon.token), v) })).toBe(true);
  const dispatch = async (id: string) => {
    expect(await handleSessionSourceLeaseRecheck(id, { reader,
      take: async id => q.takeRecheck(req(daemon.token), id), ack: async v => q.ackRecheck(req(daemon.token), v) })).toBe(true);
  };
  return { q, reader, c, dispatch };
}

test("async authenticated lease consumption atomically issues/claims one grant and real reservation in both modes", async () => {
  for (const mode of ["attach_existing", "fork_independent"] as const) {
    const p = await prepared(mode), before = admissionCounts();
    const receipt = await p.q.admit(req(human.token), p.c.request_id, `success_${mode}`, `child-${mode}`, p.dispatch);
    expect(receipt.status).toBe("source_reserved");
    expect(receipt.scope).toBe("admission_only");
    expect(receipt.execution).toMatchObject({ mode, dispatchable: false, lease_kind: "process_local_lease",
      guard: "daemon_recheck_in_execution_context_required", protocol: "source-aware-v1-required" });
    expect(admissionCounts()).toEqual({ ...before, grants: before.grants + 1, reservations: before.reservations + 1 });
    expect(db.get("SELECT state,create_request_id FROM session_source_grants WHERE source_ref=?1", receipt.source_ref))
      .toEqual({ state: "claimed", create_request_id: receipt.request_id });
    expect(db.get("SELECT status,child_token_id,workdir FROM node_create_requests WHERE request_id=?1", receipt.request_id))
      .toEqual({ status: "source_reserved", child_token_id: null, workdir: project });
    expect(db.get("SELECT execution_guard,lease_id,authorized_until FROM session_source_admission_intents WHERE evidence_request_id=?1", p.c.request_id))
      .toEqual({ execution_guard: "daemon_recheck_in_execution_context_required", lease_id: receipt.execution.lease_id,
        authorized_until: receipt.execution.authorized_until });
    const restarted = queue();
    expect(restarted.recoverAdmission(req(human.token), { ...selection, mode }, `success_${mode}`))
      .toEqual({ request_id: receipt.request_id, status: "source_reserved", scope: "historical_admission_only", execution: "not_authorized", dispatchable: false });
    expect(() => db.run("UPDATE node_create_requests SET status='pending' WHERE request_id=?1", [receipt.request_id])).toThrow("source_create_immutable");
    await expect(restarted.admit(req(human.token), p.c.request_id, `success_${mode}`, "again", p.dispatch)).rejects.toThrow();
  }
});

test("concurrent intent replay and fresh evidence/new intent cannot bypass single request association", async () => {
  const p = await prepared(), before = admissionCounts();
  const results = await Promise.allSettled([
    p.q.admit(req(human.token), p.c.request_id, "concurrent_intent", "one-child", p.dispatch),
    p.q.admit(req(human.token), p.c.request_id, "concurrent_intent", "one-child", p.dispatch),
  ]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  await expect(p.q.admit(req(human.token), p.c.request_id, "different_intent", "other-child", p.dispatch))
    .rejects.toThrow("source_intent_already_associated");
  const fresh = await prepared();
  await expect(fresh.q.admit(req(human.token), fresh.c.request_id, "concurrent_intent", "other-child", fresh.dispatch))
    .rejects.toThrow("source_intent_already_associated");
  expect(admissionCounts()).toEqual({ ...before, grants: before.grants + 1, reservations: before.reservations + 1 });
});

test("post-ACK permission revocation is rechecked in synchronous admission: zero new grants/reservations", async () => {
  const p = await prepared(), before = admissionCounts();
  await expect(p.q.admit(req(human.token), p.c.request_id, "demoted_at_ack", "never-child", async id => {
    await p.dispatch(id);
    db.run("UPDATE network_members SET role='viewer' WHERE user_id=?1 AND network_id=?2", [human.user!.user_id, selection.network_id]);
  })).rejects.toThrow("source_lease_recheck_required");
  expect(admissionCounts()).toEqual(before);
});

test("requester and daemon credential revocation after confirmation prevents synchronous issuance", async () => {
  for (const [kind, tokenId] of [["human", human.token_id!], ["daemon", daemon.token_id!]]) {
    const p = await prepared(), before = admissionCounts();
    try {
      await expect(p.q.admit(req(human.token), p.c.request_id, `revoked_${kind}`, "never-child", async id => {
        await p.dispatch(id);
        db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", [tokenId]);
      })).rejects.toThrow("source_lease_recheck_required");
      expect(admissionCounts()).toEqual(before);
    } finally { db.run("UPDATE api_tokens SET revoked_at=NULL WHERE token_id=?1", [tokenId]); }
  }
});

test("daemon reader restart, invalid local lease and missing queue state refuse admission with zero new rows", async () => {
  for (const failure of ["reader_restart", "invalid_lease", "queue_restart"] as const) {
    const p = await prepared(), before = admissionCounts();
    if (failure === "invalid_lease") sessionDirectory = root;
    await expect(p.q.admit(req(human.token), p.c.request_id, failure, "never-child", async id => {
      const q = failure === "queue_restart" ? queue() : p.q;
      const reader = failure === "reader_restart" ? createSessionSourceEvidenceReader(local()) : p.reader;
      expect(await handleSessionSourceLeaseRecheck(id, { reader,
        take: async id => q.takeRecheck(req(daemon.token), id), ack: async v => q.ackRecheck(req(daemon.token), v) })).toBe(false);
    })).rejects.toThrow("source_lease_recheck_required");
    expect(admissionCounts()).toEqual(before);
    sessionDirectory = project;
    const fresh = await prepared();
    await expect(fresh.q.admit(req(human.token), fresh.c.request_id, failure, "retry-child", fresh.dispatch))
      .rejects.toThrow("source_intent_already_associated");
    expect(admissionCounts()).toEqual(before);
  }
});

test("recheck exact challenge includes user/token/mode/intent; wrong daemon and replay cannot confirm", async () => {
  const p = await prepared(), before = admissionCounts();
  await p.q.admit(req(human.token), p.c.request_id, "scope_recheck", "scoped-child", async id => {
    expect(p.q.takeRecheck(req(source.token), id)).toBeNull();
    const q = p.q.takeRecheck(req(daemon.token), id)!;
    expect(p.q.takeRecheck(req(daemon.token), id)).toBeNull();
    for (const change of [{ mode: "fork_independent" }, { user_id: "other" }, { requester_token_id: "other" }]) {
      expect(await p.reader.confirm({ ...q, evidence: { ...q.evidence, request: { ...q.evidence.request, ...change } } } as any)).toBeNull();
    }
    const response = (await p.reader.confirm(q))!; expect(response).not.toBeNull();
    expect(p.q.ackRecheck(req(source.token), response)).toBe(false);
    expect(p.q.ackRecheck(req(daemon.token), { ...response, request: { ...q, intent_id: "other_intent" } })).toBe(false);
    expect(p.q.ackRecheck(req(daemon.token), { ...response, request: { ...q, challenge: "x".repeat(43) } })).toBe(false);
    expect(p.q.ackRecheck(req(daemon.token), response)).toBe(true);
    expect(p.q.ackRecheck(req(daemon.token), response)).toBe(false);
    expect(await p.reader.confirm(q)).toBeNull();
  });
  expect(admissionCounts()).toEqual({ ...before, grants: before.grants + 1, reservations: before.reservations + 1 });
});

test("expired confirmed challenge and failed real INSERT roll back grant issuance and claim together", async () => {
  const expired = await prepared(), before = admissionCounts(), now = Date.now;
  try {
    await expect(expired.q.admit(req(human.token), expired.c.request_id, "expired_admission", "never-child", async id => {
      await expired.dispatch(id); Date.now = () => expired.c.expires_at + 1;
    })).rejects.toThrow("source_lease_recheck_required");
  } finally { Date.now = now; }
  expect(admissionCounts()).toEqual(before);
  const p = await prepared();
  db.exec(`CREATE TRIGGER fail_source_admission_fixture BEFORE INSERT ON node_create_requests
    WHEN NEW.source_ref IS NOT NULL BEGIN SELECT RAISE(ABORT,'fixture_insert_failure'); END;`);
  try { await expect(p.q.admit(req(human.token), p.c.request_id, "insert_failure", "never-child", p.dispatch)).rejects.toThrow("fixture_insert_failure"); }
  finally { db.exec("DROP TRIGGER fail_source_admission_fixture"); }
  expect(admissionCounts()).toEqual(before);
});

test("post-recheck runtime drift does not pretend atomic execution: admission-only receipt still requires daemon execution-context recheck", async () => {
  const p = await prepared();
  const receipt = await p.q.admit(req(human.token), p.c.request_id, "admission_not_execution", "retained-only", async id => {
    await p.dispatch(id); sessionDirectory = root; // cannot be locked by Hub SQL
  });
  expect(receipt.status).toBe("source_reserved");
  expect(receipt.execution.dispatchable).toBe(false);
  expect(receipt.execution.guard).toBe("daemon_recheck_in_execution_context_required");
  expect(await p.reader.recheck(receipt.execution.lease_id)).toBe(false);
});

async function executable(mode: SourceSelection["mode"], intent: string) {
  const p = await prepared(mode);
  const receipt = await p.q.admit(req(human.token), p.c.request_id, intent, `ex-${intent}`, p.dispatch);
  const hub = createSessionSourceExecutionQueue(p.q, { enabled: true });
  const id = hub.queue(req(human.token), receipt.request_id)!;
  expect(id).not.toBeNull();
  const dir = mkdtempSync(join(root, "execution-journal-"));
  const executor = createSessionSourceExecutor(p.reader, dir);
  return { ...p, receipt, hub, id, dir, executor };
}

test("source-aware real HTTP attach retains original ID without POST; fork calls existing API once and verifies new ID", async () => {
  for (const mode of ["attach_existing", "fork_independent"] as const) {
    const p = await executable(mode, `execute_${mode}`), before = forkPosts;
    expect(await handleSessionSourceExecution(p.id, { executor: p.executor,
      take: async id => p.hub.take(req(daemon.token), id), ack: async v => p.hub.ack(req(daemon.token), v) })).toBe(true);
    const result = p.hub.recover(req(human.token), p.id)!;
    expect(result.status).toBe("session_ready");
    expect(result.bridge).toBe("not_created");
    expect(mode === "attach_existing" ? result.session_id === "ses_Selected" : result.session_id !== "ses_Selected").toBe(true);
    expect(forkPosts - before).toBe(mode === "attach_existing" ? 0 : 1);
    expect(p.hub.queue(req(human.token), p.receipt.request_id)).toBeNull();
    expect(p.hub.take(req(daemon.token), p.id)).toBeNull();
    expect(db.get("SELECT status,child_token_id FROM node_create_requests WHERE request_id=?1", p.receipt.request_id))
      .toEqual({ status: "source_reserved", child_token_id: null });
  }
});

test("wrong daemon, forged admission/source/session/dir, busy and duplicate bridge reject before fork POST", async () => {
  const p = await executable("fork_independent", "execution_controls");
  expect(createSessionSourceExecutionQueue(p.q).queue(req(human.token), p.receipt.request_id)).toBeNull();
  expect(p.hub.queue(req(human.token), "cr_forged")).toBeNull();
  expect(p.hub.take(req(source.token), p.id)).toBeNull();
  const task = p.hub.take(req(daemon.token), p.id)!;
  for (const change of [{ session_id: "ses_Other" }, { daemon_node_id: "n_wrong" }, { source_node_id: "n_wrong" }]) {
    expect((await p.reader.execute({ ...task, evidence: { ...task.evidence, request: { ...task.evidence.request, ...change } } })).status).toBe("refused");
  }
  expect((await p.reader.execute({ ...task, evidence: { ...task.evidence, canonical_directory: root } })).status).toBe("refused");
  busy = true;
  expect((await p.executor.execute(task)).status).toBe("refused"); busy = false;
  expect(forkPosts).toBe(0);
  const second = await executable("fork_independent", "duplicate_owner");
  const duplicate = join(project, ".anet", "nodes", "duplicate"); mkdirSync(duplicate, { mode: 0o700 });
  publishSharedLaunchHealth(duplicate, "ses_Selected", process.pid);
  try {
    const t = second.hub.take(req(daemon.token), second.id)!;
    expect((await second.executor.execute(t)).status).toBe("refused");
  } finally { rmSync(duplicate, { recursive: true, force: true }); }
  expect(forkPosts).toBe(0);
});

test("execution lease expiry, actual session-directory drift and reader restart refuse with zero POST", async () => {
  for (const failure of ["expiry", "directory", "restart"] as const) {
    const p = await executable("fork_independent", `execution_${failure}`), task = p.hub.take(req(daemon.token), p.id)!;
    const now = Date.now;
    try {
      if (failure === "expiry") Date.now = () => task.authorized_until + 1;
      if (failure === "directory") sessionDirectory = root;
      const executor = failure === "restart" ? createSessionSourceExecutor(createSessionSourceEvidenceReader(local()), p.dir) : p.executor;
      expect((await executor.execute(task)).status).toBe("refused");
    } finally { Date.now = now; sessionDirectory = project; }
    expect(forkPosts).toBe(0);
  }
});

test("concurrent same execution task has one persistent claim and one fork; restarted local/Hub readers only recover", async () => {
  const p = await executable("fork_independent", "concurrent_execution"), task = p.hub.take(req(daemon.token), p.id)!;
  expect(p.hub.take(req(daemon.token), p.id)).toBeNull();
  const results = await Promise.all([p.executor.execute(task), p.executor.execute(task)]);
  const success = results.find(r => r.status === "session_ready")!;
  expect(success.session_id).toBe(`ses_Child${nativeSessionSerial}`); expect(forkPosts).toBe(1);
  const restarted = createSessionSourceExecutor(createSessionSourceEvidenceReader(local()), p.dir);
  expect(restarted.recover(task)).toEqual(success);
  expect(await restarted.execute(task)).toEqual(success); expect(forkPosts).toBe(1);
  expect(p.hub.ack(req(daemon.token), success)).toBe(true);
  const restartedHub = createSessionSourceExecutionQueue(p.q, { enabled: true });
  expect(restartedHub.recover(req(human.token), p.id)).toEqual(success);
  expect(restartedHub.take(req(daemon.token), p.id)).toBeNull(); expect(forkPosts).toBe(1);
});

test("lost fork success response persists unknown; no POST retry after local or Hub restart", async () => {
  const p = await executable("fork_independent", "lost_fork_response"), task = p.hub.take(req(daemon.token), p.id)!;
  loseForkResponse = true;
  const outcome = await p.executor.execute(task);
  expect(outcome.status).toBe("unknown"); expect(forkPosts).toBe(1);
  expect(p.hub.ack(req(daemon.token), outcome)).toBe(true);
  loseForkResponse = false;
  const restarted = createSessionSourceExecutor(createSessionSourceEvidenceReader(local()), p.dir);
  expect(await restarted.execute(task)).toEqual(outcome);
  expect(createSessionSourceExecutionQueue(p.q, { enabled: true }).recover(req(human.token), p.id)).toEqual(outcome);
  expect(forkPosts).toBe(1);
});

test("lost Hub ACK recovers the persisted child ID without API writes; missing daemon delivery stays unknown", async () => {
  const p = await executable("fork_independent", "lost_hub_ack"), task = p.hub.take(req(daemon.token), p.id)!;
  const done = await p.executor.execute(task); expect(done.status).toBe("session_ready");
  expect(p.hub.recover(req(human.token), p.id)?.status).toBe("unknown"); // ACK never arrived
  const restarted = createSessionSourceExecutor(createSessionSourceEvidenceReader(local()), p.dir);
  expect(restarted.recover(task).session_id).toBe(done.session_id);
  expect(p.hub.ack(req(daemon.token), restarted.recover(task))).toBe(true);
  expect(p.hub.recover(req(human.token), p.id)).toEqual(done); expect(forkPosts).toBe(1);
  const lost = await executable("fork_independent", "lost_delivery");
  lost.hub.take(req(daemon.token), lost.id); // delivery lost, never execute
  const hub = createSessionSourceExecutionQueue(lost.q, { enabled: true });
  expect(hub.take(req(daemon.token), lost.id)).toBeNull();
  expect(hub.recover(req(human.token), lost.id)?.status).toBe("unknown"); expect(forkPosts).toBe(1);
});

async function readyDelivery(intent: string, mode: SourceSelection["mode"] = "fork_independent") {
  const p = await executable(mode, intent), task = p.hub.take(req(daemon.token), p.id)!;
  const outcome = await p.executor.execute(task);
  expect(outcome.status).toBe("session_ready"); expect(p.hub.ack(req(daemon.token), outcome)).toBe(true);
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_daemon'", [JSON.stringify({ role: "host_supervisor",
    daemon_capabilities: { source_node_delivery: SOURCE_DELIVERY_CAPABILITY } })]);
  const delivery = createSessionSourceDeliveryQueue(p.hub, { enabled: true });
  return { ...p, delivery, outcome };
}
test("fork with absent native Session model uses scoped catalog default; absent default never guesses or reforks", async () => {
  for (const missingDefault of [false, true]) {
    const p = await readyDelivery(`missing_model_${missingDefault}`);
    const id = p.delivery.queue(req(human.token), p.id)!;
    const payload = p.delivery.take(req(daemon.token), id, SOURCE_DELIVERY_CAPABILITY)!;
    omitSessionModel = true; omitDefaultModel = missingDefault;
    const before = forkPosts; let workCalls = 0;
    const result = await p.reader.deliver(payload, async context => { workCalls++; return context.model; });
    expect(result).toBe(missingDefault ? null : "stub/stub-model");
    expect(workCalls).toBe(missingDefault ? 0 : 1);
    expect(forkPosts).toBe(before);
  }
});
async function registerFromPrivateProfile(config: any) {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { registerTools } = await import("./tools");
  const a = resolveToken(config.token)!;
  const handlers: Record<string, (args: any) => Promise<any>> = {};
  const mcp = new McpServer({ name: "source-registration-fixture", version: "0" });
  const tool = mcp.tool.bind(mcp);
  (mcp as any).tool = (name: string, desc: string, schema: any, handler: any) => { handlers[name] = handler; return tool(name, desc, schema, handler); };
  registerTools(mcp, undefined, config.network_id, a.user.user_id, config.alias, true, a.tokenId!);
  try {
    const response = await handlers.report_status({ resume_id: `reg_${config.node_id}`, alias: config.alias,
      node_id: config.node_id, session_id: config.sessionId, status: "idle", agent: "source-fixture" });
    expect(JSON.parse(response.content[0].text).ok !== false).toBe(true);
  } finally { await mcp.close(); }
}

test("real child token metadata -> one-shot source payload -> private profile -> resume-only runner stub -> real report_status registration", async () => {
  const p = await readyDelivery("delivery_success"), beforePosts = forkPosts;
  const id = p.delivery.queue(req(human.token), p.id)!; expect(id).not.toBeNull();
  const payload = p.delivery.take(req(daemon.token), id, SOURCE_DELIVERY_CAPABILITY)!; expect(!!payload).toBe(true);
  expect(isSourceNodeDelivery(payload)).toBe(true);
  expect(await p.reader.recheck(payload.execution.evidence.lease_id)).toBe(true);
  expect(await p.reader.deliver(payload, async () => "context-checked")).toBe("context-checked");
  expect(p.delivery.take(req(daemon.token), id, SOURCE_DELIVERY_CAPABILITY)).toBeNull();
  expect(p.delivery.confirmRegistration(req(payload.child_token), id)).toBe(false); // no self-asserted success
  const home = mkdtempSync(join(root, "binding-home-")); let launches = 0;
  const worker = createSessionSourceProfileWorker({ enabled: true, capability: SOURCE_DELIVERY_CAPABILITY, daemonWorkDir: daemonDir,
    bindingHome: home, hubUrl: "http://isolated.invalid", reader: p.reader,
    launch: async input => {
      launches++;
      expect(input.existingSessionId).toBe(p.outcome.session_id!); expect(input.resumeSessionId).toBe(input.existingSessionId);
      expect(input.newSession).toBe(false); expect(input.expectedVersion).toBe("2.0.22");
      const cfg = JSON.parse(readFileSync(input.configPath, "utf8"));
      expect(cfg.token === payload.child_token).toBe(true);
      expect(cfg.sessionId).toBe(p.outcome.session_id!); expect(cfg.node_id).toBe(payload.child_node_id);
      expect(statSync(input.configPath).mode & 0o777).toBe(0o600);
      await registerFromPrivateProfile(cfg);
    }, confirmRegistration: async (id, token) => p.delivery.confirmRegistration(req(token), id) });
  expect((await worker.run(payload)).status).toBe("registration_confirmed"); expect(launches).toBe(1);
  expect(forkPosts).toBe(beforePosts);
  const token = db.get<{ token_hash: string; bound_node_id: string; expires_at: string | null }>("SELECT token_hash,bound_node_id,expires_at FROM api_tokens WHERE token_id=?1", resolveToken(payload.child_token)!.tokenId!);
  expect(token!.bound_node_id).toBe(payload.child_node_id); expect(token!.token_hash !== payload.child_token).toBe(true);
  expect(token!.expires_at).toBeNull();
  expect(JSON.stringify(db.all("SELECT * FROM session_source_node_deliveries")).includes(payload.child_token)).toBe(false);
  expect(p.delivery.recover(req(human.token), id)?.status).toBe("registration_confirmed");
  expect((await worker.run(payload)).status).toBe("unknown_rotation_required"); expect(launches).toBe(1);
});

test("delivery capability/source/busy/attach-owner checks reject without profile launch or repeat POST", async () => {
  const p = await readyDelivery("delivery_negative"), beforePosts = forkPosts;
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_daemon'", [JSON.stringify({ role: "host_supervisor" })]);
  expect(p.delivery.queue(req(human.token), p.id)).toBeNull();
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_daemon'", [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { source_node_delivery: SOURCE_DELIVERY_CAPABILITY } })]);
  const id = p.delivery.queue(req(human.token), p.id)!;
  expect(p.delivery.take(req(daemon.token), id, "ordinary-create")).toBeNull();
  expect(p.delivery.take(req(source.token), id, SOURCE_DELIVERY_CAPABILITY)).toBeNull();
  const payload = p.delivery.take(req(daemon.token), id, SOURCE_DELIVERY_CAPABILITY)!;
  let launches = 0; const home = mkdtempSync(join(root, "binding-home-"));
  const worker = createSessionSourceProfileWorker({ enabled: true, capability: SOURCE_DELIVERY_CAPABILITY, daemonWorkDir: daemonDir,
    bindingHome: home, hubUrl: "http://isolated.invalid", reader: p.reader, launch: async () => { launches++; }, confirmRegistration: async () => false });
  expect((await worker.run({ ...payload, session_id: "ses_Unselected" })).status).toBe("refused");
  expect((await worker.run({ ...payload, execution: { ...payload.execution, evidence: { ...payload.execution.evidence,
    request: { ...payload.execution.evidence.request, source_node_id: "other_source" } } } })).status).toBe("refused");
  busyDelivery = payload.session_id;
  expect((await worker.run(payload)).status).toBe("refused"); busyDelivery = "";
  const attach = await readyDelivery("delivery_attach", "attach_existing"), attachId = attach.delivery.queue(req(human.token), attach.id)!;
  const attachPayload = attach.delivery.take(req(daemon.token), attachId, SOURCE_DELIVERY_CAPABILITY)!;
  const attachWorker = createSessionSourceProfileWorker({ enabled: true, capability: SOURCE_DELIVERY_CAPABILITY,
    daemonWorkDir: daemonDir, bindingHome: home, hubUrl: "http://isolated.invalid", reader: attach.reader,
    launch: async () => { launches++; }, confirmRegistration: async () => false });
  expect((await attachWorker.run(attachPayload)).status).toBe("refused");
  expect(launches).toBe(0); expect(forkPosts).toBe(beforePosts);
});

test("expired child credential or lost in-memory secret becomes unknown/rotation; never remint or repeat session POST", async () => {
  const p = await readyDelivery("delivery_expiry"), beforePosts = forkPosts;
  const id = p.delivery.queue(req(human.token), p.id)!;
  const r = db.get<{ token_id: string }>("SELECT token_id FROM session_source_node_deliveries WHERE delivery_id=?1", id)!;
  db.run("UPDATE api_tokens SET expires_at=datetime('now','-1 minute') WHERE token_id=?1", [r.token_id]);
  expect(p.delivery.take(req(daemon.token), id, SOURCE_DELIVERY_CAPABILITY)).toBeNull();
  expect(p.delivery.recover(req(human.token), id)?.status).toBe("unknown_rotation_required");
  expect(p.delivery.queue(req(human.token), p.id)).toBeNull();
  const second = await readyDelivery("delivery_secret_lost"), secondId = second.delivery.queue(req(human.token), second.id)!;
  stopBackgroundTimersForTest(); // models Hub restart losing pending blobs only
  const restarted = createSessionSourceDeliveryQueue(second.hub, { enabled: true });
  expect(restarted.take(req(daemon.token), secondId, SOURCE_DELIVERY_CAPABILITY)).toBeNull();
  expect(restarted.recover(req(human.token), secondId)?.status).toBe("unknown_rotation_required");
  expect(restarted.queue(req(human.token), second.id)).toBeNull();
  expect(forkPosts).toBe(beforePosts + 1);
});

test("lost registration ACK leaves a durable no-relaunch claim and revokes unknown credential without session POST", async () => {
  const p = await readyDelivery("delivery_ack_lost"), posts = forkPosts;
  const id = p.delivery.queue(req(human.token), p.id)!;
  const payload = p.delivery.take(req(daemon.token), id, SOURCE_DELIVERY_CAPABILITY)!;
  let launches = 0;
  const makeWorker = () => createSessionSourceProfileWorker({ enabled: true, capability: SOURCE_DELIVERY_CAPABILITY,
    daemonWorkDir: daemonDir, bindingHome: mkdtempSync(join(root, "binding-home-")), hubUrl: "http://isolated.invalid", reader: p.reader,
    launch: async input => { launches++; await registerFromPrivateProfile(JSON.parse(readFileSync(input.configPath, "utf8"))); },
    confirmRegistration: async () => false });
  const outcomes = await Promise.all([makeWorker().run(payload), makeWorker().run(payload)]);
  expect(outcomes.every(v => v.status !== "registration_confirmed")).toBe(true);
  expect(launches).toBe(1);
  expect((await makeWorker().run(payload)).status).toBe("unknown_rotation_required");
  expect(p.delivery.recover(req(human.token), id)?.status).toBe("unknown_rotation_required");
  expect(resolveToken(payload.child_token)).toBeNull();
  expect(p.delivery.queue(req(human.token), p.id)).toBeNull();
  expect(forkPosts).toBe(posts); expect(launches).toBe(1);
});

test("default concrete launcher spawns isolated synthetic child using real shared V2 core and real Hub registration/ACK", async () => {
  const p = await readyDelivery("concrete_launch"), before = forkPosts;
  const id = p.delivery.queue(req(human.token), p.id)!;
  const payload = p.delivery.take(req(daemon.token), id, SOURCE_DELIVERY_CAPABILITY)!;
  const { createSourceResumeLauncher, recoverSourceResumeLaunch } = await import("../../agent-node/src/runtime/source-resume-launcher");
  let child: Awaited<ReturnType<ReturnType<typeof createSourceResumeLauncher>>> | undefined;
  const native = createSourceResumeLauncher({ command: process.execPath,
    argsPrefix: [join(import.meta.dir, "../../agent-node/src/runtime/fixtures/source-resume-child.ts")],
    env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: mkdtempSync(join(root, "child-home-")) }, timeoutMs: 3000 });
  const worker = createSessionSourceProfileWorker({ enabled: true, capability: SOURCE_DELIVERY_CAPABILITY,
    daemonWorkDir: daemonDir, bindingHome: mkdtempSync(join(root, "binding-home-")), reader: p.reader,
    hubUrl: `http://127.0.0.1:${server.port}`, launch: async input => { child = await native(input); return child; },
    confirmRegistration: async (id, token) => p.delivery.confirmRegistration(req(token), id) });
  try {
    expect((await worker.run(payload)).status).toBe("registration_confirmed");
    expect(!!child).toBe(true);
    expect(p.delivery.recover(req(human.token), id)?.status).toBe("registration_confirmed");
    const config = join(project, ".anet", "nodes", payload.child_name, "config.json");
    expect(recoverSourceResumeLaunch(config).session_id).toBe(payload.session_id);
    expect(forkPosts).toBe(before);
  } finally { await child?.stop(); }
  expect(await p.reader.recheck(payload.execution.evidence.lease_id)).toBe(true); // source/Server retained
});

test("actual anet CLI -> exact paired agent-node CLI -> shared V2 resume -> real report_status with synthetic native-package fixture", async () => {
  const p = await readyDelivery("actual_cli_launch"), before = forkPosts;
  const apiPostsBefore = calls.filter(c => /^POST \/api\/session(?:\/|$)/.test(c));
  const id = p.delivery.queue(req(human.token), p.id)!;
  const payload = p.delivery.take(req(daemon.token), id, SOURCE_DELIVERY_CAPABILITY)!;
  // Container-only safe prefix. NOT a downloaded/real OpenCode binary.
  const prefix = mkdtempSync(join(testWorkRoot(), "source-cli-fixture-"));
  const pkg = join(prefix, "node_modules", "@opencode", "cli");
  mkdirSync(join(pkg, "bin"), { recursive: true, mode: 0o700 }); mkdirSync(join(prefix, "bin"), { mode: 0o700 });
  mkdirSync(join(prefix, "safe"), { mode: 0o700 }); mkdirSync(join(prefix, "home"), { mode: 0o700 });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@opencode/cli", version: "2.0.22", bin: { opencode: "bin/opencode.exe" } }));
  writeFileSync(join(pkg, "bin", "opencode.exe"), "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'opencode v2.0.22'; exit 0; fi\nexit 77\n", { mode: 0o700 });
  symlinkSync(join(pkg, "bin", "opencode.exe"), join(prefix, "bin", "opencode"));
  const entry = join(import.meta.dir, "../../agent-node/src/cli.ts");
  const nodePackage = join(prefix, "node_modules", "@sleep2agi", "agent-node");
  mkdirSync(nodePackage, { recursive: true, mode: 0o700 });
  writeFileSync(join(nodePackage, "package.json"), readFileSync(join(import.meta.dir, "../../agent-node/package.json")));
  for (const dep of ["@anthropic-ai", "@openai", "node-pty"]) {
    symlinkSync(join(import.meta.dir, "../../agent-node/node_modules", dep), join(prefix, "node_modules", dep));
  }
  const dist = join(nodePackage, "dist");
  const built = await Bun.build({ entrypoints: [entry], outdir: dist, target: "bun",
    external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "node-pty"] });
  expect(built.success).toBe(true);
  const nativeLaunch = { command: process.execPath,
    argsPrefix: [join(import.meta.dir, "../../agent-network/bin/cli.ts")], env: {
      PATH: `${join(prefix, "bin")}:/usr/local/bin:/usr/bin:/bin`, HOME: join(prefix, "home"),
      ANET_AGENT_NODE_BIN: join(dist, "cli.js"), ANET_OPENCODE_SAFE_BASE: join(prefix, "safe"),
    }, timeoutMs: 6000 };
  const worker = createSessionSourceProfileWorker({ enabled: true, capability: SOURCE_DELIVERY_CAPABILITY,
    daemonWorkDir: daemonDir, bindingHome: join(prefix, "home"), reader: p.reader, hubUrl: `http://127.0.0.1:${server.port}`,
    nativeLaunch,
    confirmRegistration: async (id, token) => p.delivery.confirmRegistration(req(token), id) });
  try {
    const result = await worker.run(payload);
    expect(result.status).toBe("registration_confirmed");
    expect(forkPosts).toBe(before);
    // Fixture multiplexes Hub /api/node-session-control/bridge and native API.
    expect(calls.filter(c => /^POST \/api\/session(?:\/|$)/.test(c))).toEqual(apiPostsBefore);
    const health = JSON.parse(readFileSync(join(project, ".anet", "nodes", payload.child_name, "source-resume-health.json"), "utf8"));
    expect(await worker.stopChild(id)).toBe(true);
    expect(() => process.kill(health.pid, 0)).toThrow();
  } finally { await worker.stopChild(id); rmSync(prefix, { recursive: true, force: true }); }
  expect(await p.reader.recheck(payload.execution.evidence.lease_id)).toBe(true);
}, 20_000);

function transportFixture(fetchOverride?: typeof fetch) {
  sourceTransport = createSessionSourceTransport({ enabled: true });
  db.run("UPDATE nodes SET config_snapshot=?1 WHERE node_id='n_daemon'", [JSON.stringify({ role: "host_supervisor",
    daemon_capabilities: { source_node_delivery: SOURCE_DELIVERY_CAPABILITY, source_fork_transport: SOURCE_FORK_CAPABILITY } })]);
  const base = `http://127.0.0.1:${server.port}`;
  const api = async (token: string, path: string, body?: any) => {
    const response = await fetch(`${base}${SOURCE_FORK_ROOT}${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const value = (intent: string) => ({ network_id: selection.network_id, source_node_id: "n_source", session_id: "ses_Selected",
    mode: "fork_independent", child_name: `http-${intent}`, intent_id: intent });
  const bindingHome = mkdtempSync(join(root, "transport-home-"));
  const worker = createSessionSourceTransportWorker({ hubUrl: base, home: bindingHome, daemonWorkDir: daemonDir,
    nativeLaunch: { command: process.execPath, argsPrefix: [join(import.meta.dir, "../../agent-node/src/runtime/fixtures/source-resume-child.ts")],
      env: { HOME: bindingHome, PATH: "/usr/local/bin:/usr/bin:/bin" }, timeoutMs: 3000 },
    pin: createSessionControlPin({ hubUrl: base, token: daemon.token!, nodeId: "n_daemon", networkId: selection.network_id,
      epoch: 0, currentEpoch: () => 0, currentToken: () => daemon.token!, signal: new AbortController().signal, fetch: fetchOverride }) });
  const binding = { expected: { node_id: "n_daemon", network_id: selection.network_id }, capability: SOURCE_FORK_CAPABILITY,
    instance_id: "11111111-1111-4111-8111-111111111111" };
  return { api, value, worker, binding };
}
test("HTTP source-fork human queue -> frozen daemon poll/read/recheck/execute/deliver -> real token registration -> human poll", async () => {
  const { api, value, worker } = transportFixture();
  await worker.tick(); // explicit capability/instance declaration, not CLI-version inference
  const queued = await api(human.token, "", value("transport-success"));
  expect(queued.status).toBe(200); expect(queued.body.status).toBe("evidence_pending");
  const id = queued.body.request_id;
  try {
    for (let i = 0; i < 4; i++) await worker.tick();
    const polled = await api(human.token, `/${id}?network_id=${selection.network_id}`);
    expect(polled.status).toBe(200); expect(polled.body.status).toBe("registration_confirmed");
    expect(polled.body.child_session_id).toMatch(/^ses_Child/); expect(polled.body.child_node_id).toMatch(/^node_srcd_/);
    expect(JSON.stringify(polled.body)).not.toContain("ntok_");
    expect(forkPosts).toBe(1);
    expect((await api(human.token, "", value("transport-success"))).body.request_id).toBe(id);
    await worker.tick(); expect(forkPosts).toBe(1);
    expect((await api(daemon.token!, `/${id}?network_id=${selection.network_id}`)).status).toBe(403);
    expect((await api(human.token, `/${id}?network_id=wrong`)).status).toBe(403);
    expect((await api(human.token, "", { ...value("transport-success"), child_name: "different" })).status).toBe(409);
    expect(db.get<{ status: string }>("SELECT status FROM node_create_requests WHERE request_id=(SELECT admission_request_id FROM session_source_executions WHERE execution_id=(SELECT execution_id FROM session_source_transports WHERE request_id=?1))", id)?.status).toBe("source_reserved");
  } finally { await worker.stop(); }
}, 15_000);

test("HTTP source-fork refusals carry a diagnostic reason once source permissions are verified", async () => {
  const { api, value, worker } = transportFixture();
  try {
    // Daemon never declared itself (offline / not polling): used to be a bare 409 the app showed as "conflict".
    const offline = await api(human.token!, "", value("reason-offline"));
    expect(offline.status).toBe(409);
    expect(offline.body).toEqual({ ok: false, error: "source_fork_unavailable", reason: "daemon_offline" });
    await worker.tick();
    const queued = await api(human.token!, "", value("reason-reuse"));
    expect(queued.status).toBe(200);
    const reused = await api(human.token!, "", { ...value("reason-reuse"), child_name: "reason-different" });
    expect(reused.status).toBe(409);
    expect(reused.body.reason).toBe("intent_reused");
    // Hand-started source (no daemon created/adopted it): members learn why, outsiders do not.
    const unmanaged = await api(human.token!, "", { ...value("reason-unmanaged"), source_node_id: "n_unmanaged_source" });
    expect(unmanaged.status).toBe(409);
    expect(unmanaged.body).toEqual({ ok: false, error: "source_fork_unavailable", reason: "source_not_managed" });
    const stranger = register("reason_stranger", "Fixture-Strong-4150!");
    const strangerUnmanaged = await api(stranger.token!, "", { ...value("reason-stranger"), source_node_id: "n_unmanaged_source" });
    expect(strangerUnmanaged.status).toBe(409);
    expect(strangerUnmanaged.body.reason).toBeUndefined();
    // Callers without permission on the source still get no reason (no management-state disclosure).
    const outsider = register("reason_outsider", "Fixture-Strong-4150!");
    const foreign = await api(outsider.token!, "", value("reason-foreign"));
    expect(foreign.status).toBe(403);
    expect(foreign.body.reason).toBeUndefined();
  } finally { await worker.stop(); }
}, 15_000);

test("HTTP gate/caller/capability/scope/strict-selection checks; stale auth and daemon restart never requeue claimed work", async () => {
  const { api, value, binding, worker } = transportFixture();
  sourceTransport = createSessionSourceTransport();
  expect((await api(human.token, "", value("gate-off"))).status).toBe(404);
  sourceTransport = createSessionSourceTransport({ enabled: true });
  expect((await api(daemon.token!, "", value("node-human"))).status).toBe(400);
  expect((await api(human.token, "/daemon", binding)).status).toBe(403);
  expect((await api(daemon.token!, "/daemon", { ...binding, expected: { ...binding.expected, network_id: "other" } })).status).toBe(403);
  expect((await api(daemon.token!, "/daemon", { ...binding, capability: "guessed-from-version" })).status).toBe(403);
  db.run("UPDATE sessions SET env_transport='plain' WHERE resume_id='ev_daemon'");
  expect((await api(daemon.token!, "/daemon", binding)).status).toBe(403);
  db.run("UPDATE sessions SET env_transport=NULL WHERE resume_id='ev_daemon'");
  expect((await api(daemon.token!, "/daemon", binding)).status).toBe(403);
  db.run("UPDATE sessions SET env_transport='loopback' WHERE resume_id='ev_daemon'");
  expect((await api(daemon.token!, "/daemon", binding)).status).toBe(200);
  expect((await api(human.token, "", { ...value("raw"), url: "http://127.0.0.1:1", token: "forged" })).status).toBe(400);
  expect((await api(human.token, "", { ...value("attach"), mode: "attach_existing" })).status).toBe(400);
  expect((await api(human.token, "", { ...value("cross"), network_id: "other" })).status).not.toBe(200);
  const outsider = register("http_transport_outsider", "Fixture-Strong-4150!");
  expect((await api(outsider.token!, "", value("foreign-human"))).status).toBe(403);
  const queued = await api(human.token, "", value("lost-task")); expect(queued.status).toBe(200);
  const first = await api(daemon.token!, "/pull", binding); expect(first.body.task.phase).toBe("evidence");
  expect((await api(daemon.token!, "/pull", binding)).body.task).toBeNull();
  const envelope = { ...binding, request_id: queued.body.request_id, intent_id: "wrong", network_id: selection.network_id,
    source_node_id: "n_source", daemon_node_id: "n_daemon", phase: "evidence", result: {} };
  expect((await api(daemon.token!, "/ack", envelope)).status).toBe(403);
  // Different process-local daemon reader cannot recover old leases or restart it.
  await worker.tick();
  expect((await api(daemon.token!, "/daemon", binding)).status).toBe(409); // retired old instance cannot overwrite new
  const poll = await api(human.token, `/${queued.body.request_id}?network_id=${selection.network_id}`);
  expect(poll.body.status).toBe("unknown_rotation_required");
  expect((await api(human.token, "", value("lost-task"))).body.status).toBe("unknown_rotation_required");
  expect(forkPosts).toBe(0);
  await worker.stop();
  // Explicit capability disappearing makes a live token insufficient.
  db.run("UPDATE nodes SET config_snapshot='{}' WHERE node_id='n_daemon'");
  expect((await api(daemon.token!, "/daemon", binding)).status).toBe(403);
}, 10_000);

test("HTTP unknown fork response and Hub reconstruction are read-only convergence: one fork and no remint/replay", async () => {
  const { api, value, worker } = transportFixture();
  await worker.tick(); loseForkResponse = true;
  const queued = await api(human.token, "", value("http-unknown")); expect(queued.status).toBe(200);
  try {
    for (let i = 0; i < 3; i++) await worker.tick();
    expect(forkPosts).toBe(1);
    expect((await api(human.token, `/${queued.body.request_id}?network_id=${selection.network_id}`)).body.status).toBe("unknown_rotation_required");
    const minted = db.get<{ n: number }>("SELECT count(*) AS n FROM api_tokens")!.n;
    sourceTransport = createSessionSourceTransport({ enabled: true }); // no process-local evidence/secret recovery
    loseForkResponse = false;
    await worker.tick();
    expect((await api(human.token, "", value("http-unknown"))).body.status).toBe("unknown_rotation_required");
    expect((await api(human.token, `/${queued.body.request_id}?network_id=${selection.network_id}`)).body.status).toBe("unknown_rotation_required");
    expect(forkPosts).toBe(1); expect(db.get<{ n: number }>("SELECT count(*) AS n FROM api_tokens")!.n).toBe(minted);
  } finally { await worker.stop(); }
}, 10_000);

test("HTTP permission revocation after take blocks ACK and poll; mismatched request evidence and peer daemon token cannot ACK", async () => {
  const { api, value, binding } = transportFixture();
  await api(daemon.token!, "/daemon", binding);
  const queued = await api(human.token, "", value("http-auth")); expect(queued.status).toBe(200);
  const pulled = (await api(daemon.token!, "/pull", binding)).body.task;
  const reader = createSessionSourceEvidenceReader(local()), evidence = await reader.read(pulled.task);
  expect(evidence.ok).toBe(true); if (!evidence.ok) return;
  const envelope = { ...binding, request_id: queued.body.request_id, intent_id: "http-auth", network_id: selection.network_id,
    source_node_id: "n_source", daemon_node_id: "n_daemon", phase: "evidence", result: evidence.evidence };
  expect((await api(source.token!, "/ack", envelope)).status).toBe(403);
  expect((await api(daemon.token!, "/ack", { ...envelope, result: { ...evidence.evidence,
    request: { ...evidence.evidence.request, request_id: "srcq_00000000-0000-4000-8000-000000000000" } } })).status).toBe(400);
  db.run("UPDATE network_members SET role='viewer' WHERE user_id=?1 AND network_id=?2", [human.user!.user_id, selection.network_id]);
  expect((await api(daemon.token!, "/ack", envelope)).status).toBe(403);
  expect((await api(human.token, `/${queued.body.request_id}?network_id=${selection.network_id}`)).status).toBe(403);
  expect(forkPosts).toBe(0);
});

test("HTTP lost one-shot delivery body revokes unknown credential on recovery without remint, refork or launch", async () => {
  let dropped = false;
  const { api, value, worker } = transportFixture((async (input: any, init: any) => {
    const response = await fetch(input, init);
    if (String(input).endsWith(`${SOURCE_FORK_ROOT}/pull`)) {
      const body: any = await response.clone().json();
      if (body.task?.phase === "deliver") { dropped = true; await response.body?.cancel(); return Response.json({ ok: true, task: null }); }
    }
    return response;
  }) as typeof fetch);
  try {
    await worker.tick();
    const queued = await api(human.token, "", value("http-lost-secret")); expect(queued.status).toBe(200);
    for (let i = 0; i < 3; i++) await worker.tick();
    expect(dropped).toBe(true); expect(forkPosts).toBe(1);
    const minted = db.get<{ n: number }>("SELECT count(*) AS n FROM api_tokens")!.n;
    sourceTransport = createSessionSourceTransport({ enabled: true });
    const polled = await api(human.token, `/${queued.body.request_id}?network_id=${selection.network_id}`);
    expect(polled.body.status).toBe("unknown_rotation_required");
    expect(polled.body.child_node_id).toMatch(/^node_srcd_/);
    expect(db.get<{ revoked_at: string | null }>(`SELECT t.revoked_at FROM api_tokens t JOIN session_source_node_deliveries d ON d.token_id=t.token_id
      JOIN session_source_transports r ON r.delivery_id=d.delivery_id WHERE r.request_id=?1`, queued.body.request_id)?.revoked_at).not.toBeNull();
    await worker.tick();
    expect((await api(human.token, "", value("http-lost-secret"))).body.status).toBe("unknown_rotation_required");
    expect(forkPosts).toBe(1); expect(db.get<{ n: number }>("SELECT count(*) AS n FROM api_tokens")!.n).toBe(minted);
  } finally { await worker.stop(); }
}, 10_000);
