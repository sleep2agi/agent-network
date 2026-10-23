import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "anet-session-control-"));
process.env.COMMHUB_DB ||= join(dir, "hub.db");
const root = "/api/node-session-control";
let server: any, base: string, db: any, net: string, otherNet: string;
let owner: any, admin: any, member: any, outsider: any, ntok: any, peer: any;
let legacyOwner: any, legacyAdmin: any, legacyMember: any, legacyOutsider: any, legacyFull: any, legacyNetwork: any;
let binding = { session_id: "session_1", binding_id: "binding_1" }, serial = 0;
const nodeId = "n_session_control", peerId = "n_session_control_peer";
async function api(token: string, path: string, value?: unknown, method?: string) {
  const res = await fetch(`${base}${path}`, { method: method ?? (value === undefined ? "GET" : "POST"),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  return { status: res.status, body: await res.json() as any };
}
const registerBridge = (v = binding, token = ntok.token!) => api(token, `${root}/bridge`,
  { ...v, expected: { node_id: nodeId, network_id: net } });
const enqueue = (operation = "background", extra = {}) => api(owner.token!, root,
  { network_id: net, node_id: nodeId, operation, expected: binding, ...extra });
const pull = (token = ntok.token!, v = binding) => api(token, `${root}/pull`, v);
const read = (request: string, token = owner.token!, network = net) => api(token, `${root}/${request}?network_id=${network}`);
const state = () => ({ ...binding, supported: true, active: true, can_request_background: true, observed_at: Date.now() });
const ack = (request: string, result: unknown, extra = {}) => api(ntok.token!, `${root}/${request}/ack`,
  { ...binding, status: "done", result, ...extra });

beforeAll(async () => {
  ({ db } = await import("./db.js"));
  const { register, addNetworkMember, createNetworkTokenForNode, createToken } = await import("./auth.js");
  const stamp = Date.now();
  admin = register(`sc_admin_${stamp}`, "SessionControl-Test-1!");
  owner = register(`sc_owner_${stamp}`, "SessionControl-Test-2!");
  member = register(`sc_member_${stamp}`, "SessionControl-Test-3!");
  outsider = register(`sc_other_${stamp}`, "SessionControl-Test-4!");
  expect(admin.ok && owner.ok && member.ok && outsider.ok).toBe(true);
  net = admin.network_id!; otherNet = outsider.network_id!;
  for (const u of [owner, member]) expect(addNetworkMember(net, u.user.user_id, "member", admin.user.user_id, { agentAccess: "all" }).ok).toBe(true);
  // Real atok hashes via the legacy issuer; only fixture rows are converted
  // to the historical global scope=user shape. No prefix-based authority.
  const legacyUser = (u: any) => {
    const t = createToken(u.user.user_id, "sc-legacy-user");
    expect(t.ok).toBe(true);
    expect(t.token).toMatch(/^atok_/);
    db.run("UPDATE api_tokens SET scope='user' WHERE token_id=?1", t.token_id);
    return t;
  };
  legacyOwner = legacyUser(owner); legacyAdmin = legacyUser(admin);
  legacyMember = legacyUser(member); legacyOutsider = legacyUser(outsider);
  legacyFull = createToken(owner.user.user_id, "sc-legacy-global-full");
  legacyNetwork = createToken(owner.user.user_id, "sc-legacy-network", net);
  expect(legacyFull.ok && legacyNetwork.ok).toBe(true);
  ntok = createNetworkTokenForNode(owner.user.user_id, net, "sc-target", nodeId);
  peer = createNetworkTokenForNode(owner.user.user_id, net, "sc-peer", peerId);
  expect(ntok.ok && peer.ok).toBe(true);
  db.run("INSERT INTO sessions(resume_id,alias,node_id,network_id,status) VALUES (?1,?2,?3,?4,'idle')", ["r_sc_target", "sc-target", nodeId, net]);
  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);
beforeEach(async () => {
  binding = { session_id: `session_${++serial}`, binding_id: `binding_${serial}` };
  expect((await registerBridge()).status).toBe(200);
});
afterEach(() => setSystemTime());
afterAll(() => { server?.stop(true); rmSync(dir, { recursive: true, force: true }); });

describe("#2017 human-to-exact-Bridge HTTP relay", () => {
  test("[2017 identity] missing or malformed expected is refused without fallback", async () => {
    for (const expected of [undefined, {}, { node_id: nodeId }, { node_id: nodeId, network_id: net, token_id: ntok.token_id }]) {
      const rejected = await api(ntok.token!, `${root}/bridge`, { ...binding, expected });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe("session_control_request_invalid");
    }
    expect((await registerBridge()).status).toBe(200);
  });
  test("[2017 identity] A credential expected B cannot sweep, replace or retire the valid binding", async () => {
    const made = await enqueue("state"), clock = Date.now();
    const tokenBefore = db.get("SELECT token_id,bound_node_id,network_id FROM api_tokens WHERE token_id=?1", ntok.token_id);
    const nodeBefore = db.get("SELECT node_id,network_id,owner_user_id FROM nodes WHERE node_id=?1", nodeId);
    // Advancing beyond the request deadline exposes an accidental sweep before
    // rejecting expected. Restore only the clock, never the authoritative queue.
    setSystemTime(new Date(clock + 16_000));
    for (const expected of [{ node_id: peerId, network_id: net }, { node_id: nodeId, network_id: otherNet }]) {
      const rejected = await api(ntok.token!, `${root}/bridge`, {
        session_id: "would_replace_session", binding_id: "would_retire_binding", expected,
      });
      expect(rejected.status).toBe(409);
      expect(rejected.body.error).toBe("session_control_changed");
    }
    setSystemTime(new Date(clock));
    expect((await read(made.body.request_id)).body.status).toBe("pending");
    expect((await registerBridge()).status).toBe(200); // Original generation was not retired.
    expect((await pull()).body.request).toMatchObject({ request_id: made.body.request_id, ...binding });
    expect(db.get("SELECT token_id,bound_node_id,network_id FROM api_tokens WHERE token_id=?1", ntok.token_id)).toEqual(tokenBefore);
    expect(db.get("SELECT node_id,network_id,owner_user_id FROM nodes WHERE node_id=?1", nodeId)).toEqual(nodeBefore);
  });
  test("[2017 identity] success carries the authenticated token row identity, never credential material", async () => {
    const response = await registerBridge();
    const row = db.get("SELECT token_id,bound_node_id,network_id FROM api_tokens WHERE token_id=?1", ntok.token_id);
    expect(response.status).toBe(200);
    expect(response.body.identity).toEqual({ node_id: row.bound_node_id, network_id: row.network_id, token_id: row.token_id });
    expect(Object.keys(response.body).sort()).toEqual(["expires_at", "identity", "ok"]);
    expect(JSON.stringify(response.body)).not.toContain(ntok.token);
  });
  test("normal state and background receipts are separate from actual tool completion", async () => {
    const s = await enqueue("state");
    expect(s.body).toMatchObject({ ok: true, status: "pending" });
    expect(s.body.request_id).toMatch(/^sc_\d{13}_[A-Za-z0-9_-]{8,64}$/);
    expect((await pull()).body.request).toMatchObject({ request_id: s.body.request_id, operation: "state", ...binding });
    const observed = state();
    expect((await ack(s.body.request_id, observed)).body.status).toBe("done");
    expect((await read(s.body.request_id)).body.result).toEqual(observed);
    const b = await enqueue();
    expect(b.body.request_id).toMatch(/^bg_\d{13}_[A-Za-z0-9_-]{8,64}$/);
    expect(b.body.expires_at).toBeGreaterThan(Date.now());
    await pull();
    const result = { outcome: "request_processed", state: state() };
    expect((await ack(b.body.request_id, result)).body.status).toBe("done");
    expect((await read(b.body.request_id)).body).toMatchObject({ ok: true, status: "done", result });
  });
  test("[2017 review] already_idle cannot confirm an active or background-capable state", async () => {
    for (const flags of [
      { active: true, can_request_background: true },
      { active: true, can_request_background: false },
      { active: false, can_request_background: true },
    ]) {
      const made = await enqueue(); await pull();
      const reply = await ack(made.body.request_id, { outcome: "already_idle", state: { ...state(), ...flags } });
      expect(reply.status).toBe(400);
      expect(reply.body.error).toBe("session_control_invalid_response");
      expect((await read(made.body.request_id)).body).toMatchObject({ status: "unknown", error: "session_control_invalid_response" });
    }
  });
  test("[2017 review] legacy user atok owner/admin and global full can create and read control", async () => {
    for (const t of [legacyOwner, legacyAdmin, legacyFull]) {
      for (const operation of ["state", "background"]) {
        const made = await api(t.token, root, { network_id: net, node_id: nodeId, operation, expected: binding });
        expect(made.status).toBe(200);
        expect((await read(made.body.request_id, t.token)).body.status).toBe("pending");
        expect((await pull()).body.request.request_id).toBe(made.body.request_id);
        const result = operation === "state" ? state() : { outcome: "request_processed", state: state() };
        expect((await ack(made.body.request_id, result)).body.status).toBe("done");
        expect((await read(made.body.request_id, t.token)).body.result).toEqual(result);
      }
    }
  });
  test("[2017 review] legacy atok still requires current target ownership and exact network", async () => {
    for (const t of [legacyMember, legacyOutsider]) {
      expect((await api(t.token, root, { network_id: net, node_id: nodeId, operation: "state" })).status).toBe(403);
    }
    expect((await api(legacyOwner.token, root, { network_id: otherNet, node_id: nodeId, operation: "state" })).status).toBe(403);
    const made = await enqueue("state");
    for (const t of [legacyMember, legacyOutsider]) expect((await read(made.body.request_id, t.token)).status).toBe(403);
    expect((await read(made.body.request_id, legacyOwner.token, otherNet)).status).toBe(403);
  });
  test("[2017 review] legacy atok user and unbound network credentials cannot impersonate Bridge", async () => {
    const made = await enqueue("state");
    for (const t of [legacyOwner, legacyAdmin, legacyFull, legacyNetwork]) {
      expect((await registerBridge(binding, t.token)).status).toBe(403);
      expect((await pull(t.token)).status).toBe(403);
      expect((await api(t.token, `${root}/${made.body.request_id}/ack`, { ...binding, status: "done", result: state() })).status).toBe(403);
    }
    expect((await read(made.body.request_id)).body.status).toBe("pending");
    expect((await pull()).body.request.request_id).toBe(made.body.request_id);
  });
  test("[2017 review] unknown, revoked, expired or unsupported-scope credentials stay refused", async () => {
    const request = () => api(legacyOwner.token, root, { network_id: net, node_id: nodeId, operation: "state" });
    expect((await api("atok_00000000000000000000000000000000", root, {})).status).toBe(401);
    for (const patch of ["revoked_at=datetime('now')", "expires_at=datetime('now','-1 day')", "scope='unsupported'"]) {
      db.run(`UPDATE api_tokens SET ${patch} WHERE token_id=?1`, legacyOwner.token_id);
      try { expect((await request()).status).toBeGreaterThanOrEqual(400); }
      finally { db.run("UPDATE api_tokens SET revoked_at=NULL,expires_at=NULL,scope='user' WHERE token_id=?1", legacyOwner.token_id); }
    }
    expect((await request()).status).toBe(200);
  });
  test("SSE is a scoped doorbell only; the request lives in pull", async () => {
    const abort = new AbortController();
    const response = await fetch(`${base}/events/sc-target`, { headers: { authorization: `Bearer ${ntok.token}` }, signal: abort.signal });
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    try {
      const made = await enqueue();
      let data = "";
      for (let i = 0; i < 4 && !data.includes('"type":"session_control"'); i++) {
        const next = await reader.read(); data += new TextDecoder().decode(next.value);
      }
      const event = data.split("\n").filter(s => s.startsWith("data: ")).map(s => JSON.parse(s.slice(6))).find(s => s.type === "session_control");
      expect(event).toEqual({ type: "session_control", request_id: made.body.request_id });
      expect((await pull()).body.request.request_id).toBe(made.body.request_id);
    } finally { abort.abort(); await reader.cancel().catch(() => {}); }
  });
  test("node, peer, anonymous, master and member cannot impersonate human owner/admin", async () => {
    for (const token of [ntok.token, peer.token, "", "legacy-test-only", member.token, outsider.token]) {
      expect((await api(token, root, { network_id: net, node_id: nodeId, operation: "state" })).status).toBeGreaterThanOrEqual(400);
    }
    const adminMade = await api(admin.token!, root, { network_id: net, node_id: nodeId, operation: "state" });
    expect(adminMade.status).toBe(200);
    expect((await read(adminMade.body.request_id, member.token!)).status).toBe(403);
    expect((await read(adminMade.body.request_id, ntok.token!)).status).toBe(403);
    expect((await read(adminMade.body.request_id, owner.token!, otherNet)).status).toBe(403);
  });
  test("cross-network, wrong expected, absent expected and command/path keys are refused", async () => {
    expect((await enqueue("background", { network_id: otherNet })).status).toBe(403);
    expect((await enqueue("background", { expected: { ...binding, session_id: "other_session" } })).body.error).toBe("session_control_changed");
    expect((await api(owner.token!, root, { network_id: net, node_id: nodeId, operation: "background" })).status).toBe(400);
    for (const key of ["url", "path", "keys", "shell"]) expect((await enqueue("state", { [key]: "unsafe" })).status).toBe(400);
    expect((await registerBridge({ ...binding, node_id: peerId } as any)).status).toBe(400);
  });
  test("peer token and legacy unbound token never receive target requests", async () => {
    const { createNetworkTokenForNode } = await import("./auth.js");
    const legacy = createNetworkTokenForNode(owner.user.user_id, net, "sc-unbound");
    expect(legacy.ok).toBe(true);
    // Same-holder refreshes now bind existing rows. Construct an actual old
    // unbound credential whose name only hints at this target instead.
    db.run("UPDATE api_tokens SET name='node:sc-target' WHERE token_id=?1", legacy.token_id);
    expect(db.get("SELECT bound_node_id FROM api_tokens WHERE token_id=?1", legacy.token_id).bound_node_id).toBeNull();
    expect((await registerBridge(binding, legacy.token!)).status).toBe(403);
    expect((await registerBridge(binding, owner.token!)).status).toBe(403);
    const made = await enqueue();
    expect((await pull(peer.token!)).body.request).toBeUndefined();
    expect((await pull()).body.request.request_id).toBe(made.body.request_id);
    expect((await api(peer.token!, `${root}/${made.body.request_id}/ack`, { ...binding, status: "done", result: state() })).status).toBe(409);
  });
  test("concurrent claims yield exactly one delivery and do not replay", async () => {
    const made = await enqueue();
    expect((await enqueue()).status).toBe(429);
    const claims = await Promise.all([pull(), pull(), pull()]);
    expect(claims.filter(r => r.body.request?.request_id === made.body.request_id)).toHaveLength(1);
    expect((await read(made.body.request_id)).body.status).toBe("in_progress");
    expect((await pull()).body.request).toBeNull();
  });
  test("expired pending request is never delivered", async () => {
    const made = await enqueue();
    setSystemTime(new Date(Date.now() + 16_000));
    expect((await pull()).body.request).toBeNull();
    expect((await read(made.body.request_id)).body.status).toBe("expired");
  });
  test("lost ACK becomes unknown, never success; late ACK and repeated pull cannot replay", async () => {
    const made = await enqueue(); await pull();
    setSystemTime(new Date(Date.now() + 16_000));
    expect((await read(made.body.request_id)).body).toMatchObject({ status: "unknown", error: "session_background_outcome_unknown" });
    expect((await ack(made.body.request_id, { outcome: "request_processed", state: state() })).status).toBe(409);
    expect((await pull()).body.request).toBeNull();
  });
  test("new generation invalidates pending and cannot be overwritten by delayed old Bridge", async () => {
    const old = { ...binding }, made = await enqueue();
    binding = { session_id: "new_session", binding_id: `new_binding_${serial}` };
    expect((await registerBridge()).status).toBe(200);
    expect((await registerBridge(old)).body.error).toBe("session_control_changed");
    expect((await pull(ntok.token!, old)).body.error).toBe("session_control_changed");
    expect((await read(made.body.request_id)).body).toMatchObject({ status: "failed", error: "session_control_changed" });
    expect((await pull()).body.request).toBeNull();
  });
  test("handle change after claim is unknown and old-session ACK cannot complete", async () => {
    const old = { ...binding }, made = await enqueue(); await pull();
    binding = { ...binding, binding_id: `changed_${serial}` }; await registerBridge();
    expect((await api(ntok.token!, `${root}/${made.body.request_id}/ack`, { ...old, status: "done", result: { outcome: "already_idle", state: { ...state(), ...old } } })).status).toBe(409);
    expect((await read(made.body.request_id)).body.status).toBe("unknown");
  });
  test("requester revocation before pull prevents delivery and current read permission is rechecked", async () => {
    const made = await enqueue();
    db.run("UPDATE network_members SET role='member' WHERE network_id=?1 AND user_id=?2", [net, owner.user.user_id]);
    db.run("UPDATE nodes SET owner_user_id=?1 WHERE node_id=?2", [member.user.user_id, nodeId]);
    try {
      expect((await pull()).body.request).toBeNull();
      expect((await read(made.body.request_id)).status).toBe(403);
      expect((await read(made.body.request_id, admin.token!)).body.status).toBe("failed");
    } finally { db.run("UPDATE nodes SET owner_user_id=?1 WHERE node_id=?2", [owner.user.user_id, nodeId]); }
  });
  test("target token revocation is checked at pull, not only registration", async () => {
    const made = await enqueue();
    db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1", ntok.token_id);
    try {
      expect((await pull()).status).toBeGreaterThanOrEqual(400);
      expect((await read(made.body.request_id)).body.status).toBe("failed");
    } finally { db.run("UPDATE api_tokens SET revoked_at=NULL WHERE token_id=?1", ntok.token_id); }
  });
  test("malformed runtime results and raw exception strings never become success or leak", async () => {
    const made = await enqueue(); await pull();
    const reply = await ack(made.body.request_id, { outcome: "request_processed", state: { ...state(), binding_id: "wrong" } });
    expect(reply.status).toBe(400);
    expect((await read(made.body.request_id)).body).toMatchObject({ status: "unknown", error: "session_control_invalid_response" });
    const next = await enqueue(); await pull();
    const secret = "http://secret-host/?token=ntok_secret";
    expect((await api(ntok.token!, `${root}/${next.body.request_id}/ack`, { ...binding, status: "failed", error: secret })).body.error).toBe("session_control_invalid_response");
    expect(JSON.stringify((await read(next.body.request_id)).body)).not.toContain(secret);
  });
  test("known runtime refusal is failed; already_idle receipt is accepted", async () => {
    const made = await enqueue(); await pull();
    expect((await api(ntok.token!, `${root}/${made.body.request_id}/ack`, { ...binding, status: "failed", error: "session_control_unsupported" })).body.status).toBe("failed");
    const next = await enqueue(); await pull();
    expect((await ack(next.body.request_id, { outcome: "already_idle", state: { ...state(), active: false, can_request_background: false } })).body.status).toBe("done");
  });
  test("lease expiry refuses new work and Hub restart loses IDs without replay", async () => {
    const made = await enqueue();
    setSystemTime(new Date(Date.now() + 76_000));
    // #2014: no live bridge is its own code, so a client can tell "this node has no
    // bridge (upgrade / start it)" from a permission refusal.
    expect((await enqueue()).body.error).toBe("session_control_bridge_missing");
    setSystemTime();
    server.stop(true);
    const { bootServer } = await import("./server.js");
    server = bootServer({ port: 0, hostname: "127.0.0.1" }); base = `http://127.0.0.1:${server.port}`;
    expect((await read(made.body.request_id)).status).toBe(404);
    expect((await pull()).body.error).toBe("session_control_changed");
  });
});
