import { afterAll, beforeAll, expect, test } from "bun:test";
import { addNetworkMember, createNetworkTokenForNode, createToken, register } from "./auth.js";
import { backfillMessageNodeIds, db } from "./db.js";

if (!process.env.COMMHUB_DB && !process.env.COMMHUB_TEST_PG_URL) throw new Error("isolated database required");
const stamp = `${process.pid}_${Date.now()}`;
type Caller = { label: string; token: string; username: string; userId: string };
type Transport = "rest" | "mcp";
let server: any, base: string, net: string, foreignNet: string;
let owner: Caller, member: Caller, admin: Caller, viewer: Caller;
let callers: Caller[] = [];
let nodeToken: string;
const target = `sender-target-${stamp}`;
const memberNode = `sender-owned-${stamp}`;
const targetId = `n_sender_target_${stamp}`;
const memberNodeId = `n_sender_owned_${stamp}`;
const collisionId = `n_sender_collision_${stamp}`;
let markerSeq = 0;

function user(label: string): Caller & { networkId: string } {
  const username = `sender_${label}_${stamp}`;
  const r = register(username, "SenderFixturePass123!", undefined, "seed");
  if (!r.ok || !r.user || !r.token || !r.network_id) throw new Error("fixture registration failed");
  return { label, token: r.token, username, userId: r.user.user_id, networkId: r.network_id };
}

function node(alias: string, id: string, ownerId: string, status = "idle") {
  const r = createNetworkTokenForNode(ownerId, net, alias, id);
  if (!r.ok || !r.token) throw new Error("fixture node registration failed");
  db.run(`INSERT INTO sessions (resume_id, alias, node_id, network_id, status, last_seen_at)
    VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'))`, [`resume_${id}`, alias, id, net, status]);
  return r.token;
}

beforeAll(async () => {
  const first = user("owner"); owner = first; net = first.networkId;
  const second = user("member"); member = second; foreignNet = second.networkId;
  admin = user("admin"); viewer = user("viewer");
  db.run("UPDATE users SET role = 'user' WHERE user_id IN (?1, ?2, ?3)", [owner.userId, member.userId, viewer.userId]);
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", admin.userId);
  for (const [c, role] of [[member, "member"], [admin, "admin"], [viewer, "viewer"]] as const) {
    expect(addNetworkMember(net, c.userId, role, owner.userId, { agentAccess: "all" }).ok).toBe(true);
  }
  node(target, targetId, owner.userId);
  nodeToken = node(memberNode, memberNodeId, member.userId);
  // Legacy rows may predate the current username reservation on node creation.
  db.run(`INSERT INTO nodes (node_id, alias, node_name, network_id, owner_user_id)
    VALUES (?1, ?2, ?2, ?3, ?4)`, [collisionId, member.username, net, owner.userId]);
  db.run(`INSERT INTO sessions (resume_id, alias, node_id, network_id, status, last_seen_at)
    VALUES (?1, ?2, ?3, ?4, 'blocked', datetime('now'))`, [`resume_${collisionId}`, member.username, collisionId, net]);
  db.run(`INSERT INTO tasks (task_id, from_name, to_name, to_node_id, network_id, status, content)
    VALUES (?1, 'hub', ?2, ?3, ?4, 'delivered', 'fixture pending')`, [`parent_${stamp}`, member.username, collisionId, net]);
  const plain = createToken(member.userId, "sender-cli");
  const scoped = createToken(member.userId, "sender-scoped", net);
  const named = createToken(member.userId, `node:${memberNode}`, net);
  expect([plain.ok, scoped.ok, named.ok]).toEqual([true, true, true]);
  callers = [owner, member, admin,
    { ...member, label: "atok-cli", token: plain.token! },
    { ...member, label: "atok-network", token: scoped.token! },
    { ...member, label: "atok-named", token: named.token! }];
  const mod = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
}, 30_000);

afterAll(() => { server?.stop(true); });

async function dispatch(transport: Transport, token: string, requested?: string, networkId = net) {
  const marker = `sender-case-${stamp}-${++markerSeq}`;
  const args: Record<string, unknown> = { alias: target, task: marker, network_id: networkId, meta: { source: "sender-fixture" } };
  if (requested !== undefined) args[transport === "rest" ? "from" : "from_session"] = requested;
  const res = await fetch(`${base}${transport === "rest" ? "/api/task" : "/mcp"}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" },
    body: JSON.stringify(transport === "rest" ? args : {
      jsonrpc: "2.0", id: markerSeq, method: "tools/call", params: { name: "send_task", arguments: args },
    }),
  });
  const text = await res.text();
  const data = text.split("\n").filter(s => s.startsWith("data:"));
  const payload = JSON.parse(data.length ? data.at(-1)!.slice(5).trim() : text);
  const body = transport === "rest" ? payload : JSON.parse(payload.result.content[0].text);
  const task = db.get<{ from_name: string; from_node_id: string | null; parent_task_id: string | null; meta_json: string }>(
    "SELECT from_name, from_node_id, parent_task_id, meta_json FROM tasks WHERE content = ?1", marker);
  const inbox = db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM inbox WHERE content = ?1", marker);
  return { status: res.status, body, task, inboxCount: Number(inbox?.n ?? 0) };
}

for (const transport of ["rest", "mcp"] as const) {
  for (const label of ["owner", "member", "admin", "atok-cli", "atok-network", "atok-named"]) {
    test(`authenticated sender: ${transport} ${label} uses its username`, async () => {
      const c = callers.find(c => c.label === label)!;
      for (const from of [undefined, `  ${c.username}  `, ""]) {
        const r = await dispatch(transport, c.token, from);
        expect(r.body.task_id ?? r.body.message_id).toBeTruthy();
        expect(r.task).toMatchObject({ from_name: c.username, from_node_id: null, parent_task_id: null });
        expect(JSON.parse(r.task!.meta_json).auth_origin).toBe("user");
        expect(r.inboxCount).toBe(1);
      }
    });
    test(`authenticated sender: ${transport} ${label} rejects another identity without writes`, async () => {
      const c = callers.find(c => c.label === label)!;
      for (const from of [memberNode, "hub", "api", `other-${stamp}`]) {
        const r = await dispatch(transport, c.token, from);
        if (transport === "rest") expect(r.status).toBe(403);
        expect(r.body).toMatchObject({ ok: false, error: "from_session_identity_mismatch" });
        expect(r.task).toBeNull();
        expect(r.inboxCount).toBe(0);
      }
    });
  }
  test(`authenticated sender: ${transport} node token retains node attribution`, async () => {
    const r = await dispatch(transport, nodeToken, memberNode);
    expect(r.body.task_id ?? r.body.message_id).toBeTruthy();
    expect(r.task).toMatchObject({ from_name: memberNode, from_node_id: memberNodeId });
    expect(JSON.parse(r.task!.meta_json).auth_origin).toBe("node");
  });
  test(`authenticated sender: ${transport} keeps viewer and network permissions`, async () => {
    for (const [token, network] of [[viewer.token, net], [owner.token, foreignNet]]) {
      const r = await dispatch(transport, token, undefined, network);
      expect(r.body.ok).not.toBe(true);
      expect(r.task).toBeNull();
      expect(r.inboxCount).toBe(0);
    }
  });
  test(`authenticated sender: ${transport} does not change a same-named node's state`, async () => {
    const r = await dispatch(transport, member.token);
    expect(r.task?.from_node_id).toBeNull();
    expect(r.task?.parent_task_id).toBeNull();
    expect(db.get<{ status: string }>("SELECT status FROM sessions WHERE node_id = ?1", collisionId)?.status).toBe("blocked");
  });
  test(`authenticated sender: ${transport} preserves human attribution during backfill`, async () => {
    await dispatch(transport, member.token);
    backfillMessageNodeIds();
    expect(db.all<{ from_node_id: string | null }>(
      "SELECT from_node_id FROM tasks WHERE from_name = ?1", member.username).every(t => t.from_node_id === null)).toBe(true);
    const legacyId = `legacy_sender_${transport}_${stamp}`;
    db.run(`INSERT INTO tasks (task_id, from_name, to_name, network_id, content)
      VALUES (?1, ?2, ?3, ?4, 'legacy fixture')`, [legacyId, memberNode, target, net]);
    backfillMessageNodeIds();
    expect(db.get<{ from_node_id: string | null }>("SELECT from_node_id FROM tasks WHERE task_id = ?1", legacyId)?.from_node_id).toBe(memberNodeId);
  });
}
