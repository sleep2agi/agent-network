// Caller identity goes through one resolver (resolveNodeCaller).
//
// Real HTTP, both SQLite and PostgreSQL:
//   cd server && COMMHUB_DB=/tmp/x.db bun test src/node-caller-identity-http.test.ts
//   PG: COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1
//       (tests/node-caller-identity runs both, plus six mutations)
//
// An unbound token with zero rows keeps the name in the token. First
// registration still depends on that. A bound token whose row is gone is
// refused and must not fall back to the name. Several rows with one alias
// are not refused outright for an unbound token: the issuer's own row wins,
// then the node_id on the latest session. Still not unique, then refuse.
// The mutation harness deletes the shared owner check and expects every
// "caller identity boundary:" test to go assertion-red together (12). A
// second mutation restores a name lookup for a missing bound row and expects
// "bound row missing does not fall back to the name" to go red. A third
// drops the single-owner shortcut and expects the duplicate-alias heartbeat
// to go red. A fourth treats every failed ntok_ resolve as impersonation
// and expects "registration network token signs as the username" to go red.
// A fifth drops the ownerless-row compatibility and expects "duplicate
// ownerless row keeps an unbound epoch 0 token online" to go red. A sixth
// treats not_a_node_token on REST as impersonation and expects "unreported
// registration token signs as api" to go red. New tests must not use the
// "caller identity boundary:" prefix.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db, generateNetworkToken, hashToken } from "./db.js";
import { createTaskRuntimeEvidenceReporter, taskActivityPayload } from "../../agent-node/src/task-runtime-evidence";

const dir = mkdtempSync(join(tmpdir(), "anet-caller-identity-"));
const activeDbPath = process.env.COMMHUB_DB ?? (process.env.COMMHUB_TEST_PG_URL ? "postgres" : undefined);
if (!activeDbPath) throw new Error("node-caller-identity requires COMMHUB_DB (or COMMHUB_TEST_PG_URL) before module import");

const stamp = Date.now().toString(36);
let server: any;
let base = "";
let ownerToken = "";
let ownerId = "";
let outsiderId = "";
let NET = "";
let NET2 = "";

const victimAlias = `idvvic${stamp}`;
const otherAlias = `idvoth${stamp}`;
const sinkAlias = `idvsnk${stamp}`;
const sharedAlias = `idvshr${stamp}`;
const sink2Alias = `idvsk2${stamp}`;
const freshAlias = `idvfrs${stamp}`;
const ownerlessAlias = `idvoln${stamp}`;
const dupAlias = `idvdup${stamp}`;
const victimId = `n_idv_vic_${stamp}`;
const otherId = `n_idv_oth_${stamp}`;
const sinkId = `n_idv_snk_${stamp}`;
const sharedId = `n_idv_shr_${stamp}`;
const shared2Id = `n_idv_sh2_${stamp}`;
const sink2Id = `n_idv_sk2_${stamp}`;
const freshId = `n_idv_frs_${stamp}`;
const ownerlessId = `n_idv_oln_${stamp}`;
const missingBoundId = `n_idv_gone_${stamp}`;

type Tok = { token: string; tokenId: string };
let victimTok: Tok;
let otherTok: Tok;
let squatter: Tok;
let boundMissing: Tok;
let freshTok: Tok;
let ownerlessTok: Tok;
let dupTok: Tok;
let sharedHome: Tok;
let sharedForeign: Tok;
let p10Owner: Tok;

type Sub = { events: any[]; done: boolean; abort: () => void; ready: Promise<void> };
const openSubs: Sub[] = [];

for (const transport of ["mcp", "rest"] as const) {
  for (const shape of ["bound duplicate", "unbound duplicate", "no session", "other network"] as const) {
    test(`node attribution: ${transport} ${shape} retains the credential's node ID`, async () => {
      const key = `${transport}-${shape.replaceAll(" ", "-")}-${stamp}`;
      const alias = `idvsender-${key}`;
      const mine = `n_idv_sender_${key}`;
      const member = register(`idvmem-${key}`, "CallerMember123!", undefined, "seed");
      if (!member.ok || !member.user) throw new Error("member fixture failed");
      const memberId = member.user.user_id;
      const joined = addNetworkMember(NET, memberId, "member", ownerId, { agentAccess: "all" });
      if (!joined.ok) throw new Error(joined.error);
      seedNode(mine, alias, NET, memberId);
      if (shape.includes("duplicate")) {
        const ownerNode = `n_idv_owner_${key}`;
        seedNode(ownerNode, alias, NET, ownerId);
        seedSession(ownerNode, alias, NET); // the active session belongs to a different row
      }
      if (shape === "other network") {
        const foreignNode = `n_idv_foreign_${key}`;
        seedNode(foreignNode, alias, NET2, outsiderId);
        seedSession(foreignNode, alias, NET2);
      }
      const tok = mint(memberId, NET, shape === "bound duplicate" ? victimAlias : alias,
        shape === "unbound duplicate" ? 0 : 2, shape === "unbound duplicate" ? null : mine);
      const content = `sender identity ${key}`;
      const sent = transport === "mcp"
        ? await mcpSend(tok.token, content, undefined)
        : (await api(tok.token, "POST", "/api/task", { alias: sinkAlias, task: content, network_id: NET })).body;
      expect(sent.ok).toBe(true);
      const row = db.get("SELECT from_name, from_node_id, network_id FROM tasks WHERE content = ?1", content);
      expect(row).toEqual({ from_name: alias, from_node_id: mine, network_id: NET });
    });
  }
}

for (const owner of ["own", "another"] as const) {
  test(`rename registry: prepare rejects ${owner} node without a session`, async () => {
    const target = `idvreserved-${owner}-${stamp}`;
    seedNode(`n_idv_reserved_${owner}_${stamp}`, target, NET, owner === "own" ? ownerId : outsiderId);
    const before = db.get("SELECT COUNT(*) AS n FROM rename_txn");
    const result = await api(ownerToken, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: victimAlias, new_alias: target });
    expect(result.status).toBe(400);
    expect(result.body.ok).toBe(false);
    expect(db.get("SELECT COUNT(*) AS n FROM rename_txn")).toEqual(before);
    expect(sessionSnap(victimAlias, NET)?.node_id).toBe(victimId);
  });
}

test("rename registry: commit rejects a node created after prepare", async () => {
  const target = `idvrace-${stamp}`;
  const prepared = await api(ownerToken, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: victimAlias, new_alias: target });
  expect(prepared.body.ok).toBe(true);
  const nodeId = `n_idv_race_${stamp}`;
  seedNode(nodeId, target, NET, outsiderId);
  const result = await api(ownerToken, "POST", "/api/node-rename/commit", { txn_id: prepared.body.txn_id });
  expect(result.status).toBe(400);
  expect(result.body.ok).toBe(false);
  expect(sessionSnap(victimAlias, NET)?.node_id).toBe(victimId);
  expect(db.get("SELECT alias FROM nodes WHERE node_id = ?1", nodeId)).toEqual({ alias: target });
  expect(db.get("SELECT status FROM rename_txn WHERE txn_id = ?1", prepared.body.txn_id)).toEqual({ status: "prepared" });
  await api(ownerToken, "POST", "/api/node-rename/abort", { txn_id: prepared.body.txn_id });
});

test("rename registry: another network's node does not reserve the local alias", async () => {
  const target = `idvforeign-target-${stamp}`;
  seedNode(`n_idv_foreign_target_${stamp}`, target, NET2, outsiderId);
  const prepared = await api(ownerToken, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: victimAlias, new_alias: target });
  expect(prepared.body.ok).toBe(true);
  expect((await api(ownerToken, "POST", "/api/node-rename/abort", { txn_id: prepared.body.txn_id })).body.ok).toBe(true);
});

test("rename registry: a free alias commits and preserves node identity", async () => {
  const alias = `idvrename-old-${stamp}`;
  const target = `idvrename-new-${stamp}`;
  const nodeId = `n_idv_rename_${stamp}`;
  seedNode(nodeId, alias, NET, ownerId);
  seedSession(nodeId, alias, NET);
  const prepared = await api(ownerToken, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: alias, new_alias: target });
  expect(prepared.body.ok).toBe(true);
  const committed = await api(ownerToken, "POST", "/api/node-rename/commit", { txn_id: prepared.body.txn_id });
  expect(committed.body.ok).toBe(true);
  expect(sessionSnap(target, NET)?.node_id).toBe(nodeId);
  expect(sessionSnap(alias, NET)).toBeNull();
  expect(db.get("SELECT alias FROM nodes WHERE node_id = ?1", nodeId)).toEqual({ alias: target });
});

function subscribe(path: string, token: string, headers: Record<string, string> = {}): Sub {
  const ctrl = new AbortController();
  const sub: Sub = { events: [], done: false, abort: () => ctrl.abort(), ready: Promise.resolve() };
  let markReady!: () => void;
  sub.ready = new Promise<void>((r) => { markReady = r; });
  openSubs.push(sub);
  (async () => {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream", ...headers },
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`subscribe ${path} → ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const ev = JSON.parse(line.slice(6));
          sub.events.push(ev);
          if (ev.type === "connected") markReady();
        }
      }
    } catch { /* aborted */ }
    sub.done = true;
    markReady();
  })();
  return sub;
}

async function until(cond: () => boolean, what: string, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function api(token: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}

async function tool(token: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-03-26",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const raw = await res.text();
  const data = raw.split("\n").filter((x) => x.startsWith("data:"));
  const payload = data.length ? JSON.parse(data.at(-1)!.slice(5).trim()) : JSON.parse(raw);
  const text = payload.result?.content?.[0]?.text;
  if (typeof text !== "string" || !text.startsWith("{")) throw new Error(`${name}: ${raw.slice(0, 500)}`);
  return JSON.parse(text);
}

let mintSeq = 0;
function mint(userId: string, networkId: string, alias: string, epoch: number, boundNodeId: string | null): Tok {
  const token = generateNetworkToken();
  const tokenId = `tok_idv_${++mintSeq}_${stamp}`;
  db.run(
    `INSERT INTO api_tokens (token_id, token_hash, user_id, network_id, name, scope, bound_node_id, node_identity_epoch)
     VALUES (?1, ?2, ?3, ?4, ?5, 'network', ?6, ?7)`,
    [tokenId, hashToken(token), userId, networkId, `node:${alias}`, boundNodeId, epoch],
  );
  return { token, tokenId };
}

function minted(userId: string, networkId: string, alias: string, nodeId: string): Tok {
  const row = createNetworkTokenForNode(userId, networkId, alias, nodeId);
  if (!row.ok || !row.token || !row.token_id) throw new Error(`mint ${alias}: ${row.error ?? "no token"}`);
  return { token: row.token, tokenId: row.token_id };
}

function seedNode(nodeId: string, alias: string, networkId: string, userId: string) {
  db.run(`INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id)
          VALUES (?1, ?2, ?2, ?3, ?4)`, [nodeId, alias, networkId, userId]);
}

function seedSession(nodeId: string, alias: string, networkId: string) {
  db.run(`INSERT INTO sessions (resume_id, alias, node_id, network_id, status)
          VALUES (?1, ?2, ?3, ?4, 'idle')`, [`sdk-${nodeId}`, alias, nodeId, networkId]);
}

function taskCount(content: string): number {
  return Number(db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM tasks WHERE content = ?1", content)?.n ?? 0);
}

function sessionSnap(alias: string, networkId: string) {
  return db.get(
    `SELECT resume_id, alias, status, task, output, node_id, network_id, updated_at
       FROM sessions WHERE alias = ?1 AND network_id = ?2`,
    alias, networkId,
  );
}

function tokenName(tokenId: string): string | null {
  return db.get<{ name: string }>("SELECT name FROM api_tokens WHERE token_id = ?1", tokenId)?.name ?? null;
}

const report = (tok: Tok, alias: string, nodeId: string, networkId: string, extra: Record<string, unknown> = {}) =>
  tool(tok.token, "report_status", {
    resume_id: `sdk-${alias}`,
    alias,
    status: "idle",
    output: "steady",
    node_id: nodeId,
    network_id: networkId,
    ...extra,
  });

function lifecycleFixture(key: string) {
  const daemonId = `node_life_daemon_${key}_${stamp}`, daemonAlias = `life-daemon-${key}-${stamp}`;
  const childId = `node_life_${key}_${stamp}`, childAlias = `life-child-${key}-${stamp}`;
  seedNode(daemonId, daemonAlias, NET, ownerId); seedNode(childId, childAlias, NET, ownerId);
  seedSession(daemonId, daemonAlias, NET);
  db.run("UPDATE nodes SET hostname='lifecycle-host',config_snapshot=?1 WHERE node_id=?2",
    [JSON.stringify({ role: "host_supervisor", daemon_capabilities: { adopt_capable: true } }), daemonId]);
  db.run("UPDATE nodes SET hostname='lifecycle-host',config_snapshot='{}' WHERE node_id=?1", [childId]);
  db.run("UPDATE sessions SET last_seen_at=datetime('now') WHERE node_id=?1", [daemonId]);
  return { daemonId, daemonAlias, childId, childAlias };
}

test("token lifecycle: adoption rejects a different node's same-name credential", async () => {
  const f = lifecycleFixture("adopt-denied");
  const otherNode = `n_life_other_${stamp}`;
  seedNode(otherNode, `life-other-${stamp}`, NET, outsiderId);
  mint(outsiderId, NET, f.daemonAlias, 2, otherNode);
  mint(outsiderId, NET, f.daemonAlias, 0, null);
  const result = await tool(ownerToken, "request_adopt_node", { node_id: f.childId, daemon_node_id: f.daemonId, workdir: "/workspace/fixture" });
  expect(result.error).toBe("daemon_offline");
  expect(db.get("SELECT request_id FROM node_daemon_bindings WHERE node_id=?1", f.childId)).toBeNull();
});

for (const shape of ["bound", "unbound"] as const) {
  test(`token lifecycle: adoption accepts verified ${shape} credentials`, async () => {
    const f = lifecycleFixture(`adopt-${shape}`);
    mint(ownerId, NET, shape === "bound" ? victimAlias : f.daemonAlias, shape === "bound" ? 2 : 0, shape === "bound" ? f.daemonId : null);
    const result = await tool(ownerToken, "request_adopt_node", { node_id: f.childId, daemon_node_id: f.daemonId, workdir: "/workspace/fixture" });
    expect(result.ok).toBe(true);
  });
}

test("token lifecycle: another node's heartbeat cannot make the daemon ready", async () => {
  const f=lifecycleFixture("heartbeat-denied");
  mint(ownerId,NET,f.daemonAlias,2,f.daemonId);
  const other=`node_life_heartbeat_other_${stamp}`;
  seedNode(other,f.daemonAlias,NET,outsiderId);
  db.run("DELETE FROM sessions WHERE node_id=?1",[f.daemonId]);
  seedSession(other,f.daemonAlias,NET);
  db.run("UPDATE sessions SET last_seen_at=datetime('now') WHERE node_id=?1",[other]);
  const result=await tool(ownerToken,"request_adopt_node",{node_id:f.childId,daemon_node_id:f.daemonId,workdir:"/workspace/fixture"});
  expect(result.error).toBe("daemon_offline");
});

test("token lifecycle: a unique legacy null-ID heartbeat remains supported", async () => {
  const f=lifecycleFixture("heartbeat-legacy");
  mint(ownerId,NET,f.daemonAlias,0,null);
  db.run("UPDATE sessions SET node_id=NULL WHERE node_id=?1",[f.daemonId]);
  expect((await tool(ownerToken,"request_adopt_node",{node_id:f.childId,daemon_node_id:f.daemonId,workdir:"/workspace/fixture"})).ok).toBe(true);
});

for (const shape of ["frozen", "legacy null", "wrong frozen", "same alias rebuild"] as const) {
  test(`token lifecycle: delete ${shape} revokes only the target credential`, async () => {
    const key = shape.replaceAll(" ", "-"); const f = lifecycleFixture(key);
    const daemonTok = mint(ownerId, NET, f.daemonAlias, 2, f.daemonId);
    const wrong = mint(outsiderId, NET, f.childAlias, 0, null);
    const childTok = mint(ownerId, NET, shape === "frozen" ? victimAlias : f.childAlias, 2, f.childId);
    db.run(`INSERT INTO node_create_requests(request_id,daemon_node_id,child_name,child_node_id,network_id,runtime,flags_json,env_keys,status,child_token_id,created_at,created_by_token)
            VALUES(?1,?2,?3,?4,?5,'fixture','{}','[]','started',?6,?7,'fixture')`,
      [`cr_${f.childId.slice(5)}`, f.daemonId, f.childAlias, f.childId, NET, childTok.tokenId, Date.now()]);
    const dispatched = await tool(ownerToken, "delete_node", { child_node_id: f.childId, daemon_node_id: f.daemonId, network_id: NET, confirm_alias: f.childAlias });
    expect(dispatched.ok).toBe(true);
    expect(db.get<{ child_token_id: string }>("SELECT child_token_id FROM node_stop_requests WHERE request_id=?1", dispatched.request_id)?.child_token_id).toBe(childTok.tokenId);
    if (shape === "legacy null" || shape === "wrong frozen") db.run("UPDATE node_stop_requests SET child_token_id=?1 WHERE request_id=?2", [shape === "wrong frozen" ? wrong.tokenId : null, dispatched.request_id]);
    let rebuilt: Tok | null = null;
    if (shape === "same alias rebuild") {
      db.run("DELETE FROM nodes WHERE node_id=?1", [f.childId]);
      const newId = `n_life_rebuilt_${stamp}`;seedNode(newId, f.childAlias, NET, ownerId);
      rebuilt = mint(ownerId, NET, f.childAlias, 2, newId);
    }
    const ack = await tool(daemonTok.token, "ack_stop_request", { request_id: dispatched.request_id, status: "stopped" });
    expect(ack.ok).toBe(true);
    const revoked = (id: string) => db.get<{ revoked_at: string | null }>("SELECT revoked_at FROM api_tokens WHERE token_id=?1", id)?.revoked_at;
    expect(revoked(childTok.tokenId)).not.toBeNull();
    expect(revoked(wrong.tokenId)).toBeNull();
    if (rebuilt) expect(revoked(rebuilt.tokenId)).toBeNull();
    expect(db.get("SELECT node_id FROM nodes WHERE node_id=?1", f.childId)).toBeNull();
  });
}

test("token lifecycle: rename updates verified labels and preserves unrelated credentials", async () => {
  const alias = `life-rename-${stamp}`, nodeId = `n_life_rename_${stamp}`, target = `life-renamed-${stamp}`;
  seedNode(nodeId, alias, NET, ownerId);seedSession(nodeId, alias, NET);
  const unrelated = mint(outsiderId, NET, alias, 0, null);
  const bound = mint(ownerId, NET, victimAlias, 2, nodeId);
  const legacy = mint(ownerId, NET, alias, 0, null);
  const foreign = mint(outsiderId, NET2, alias, 0, null);
  const before = [unrelated,foreign].map(t => tokenName(t.tokenId));
  const prepare = await api(ownerToken, "POST", "/api/node-rename/prepare", { network_id: NET, old_alias: alias, new_alias: target });
  expect(prepare.body.ok).toBe(true);
  expect((await api(ownerToken, "POST", "/api/node-rename/commit", { txn_id: prepare.body.txn_id })).body.ok).toBe(true);
  expect(tokenName(bound.tokenId)).toBe(`node:${target}`);
  expect(tokenName(legacy.tokenId)).toBe(`node:${target}`);
  expect([unrelated,foreign].map(t => tokenName(t.tokenId))).toEqual(before);
});

test("token lifecycle: rename refuses ambiguous node rows before and after prepare", async () => {
  const alias=`life-dup-rename-${stamp}`, nodeId=`n_life_dupr_${stamp}`, target=`life-dup-target-${stamp}`;
  seedNode(nodeId,alias,NET,ownerId);seedSession(nodeId,alias,NET);
  const mine=mint(ownerId,NET,alias,2,nodeId);
  const prepared=await api(ownerToken,"POST","/api/node-rename/prepare",{network_id:NET,old_alias:alias,new_alias:target});expect(prepared.body.ok).toBe(true);
  seedNode(`n_life_dupo_${stamp}`,alias,NET,outsiderId);
  expect((await api(ownerToken,"POST","/api/node-rename/commit",{txn_id:prepared.body.txn_id})).body.error).toBe("node_alias_ambiguous");
  expect((await api(ownerToken,"POST","/api/node-rename/prepare",{network_id:NET,old_alias:alias,new_alias:target})).body.error).toBe("node_alias_ambiguous");
  expect(tokenName(mine.tokenId)).toBe(`node:${alias}`);
  expect(db.get("SELECT status FROM rename_txn WHERE txn_id=?1",prepared.body.txn_id)).toEqual({status:"prepared"});
  await api(ownerToken,"POST","/api/node-rename/abort",{txn_id:prepared.body.txn_id});
});

beforeAll(async () => {
  process.env.COMMHUB_UPLOADS_DIR = join(dir, "uploads");
  process.env.HOST = "127.0.0.1";
  const owner = register(`idvown${stamp}`, "CallerIdentOwner123!", undefined, "seed");
  if (!owner.ok || !owner.token || !owner.user || !owner.network_id) throw new Error(owner.error || "owner register failed");
  ownerToken = owner.token;
  ownerId = owner.user.user_id;
  NET = owner.network_id;
  const outsider = register(`idvadm${stamp}`, "CallerIdentAdmin123!", undefined, "seed");
  if (!outsider.ok || !outsider.user || !outsider.network_id) throw new Error(outsider.error || "admin register failed");
  outsiderId = outsider.user.user_id;
  NET2 = outsider.network_id;
  const joined = addNetworkMember(NET, outsiderId, "admin", ownerId);
  if (!joined.ok) throw new Error(joined.error || "add member failed");

  victimTok = minted(ownerId, NET, victimAlias, victimId);
  otherTok = minted(ownerId, NET, otherAlias, otherId);
  db.run("UPDATE api_tokens SET name = ?1 WHERE token_id = ?2", [`node:${victimAlias}`, otherTok.tokenId]);
  minted(ownerId, NET, sinkAlias, sinkId);
  minted(ownerId, NET, sharedAlias, sharedId);
  sharedHome = minted(outsiderId, NET2, sharedAlias, shared2Id);
  minted(outsiderId, NET2, sink2Alias, sink2Id);
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at)
     VALUES (?1, ?2, ?2, ?3, NULL, datetime('now'))`,
    [ownerlessId, ownerlessAlias, NET],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`,
    [`n_idv_dup_a_${stamp}`, dupAlias, NET, ownerId],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`,
    [`n_idv_dup_b_${stamp}`, dupAlias, NET, ownerId],
  );

  squatter = mint(outsiderId, NET, victimAlias, 2, null);
  boundMissing = mint(ownerId, NET, victimAlias, 2, missingBoundId);
  freshTok = mint(ownerId, NET, freshAlias, 2, null);
  ownerlessTok = mint(outsiderId, NET, ownerlessAlias, 0, null);
  dupTok = mint(ownerId, NET, dupAlias, 2, null);
  sharedForeign = mint(outsiderId, NET, sharedAlias, 2, null);
  p10Owner = mint(ownerId, NET, victimAlias, 2, null);

  const mod: any = await import("./server.js");
  server = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  base = `http://127.0.0.1:${server.port}`;
  db.run("UPDATE nodes SET permission_mode = 'readonly' WHERE node_id = ?1", [otherId]);
  for (const row of [
    [victimTok, victimAlias, victimId, NET],
    [otherTok, otherAlias, otherId, NET],
    [sharedHome, sharedAlias, shared2Id, NET2],
  ] as const) {
    const reported = await report(row[0], row[1], row[2], row[3]);
    if (!reported.ok) throw new Error(`report ${row[1]}: ${JSON.stringify(reported)}`);
  }
  const sinkReport = await report(minted(ownerId, NET, sinkAlias, sinkId), sinkAlias, sinkId, NET);
  if (!sinkReport.ok) throw new Error(`report sink: ${JSON.stringify(sinkReport)}`);
  const sink2Tok = minted(outsiderId, NET2, sink2Alias, sink2Id);
  const sink2Report = await report(sink2Tok, sink2Alias, sink2Id, NET2);
  if (!sink2Report.ok) throw new Error(`report sink2: ${JSON.stringify(sink2Report)}`);
}, 30_000);

afterAll(() => {
  for (const sub of openSubs) sub.abort();
  try { server?.stop?.(true); } catch {}
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

async function mcpSend(token: string, task: string, from: string | undefined) {
  const args: Record<string, unknown> = { alias: sinkAlias, task, network_id: NET };
  if (from !== undefined) args.from_session = from;
  return tool(token, "send_task", args);
}

test("inbox recipient: bound identity wins over the token name", async () => {
  const id = `inbox-bound-${stamp}`;
  db.run("INSERT INTO inbox (id, session_name, type, content, network_id) VALUES (?1, ?2, 'message', 'own inbox', ?3)", [id, otherAlias, NET]);
  const read = await tool(otherTok.token, "get_inbox", { alias: otherAlias });
  expect(read.ok).toBe(true);
  expect(read.messages.some((row: any) => row.id === id)).toBe(true);
  expect((await tool(otherTok.token, "ack_inbox", { alias: otherAlias, message_id: id })).ok).toBe(true);
  expect(db.get<{ acked: number }>("SELECT acked FROM inbox WHERE id = ?1", id)?.acked).toBe(1);
});

test("inbox recipient: another node and invalid node identities cannot read or ACK", async () => {
  const id = `inbox-denied-${stamp}`;
  db.run("INSERT INTO inbox (id, session_name, type, content, network_id) VALUES (?1, ?2, 'message', 'private inbox', ?3)", [id, victimAlias, NET]);
  for (const caller of [otherTok, squatter, boundMissing]) {
    const read = await tool(caller.token, "get_inbox", { alias: victimAlias });
    expect(read.ok).toBe(false);
    expect(read.error).toBe("inbox_identity_mismatch");
    expect(read.messages).toBeUndefined();
    const ack = await tool(caller.token, "ack_inbox", { alias: victimAlias, message_id: id });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe("inbox_identity_mismatch");
    expect(db.get<{ acked: number }>("SELECT acked FROM inbox WHERE id = ?1", id)?.acked).toBe(0);
  }
  expect((await tool(victimTok.token, "ack_inbox", { alias: victimAlias, message_id: id })).ok).toBe(true);
});

test("inbox recipient: same alias stays inside the token network", async () => {
  const home = `inbox-net-home-${stamp}`, foreign = `inbox-net-foreign-${stamp}`;
  db.run("INSERT INTO inbox (id, session_name, type, content, network_id) VALUES (?1, ?2, 'message', 'home', ?3)", [home, sharedAlias, NET2]);
  db.run("INSERT INTO inbox (id, session_name, type, content, network_id) VALUES (?1, ?2, 'message', 'foreign', ?3)", [foreign, sharedAlias, NET]);
  const read = await tool(sharedHome.token, "get_inbox", { alias: sharedAlias, network_id: NET });
  expect(read.ok).toBe(true);
  expect(read.messages.some((row: any) => row.id === home)).toBe(true);
  expect(read.messages.some((row: any) => row.id === foreign)).toBe(false);
  expect((await tool(sharedHome.token, "ack_inbox", { alias: sharedAlias, message_id: foreign, network_id: NET })).ok).toBe(false);
  expect(db.get<{ acked: number }>("SELECT acked FROM inbox WHERE id = ?1", foreign)?.acked).toBe(0);
});

test("inbox recipient: legacy ownerless identity and authorized human access remain", async () => {
  const id = `inbox-legacy-${stamp}`;
  db.run("INSERT INTO inbox (id, session_name, type, content, network_id) VALUES (?1, ?2, 'message', 'legacy', ?3)", [id, ownerlessAlias, NET]);
  expect((await tool(ownerlessTok.token, "get_inbox", { alias: ownerlessAlias })).ok).toBe(true);
  expect((await tool(ownerToken, "get_inbox", { alias: ownerlessAlias, network_id: NET })).ok).toBe(true);
  expect((await tool(ownerToken, "ack_inbox", { alias: ownerlessAlias, message_id: id, network_id: NET })).ok).toBe(true);
});

test("inbox recipient: a full-access member cannot act as another owner's node", async () => {
  const member = register(`inboxmem${stamp}`, "InboxMember123!", undefined, "seed");
  expect(member.ok).toBe(true);
  expect(addNetworkMember(NET, member.user!.user_id, "member", ownerId).ok).toBe(true);
  db.run("UPDATE network_members SET agent_access = 'all' WHERE user_id = ?1 AND network_id = ?2", [member.user!.user_id, NET]);
  const id = `inbox-member-${stamp}`;
  db.run("INSERT INTO inbox (id, session_name, type, content, network_id) VALUES (?1, ?2, 'message', 'private', ?3)", [id, victimAlias, NET]);
  for (const name of ["get_inbox", "ack_inbox"]) {
    const args: Record<string, unknown> = { alias: victimAlias, network_id: NET };
    if (name === "ack_inbox") args.message_id = id;
    const result = await tool(member.token!, name, args);
    expect(result.ok).toBe(false);
    expect(result.error).toBe("inbox_identity_mismatch");
  }
  expect(db.get<{ acked: number }>("SELECT acked FROM inbox WHERE id = ?1", id)?.acked).toBe(0);
  const own = `inbox-member-own-${stamp}`;
  db.run("INSERT INTO inbox (id, session_name, type, content, network_id) VALUES (?1, ?2, 'message', 'own', ?3)", [own, member.user!.username, NET]);
  expect((await tool(member.token!, "get_inbox", { alias: member.user!.username, network_id: NET })).ok).toBe(true);
  expect((await tool(member.token!, "ack_inbox", { alias: member.user!.username, message_id: own, network_id: NET })).ok).toBe(true);
});

test("caller identity boundary: mcp send omits from_session", async () => {
  const task = `boundary omit ${stamp}`;
  const sent = await mcpSend(squatter.token, task, undefined);
  expect(sent.ok).toBe(false);
  expect(sent.error).toBe("from_session_identity_mismatch");
  expect(taskCount(task)).toBe(0);
});

test("caller identity boundary: mcp send names the victim", async () => {
  const task = `boundary named ${stamp}`;
  const sent = await mcpSend(squatter.token, task, victimAlias);
  expect(sent.ok).toBe(false);
  expect(sent.error).toBe("from_session_identity_mismatch");
  expect(sent.token_alias).toBe("");
  expect(taskCount(task)).toBe(0);
});

test("caller identity boundary: mcp send names hub", async () => {
  const task = `boundary hub ${stamp}`;
  const sent = await mcpSend(squatter.token, task, "hub");
  expect(sent.ok).toBe(false);
  expect(sent.error).toBe("from_session_identity_mismatch");
  expect(sent.token_alias).toBe("");
  expect(taskCount(task)).toBe(0);
});

test("caller identity boundary: rest send omits from", async () => {
  const task = `boundary rest omit ${stamp}`;
  const sent = await api(squatter.token, "POST", "/api/task", { alias: sinkAlias, task, network_id: NET });
  expect(sent.status).toBe(403);
  expect(sent.body.error).toBe("from_session_identity_mismatch");
  expect(taskCount(task)).toBe(0);
});

test("caller identity boundary: rest send names the victim", async () => {
  const task = `boundary rest named ${stamp}`;
  const sent = await api(squatter.token, "POST", "/api/task", { alias: sinkAlias, task, from: victimAlias, network_id: NET });
  expect(sent.status).toBe(403);
  expect(sent.body.error).toBe("from_session_identity_mismatch");
  expect(sent.body.token_alias).toBe("");
  expect(taskCount(task)).toBe(0);
});

test("caller identity boundary: rest send names hub", async () => {
  const task = `boundary rest hub ${stamp}`;
  const sent = await api(squatter.token, "POST", "/api/task", { alias: sinkAlias, task, from: "hub", network_id: NET });
  expect(sent.status).toBe(403);
  expect(sent.body.token_alias).toBe("");
  expect(taskCount(task)).toBe(0);
});

test("caller identity boundary: rename refuses the victim alias", async () => {
  const sent = await api(squatter.token, "POST", "/api/node-rename/prepare", {
    network_id: NET,
    old_alias: victimAlias,
    new_alias: `idvren${stamp}`,
  });
  expect(sent.status).toBe(403);
  expect(sent.body.error).toBe("user_token_required");
  if (sent.body?.txn_id) await api(ownerToken, "POST", "/api/node-rename/abort", { txn_id: sent.body.txn_id });
});

test("caller identity boundary: auth me hides the victim alias", async () => {
  const me = await api(squatter.token, "GET", "/api/auth/me");
  expect(me.status).toBe(200);
  expect(me.body.credential.kind).toBe("node");
  expect(me.body.credential.node_alias).toBeNull();
});

test("caller identity boundary: requirement actor is the token", async () => {
  const created = await api(squatter.token, "POST", "/api/requirements", { name: `boundary ${stamp}` });
  expect(created.status).toBe(201);
  expect(created.body.requirement.created_by).toEqual({ kind: "node", id: `token:${squatter.tokenId}` });
});

test("caller identity boundary: sse does not supersede the victim", async () => {
  const real = subscribe(`/events/${encodeURIComponent(victimAlias)}`, victimTok.token, { "X-Anet-Instance-Id": `inst-a-${stamp}` });
  await real.ready;
  const squat = subscribe(`/events/${encodeURIComponent(victimAlias)}`, squatter.token, { "X-Anet-Instance-Id": `inst-s-${stamp}` });
  await squat.ready;
  const t0 = Date.now();
  while (!real.events.some((e) => e.type === "node_connection_superseded") && Date.now() - t0 < 400) {
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(real.events.some((e) => e.type === "node_connection_superseded")).toBe(false);
  expect(real.done).toBe(false);
  const again = subscribe(`/events/${encodeURIComponent(victimAlias)}`, victimTok.token, { "X-Anet-Instance-Id": `inst-b-${stamp}` });
  await again.ready;
  await until(() => real.done, "the node's own second connection to close the first");
  const notice = real.events.find((e) => e.type === "node_connection_superseded");
  expect(notice?.reason).toBe("superseded_by_new_connection");
  expect(squat.done).toBe(false);
  real.abort();
  squat.abort();
  again.abort();
}, 15_000);

test("caller identity boundary: daemon list does not bind the victim", async () => {
  const listed = await tool(squatter.token, "list_my_pending_create_requests", {});
  expect(listed.ok).toBe(false);
  expect(listed.error).toBe("caller_not_a_daemon");
});

test("caller identity boundary: other network token does not write here", async () => {
  const task = `boundary foreign ${stamp}`;
  const sent = await mcpSend(sharedForeign.token, task, undefined);
  expect(sent.ok).toBe(false);
  expect(sent.error).toBe("from_session_identity_mismatch");
  expect(taskCount(task)).toBe(0);
});

test("bound row missing does not fall back to the name", async () => {
  const me = await api(boundMissing.token, "GET", "/api/auth/me");
  expect(me.status).toBe(200);
  expect(me.body.credential.node_alias).toBeNull();
  const task = `boundary missing-bound ${stamp}`;
  const sent = await mcpSend(boundMissing.token, task, undefined);
  expect(sent.ok).toBe(false);
  expect(sent.error).toBe("from_session_identity_mismatch");
  expect(taskCount(task)).toBe(0);
});

test("bound token speaks as the bound node when the token name disagrees", async () => {
  const me = await api(otherTok.token, "GET", "/api/auth/me");
  expect(me.body.credential.node_alias).toBe(otherAlias);
  const selfTask = `boundary other self ${stamp}`;
  const self = await tool(otherTok.token, "send_task", { alias: otherAlias, task: selfTask, network_id: NET });
  expect(self.ok).toBe(true);
  const row = db.get<{ from_name: string; network_id: string }>("SELECT from_name, network_id FROM tasks WHERE content = ?1", selfTask);
  expect(row?.from_name).toBe(otherAlias);
  expect(row?.network_id).toBe(NET);
  const stolen = `boundary other stolen ${stamp}`;
  const sent = await tool(otherTok.token, "send_task", { alias: victimAlias, task: stolen, network_id: NET });
  expect(sent.ok).toBe(false);
  expect(sent.error).toBe("node_permission_denied");
  expect(sent.reason).toBe("mode_readonly");
  expect(taskCount(stolen)).toBe(0);
  const real = subscribe(`/events/${encodeURIComponent(victimAlias)}`, victimTok.token, { "X-Anet-Instance-Id": `inst-r-${stamp}` });
  await real.ready;
  const other = subscribe(`/events/${encodeURIComponent(victimAlias)}`, otherTok.token, { "X-Anet-Instance-Id": `inst-o-${stamp}` });
  await other.ready;
  await new Promise((r) => setTimeout(r, 200));
  expect(real.events.some((e) => e.type === "node_connection_superseded")).toBe(false);
  expect(real.done).toBe(false);
  real.abort();
  other.abort();
}, 15_000);

test("ownerless epoch 0 token still speaks as that alias and does not claim the row", async () => {
  const task = `boundary ownerless ${stamp}`;
  const sent = await tool(ownerlessTok.token, "send_task", { alias: sinkAlias, task, network_id: NET });
  expect(sent.ok).toBe(true);
  const row = db.get<{ from_name: string }>("SELECT from_name FROM tasks WHERE content = ?1", task);
  expect(row?.from_name).toBe(ownerlessAlias);
  const owner = db.get<{ owner_user_id: string | null }>("SELECT owner_user_id FROM nodes WHERE node_id = ?1", ownerlessId);
  expect(owner?.owner_user_id ?? null).toBeNull();
});

test("two node rows with one alias stay unresolved", async () => {
  const me = await api(dupTok.token, "GET", "/api/auth/me");
  expect(me.body.credential.node_alias).toBeNull();
  const task = `boundary dup ${stamp}`;
  const sent = await mcpSend(dupTok.token, task, undefined);
  expect(sent.ok).toBe(false);
  expect(sent.error).toBe("from_session_identity_mismatch");
  expect(taskCount(task)).toBe(0);
});

test("unbound token with no row keeps its name and first report_status binds it", async () => {
  const before = await api(freshTok.token, "GET", "/api/auth/me");
  expect(before.body.credential.node_alias).toBe(freshAlias);
  const early = `boundary fresh send ${stamp}`;
  const sent = await tool(freshTok.token, "send_task", { alias: sinkAlias, task: early, network_id: NET });
  expect(sent.ok).toBe(true);
  expect(db.get<{ from_name: string }>("SELECT from_name FROM tasks WHERE content = ?1", early)?.from_name).toBe(freshAlias);
  expect(db.get("SELECT node_id FROM nodes WHERE node_id = ?1", freshId)).toBeNull();
  const reported = await report(freshTok, freshAlias, freshId, NET);
  expect(reported.ok).toBe(true);
  const node = db.get<{ alias: string; network_id: string }>("SELECT alias, network_id FROM nodes WHERE node_id = ?1", freshId);
  expect(node?.alias).toBe(freshAlias);
  expect(node?.network_id).toBe(NET);
  const bound = db.get<{ bound_node_id: string | null; name: string }>(
    "SELECT bound_node_id, name FROM api_tokens WHERE token_id = ?1",
    freshTok.tokenId,
  );
  expect(bound?.bound_node_id).toBe(freshId);
  expect(bound?.name).toBe(`node:${freshAlias}`);
  const after = await api(freshTok.token, "GET", "/api/auth/me");
  expect(after.body.credential.node_alias).toBe(freshAlias);
});

test("a copied node_id does not relabel the row and a squatter still cannot heartbeat", async () => {
  const boundName = tokenName(victimTok.tokenId);
  const unboundName = tokenName(p10Owner.tokenId);
  const claimId = `n_idv_claim_${stamp}`;
  expect(sessionSnap(victimAlias, NET)).toBeTruthy();
  // Legitimate owner, unbound token, a node_id that is not the row. The
  // heartbeat succeeds and the row stays; the session must not keep the claim.
  const mismatch = await tool(p10Owner.token, "report_status", {
    resume_id: `sdk-${victimAlias}`,
    alias: victimAlias,
    status: "working",
    output: "mutated-output",
    node_id: claimId,
    network_id: NET,
  });
  expect(mismatch.ok).toBe(true);
  expect(db.get("SELECT node_id FROM nodes WHERE node_id = ?1", claimId)).toBeNull();
  expect(db.get<{ alias: string }>("SELECT alias FROM nodes WHERE node_id = ?1", victimId)?.alias).toBe(victimAlias);
  const cleared = sessionSnap(victimAlias, NET) as { node_id: string | null } | null;
  expect(cleared).toBeTruthy();
  expect(cleared?.node_id ?? null).toBeNull();
  expect(tokenName(p10Owner.tokenId)).toBe(unboundName);
  // Bound token reporting another node's id: row stays, heartbeat still ok.
  const wrongNode = await tool(victimTok.token, "report_status", {
    resume_id: `sdk-${victimAlias}`,
    alias: victimAlias,
    status: "working",
    output: "mutated-output",
    node_id: otherId,
    network_id: NET,
  });
  expect(wrongNode.ok).toBe(true);
  expect(db.get<{ alias: string }>("SELECT alias FROM nodes WHERE node_id = ?1", otherId)?.alias).toBe(otherAlias);
  expect(db.get<{ alias: string }>("SELECT alias FROM nodes WHERE node_id = ?1", victimId)?.alias).toBe(victimAlias);
  expect(tokenName(victimTok.tokenId)).toBe(boundName);
  const afterCollision = sessionSnap(victimAlias, NET);
  const squat = await tool(squatter.token, "report_status", {
    resume_id: `sdk-squat-${stamp}`,
    alias: victimAlias,
    status: "working",
    output: "squatter-output",
    node_id: victimId,
    network_id: NET,
  });
  expect(squat.ok).toBe(false);
  expect(squat.error).toBe("alias_identity_mismatch");
  expect(sessionSnap(victimAlias, NET)).toEqual(afterCollision);
  expect(db.get("SELECT resume_id FROM sessions WHERE resume_id = ?1", `sdk-squat-${stamp}`)).toBeNull();
});

test("duplicate alias unbound token keeps the owning node online", async () => {
  // Epoch 0 is the old unbound shape. Epoch 2 would still trip first-binding
  // and clear the session node_id; that is a heartbeat success, not this case.
  const alias = `idvlive${stamp}`;
  const mine = `n_idv_live_${stamp}`;
  const other = `n_idv_liveo_${stamp}`;
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`,
    [mine, alias, NET, ownerId],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`,
    [other, alias, NET, outsiderId],
  );
  const tok = mint(ownerId, NET, alias, 0, null);
  const reported = await report(tok, alias, mine, NET, { hostname: "idv-live-host" });
  expect(reported.ok).toBe(true);
  expect(db.get<{ alias: string; hostname: string | null }>(
    "SELECT alias, hostname FROM nodes WHERE node_id = ?1", mine,
  )).toEqual({ alias, hostname: "idv-live-host" });
  expect(db.get<{ alias: string; hostname: string | null }>(
    "SELECT alias, hostname FROM nodes WHERE node_id = ?1", other,
  )).toEqual({ alias, hostname: null });
  expect(db.get<{ node_id: string | null }>(
    "SELECT node_id FROM sessions WHERE alias = ?1 AND network_id = ?2", alias, NET,
  )?.node_id).toBe(mine);
  const task = `dup live ${stamp}`;
  const sent = await tool(tok.token, "send_task", { alias: sinkAlias, task, network_id: NET });
  expect(sent.ok).toBe(true);
  expect(db.get<{ from_name: string }>("SELECT from_name FROM tasks WHERE content = ?1", task)?.from_name).toBe(alias);
});

test("duplicate alias unbound token follows the latest session node", async () => {
  const alias = `idvsess${stamp}`;
  const rowA = `n_idv_sesa_${stamp}`;
  const rowB = `n_idv_sesb_${stamp}`;
  const requestId = `cr_idv_ses_${stamp}`;
  for (const id of [rowA, rowB]) {
    db.run(
      `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at)
       VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`,
      [id, alias, NET, ownerId],
    );
  }
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, network_id, status, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'idle', datetime('now'))`,
    [`sdk-${alias}`, alias, rowB, NET],
  );
  db.run(
    `INSERT INTO node_create_requests (request_id, daemon_node_id, child_name, network_id, runtime, flags_json, env_keys, status, created_at, created_by_token)
     VALUES (?1, ?2, ?3, ?4, 'fixture', '{}', '[]', 'pending', ?5, 'fixture')`,
    [requestId, rowB, `child-${stamp}`, NET, Date.now()],
  );
  const tok = mint(ownerId, NET, alias, 0, null);
  const listed = await tool(tok.token, "list_my_pending_create_requests", {});
  expect(listed.ok).toBe(true);
  expect(listed.count).toBe(1);
  expect(listed.requests[0].request_id).toBe(requestId);
});

test("home network of a shared alias still accepts its own token", async () => {
  const task = `boundary home ${stamp}`;
  const sent = await tool(sharedHome.token, "send_task", { alias: sink2Alias, task, network_id: NET2 });
  expect(sent.ok).toBe(true);
  const row = db.get<{ from_name: string; network_id: string }>("SELECT from_name, network_id FROM tasks WHERE content = ?1", task);
  expect(row).toEqual({ from_name: sharedAlias, network_id: NET2 });
});

test("a resolved node token can list its own daemon requests", async () => {
  const listed = await tool(victimTok.token, "list_my_pending_create_requests", {});
  expect(listed.ok).toBe(true);
  expect(listed.count).toBe(0);
});

test("unreported registration token signs as api", async () => {
  const username = `idvure${stamp}`;
  const created = register(username, "CallerIdentUre123!", undefined, "seed");
  if (!created.ok || !created.network_token || !created.network_id) {
    throw new Error(created.error || "unreported network token register failed");
  }
  const net = created.network_id;
  const tokenRow = db.get<{ name: string }>(
    "SELECT name FROM api_tokens WHERE token_hash = ?1",
    hashToken(created.network_token),
  );
  expect(tokenRow?.name).toBe("default-network");
  const sink = `idvurk${stamp}`;
  db.run(
    `INSERT INTO sessions (resume_id, alias, network_id, status, updated_at)
     VALUES (?1, ?2, ?3, 'idle', datetime('now'))`,
    [`sdk-${sink}`, sink, net],
  );
  const open = `unreported rest open ${stamp}`;
  const sent = await api(created.network_token, "POST", "/api/task", { alias: sink, task: open, network_id: net });
  expect(sent.status).toBe(200);
  expect(sent.body.ok).toBe(true);
  expect(db.get<{ from_name: string }>("SELECT from_name FROM tasks WHERE content = ?1", open)?.from_name).toBe("api");
  const claimed = `unreported rest claim ${stamp}`;
  const other = `idvuro${stamp}`;
  const refused = await api(created.network_token, "POST", "/api/task", {
    alias: sink, task: claimed, from: other, network_id: net,
  });
  expect(refused.status).toBe(403);
  expect(refused.body.error).toBe("from_session_identity_mismatch");
  expect(refused.body.token_alias).toBe("");
  expect(taskCount(claimed)).toBe(0);
  expect(db.get<{ name: string }>(
    "SELECT name FROM api_tokens WHERE token_hash = ?1",
    hashToken(created.network_token),
  )?.name).toBe("default-network");
});

test("registration network token signs as the username", async () => {
  const username = `idvreg${stamp}`;
  const created = register(username, "CallerIdentReg123!", undefined, "seed");
  if (!created.ok || !created.network_token || !created.network_id || !created.user) {
    throw new Error(created.error || "plain network token register failed");
  }
  const net = created.network_id;
  const tokenRow = db.get<{ name: string }>(
    "SELECT name FROM api_tokens WHERE token_hash = ?1",
    hashToken(created.network_token),
  );
  expect(tokenRow?.name).toBe("default-network");
  const sink = `idvrgk${stamp}`;
  db.run(
    `INSERT INTO sessions (resume_id, alias, network_id, status, updated_at)
     VALUES (?1, ?2, ?3, 'idle', datetime('now'))`,
    [`sdk-${sink}`, sink, net],
  );
  const task = `plain ntok send ${stamp}`;
  const sent = await tool(created.network_token, "send_task", { alias: sink, task, network_id: net });
  expect(sent.ok).toBe(true);
  expect(db.get<{ from_name: string }>("SELECT from_name FROM tasks WHERE content = ?1", task)?.from_name).toBe(username);
  const reported = await tool(created.network_token, "report_status", {
    resume_id: `sdk-${username}`,
    alias: username,
    status: "idle",
    output: "steady",
    network_id: net,
  });
  expect(reported.ok).toBe(true);
  expect(db.get<{ name: string }>(
    "SELECT name FROM api_tokens WHERE token_hash = ?1",
    hashToken(created.network_token),
  )?.name).toBe(`node:${username}`);
});

test("duplicate ownerless row keeps an unbound epoch 0 token online", async () => {
  // Issuer owns neither row. The session points at the ownerless row.
  // Epoch 0 keeps the ownerless-row compatibility; epoch 2 would first-bind.
  const alias = `idvord${stamp}`;
  const ownedId = `n_idv_orda_${stamp}`;
  const ownerlessNode = `n_idv_ordb_${stamp}`;
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at)
     VALUES (?1, ?2, ?2, ?3, ?4, datetime('now'))`,
    [ownedId, alias, NET, ownerId],
  );
  db.run(
    `INSERT INTO nodes (node_id, node_name, alias, network_id, owner_user_id, updated_at)
     VALUES (?1, ?2, ?2, ?3, NULL, datetime('now'))`,
    [ownerlessNode, alias, NET],
  );
  db.run(
    `INSERT INTO sessions (resume_id, alias, node_id, network_id, status, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'idle', datetime('now'))`,
    [`sdk-${alias}`, alias, ownerlessNode, NET],
  );
  const tok = mint(outsiderId, NET, alias, 0, null);
  const registered = await report(tok, alias, ownerlessNode, NET, { hostname: "idv-ord-reg" });
  expect(registered.ok).toBe(true);
  const heartbeat = await report(tok, alias, ownerlessNode, NET, { hostname: "idv-ord-beat" });
  expect(heartbeat.ok).toBe(true);
  expect(db.get<{ node_id: string | null }>(
    "SELECT node_id FROM sessions WHERE alias = ?1 AND network_id = ?2", alias, NET,
  )?.node_id).toBe(ownerlessNode);
  expect(db.get<{ alias: string; owner_user_id: string | null; hostname: string | null }>(
    "SELECT alias, owner_user_id, hostname FROM nodes WHERE node_id = ?1", ownerlessNode,
  )).toEqual({ alias, owner_user_id: null, hostname: "idv-ord-beat" });
  expect(db.get<{ alias: string; owner_user_id: string | null; hostname: string | null }>(
    "SELECT alias, owner_user_id, hostname FROM nodes WHERE node_id = ?1", ownedId,
  )).toEqual({ alias, owner_user_id: ownerId, hostname: null });
  const task = `ownerless dup send ${stamp}`;
  const sent = await tool(tok.token, "send_task", { alias: sinkAlias, task, network_id: NET });
  expect(sent.ok).toBe(true);
  expect(db.get<{ from_name: string }>("SELECT from_name FROM tasks WHERE content = ?1", task)?.from_name).toBe(alias);
  const first = subscribe(`/events/${encodeURIComponent(alias)}`, tok.token, { "X-Anet-Instance-Id": `inst-ord-a-${stamp}` });
  await first.ready;
  expect(first.events.some((e) => e.type === "connected")).toBe(true);
  expect(first.done).toBe(false);
  const second = subscribe(`/events/${encodeURIComponent(alias)}`, tok.token, { "X-Anet-Instance-Id": `inst-ord-b-${stamp}` });
  await second.ready;
  await until(() => first.done, "the ownerless row's own second connection to close the first");
  expect(first.events.some((e) => e.type === "node_connection_superseded")).toBe(true);
  expect(second.done).toBe(false);
  first.abort();
  second.abort();
}, 15_000);


const leaseAlias = `leasebase${stamp}`, leaseId = `n_leasebase_${stamp}`;
let leaseTok: Tok;
beforeAll(() => { seedNode(leaseId,leaseAlias,NET,ownerId);seedSession(leaseId,leaseAlias,NET);leaseTok=mint(ownerId,NET,leaseAlias,2,leaseId); });

function activityTask(nodeId: string, alias: string, network = NET) {
  const id = `task_activity_${crypto.randomUUID()}`;
  db.run("INSERT INTO tasks (task_id, from_name, to_node_id, to_name, status, content, network_id) VALUES (?1, 'scheduler', ?2, ?3, 'running', 'activity fixture', ?4)", [id, nodeId, alias, network]);
  return { task_id: id, thread_id: `thread_${id}`, turn_id: `turn_${id}` };
}
const activitySnap = (id: string) => db.get<any>("SELECT status, consumed_at, runtime_submitted_at, started_at, thread_id, turn_id, last_activity_at FROM tasks WHERE task_id = ?1", id);
async function consumeActivityTask(context: {task_id: string; thread_id: string; turn_id: string}) {
  expect((await tool(leaseTok.token, "mark_tasks_consumed", { task_ids: [context.task_id], task_contexts: [context] })).ok).toBe(true);
}
const renewActivity = (token: string, contexts: Array<{task_id: string; thread_id: string; turn_id: string}>) => tool(token, "mark_tasks_consumed", { task_ids: contexts.map(c => c.task_id), task_contexts: contexts, activity_only: true });

test("activity lease: exact task renewal changes only the activity clock; duplicate consumption does not renew", async () => {
  const c = activityTask(leaseId, leaseAlias); await consumeActivityTask(c);
  db.run("UPDATE tasks SET last_activity_at = datetime('now', '-2 hours') WHERE task_id = ?1", [c.task_id]);
  const before = activitySnap(c.task_id);
  expect((await tool(leaseTok.token, "mark_tasks_consumed", { task_ids: [c.task_id], task_contexts: [c] })).ok).toBe(true);
  expect(activitySnap(c.task_id)).toEqual(before);
  const out = await renewActivity(leaseTok.token, [c]); expect(out.ok).toBe(true);
  const after = activitySnap(c.task_id);
  expect(after.last_activity_at).not.toBe(before.last_activity_at);
  expect({...after, last_activity_at: before.last_activity_at}).toEqual(before);
  expect(out.tasks[0].last_activity_at).toBe(after.last_activity_at);
});

test("activity lease: bound node wins over a same-name session and cannot renew the other node", async () => {
  const alias = `leasebound${stamp}`, mine = `n_leasebound_${stamp}`, other = `n_leaseother_${stamp}`;
  seedNode(mine, alias, NET, ownerId); seedSession(mine, alias, NET);
  const tok = mint(ownerId, NET, leaseAlias, 2, mine), own = activityTask(mine, alias);
  expect((await tool(tok.token, "mark_tasks_consumed", {task_ids: [own.task_id], task_contexts: [own]})).ok).toBe(true);
  seedNode(other, alias, NET, ownerId); db.run("UPDATE sessions SET node_id=?1 WHERE alias=?2 AND network_id=?3",[other,alias,NET]);
  expect((await renewActivity(tok.token, [own])).ok).toBe(true);
  const foreign = activityTask(other, alias);
  db.run("UPDATE tasks SET consumed_at=datetime('now'),thread_id=?1,turn_id=?2 WHERE task_id=?3", [foreign.thread_id,foreign.turn_id,foreign.task_id]);
  expect((await renewActivity(tok.token,[foreign])).error).toBe("task_not_owned");
  expect(activitySnap(foreign.task_id).last_activity_at).toBeNull();
});

for (const shape of ["wrong thread", "wrong turn", "foreign node", "foreign network", "legacy null node", "not consumed", "missing context", "user token"] as const) {
  test(`activity lease: rejects ${shape} without changing the task`, async () => {
    const c = activityTask(leaseId, leaseAlias); if(shape !== "not consumed") await consumeActivityTask(c);
    if(shape === "foreign node") db.run("UPDATE tasks SET to_node_id=?1 WHERE task_id=?2", [otherId,c.task_id]);
    if(shape === "foreign network") db.run("UPDATE tasks SET network_id=?1 WHERE task_id=?2", [NET2,c.task_id]);
    if(shape === "legacy null node") db.run("UPDATE tasks SET to_node_id=NULL WHERE task_id=?1",[c.task_id]);
    const before=activitySnap(c.task_id); const context={...c};
    if(shape === "wrong thread") context.thread_id="sibling_thread";
    if(shape === "wrong turn") context.turn_id="sibling_turn";
    const out=await tool(shape === "user token" ? ownerToken : leaseTok.token,"mark_tasks_consumed",{task_ids:[c.task_id],task_contexts:shape === "missing context" ? [] : [context],activity_only:true});
    expect(out.ok).toBe(false); expect(activitySnap(c.task_id)).toEqual(before);
  });
}
for(const status of ["replied","failed","cancelled","expired"]){
  test(`activity lease: ${status} terminal never receives activity or reopens`,async()=>{
    const c=activityTask(leaseId,leaseAlias);await consumeActivityTask(c);db.run("UPDATE tasks SET status=?1 WHERE task_id=?2",[status,c.task_id]);const before=activitySnap(c.task_id);
    expect((await renewActivity(leaseTok.token,[c])).error).toBe("task_activity_terminal");expect(activitySnap(c.task_id)).toEqual(before);
  });
}
test("activity lease: conflicting batch is rejected with zero partial writes",async()=>{
  const first=activityTask(leaseId,leaseAlias),second=activityTask(leaseId,leaseAlias);await consumeActivityTask(first);await consumeActivityTask(second);
  const before=activitySnap(first.task_id),before2=activitySnap(second.task_id);
  expect((await renewActivity(leaseTok.token,[first,{...second,turn_id:"old_turn"}])).ok).toBe(false);
  expect(activitySnap(first.task_id)).toEqual(before);expect(activitySnap(second.task_id)).toEqual(before2);
});

test("activity lease: injected second-write failure rolls back the first write on the real backend",async()=>{
 const first=activityTask(leaseId,leaseAlias),second=activityTask(leaseId,leaseAlias);await consumeActivityTask(first);await consumeActivityTask(second);
 const trigger=`activity_fail_${stamp}`,fn=`activity_fn_${stamp}`;
 if(db.dialect === "postgres")db.exec(`CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.task_id='${second.task_id}' THEN RAISE EXCEPTION 'test1113_injected_activity_failure'; END IF; RETURN NEW; END; $$; CREATE TRIGGER ${trigger} BEFORE UPDATE OF last_activity_at ON tasks FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
 else db.exec(`CREATE TRIGGER ${trigger} BEFORE UPDATE OF last_activity_at ON tasks WHEN NEW.task_id='${second.task_id}' BEGIN SELECT RAISE(ABORT,'test1113_injected_activity_failure'); END`);
 const before=activitySnap(first.task_id),before2=activitySnap(second.task_id);let failed=false;
 try{await renewActivity(leaseTok.token,[first,second]);}catch(e){failed=String(e).includes("test1113_injected_activity_failure");}
 finally{if(db.dialect === "postgres")db.exec(`DROP TRIGGER ${trigger} ON tasks; DROP FUNCTION ${fn}()`);else db.exec(`DROP TRIGGER ${trigger}`);}
 expect(failed).toBe(true);expect(activitySnap(first.task_id)).toEqual(before);expect(activitySnap(second.task_id)).toEqual(before2);
});
test("activity lease: revoked credential cannot report activity",async()=>{
 const tok=mint(ownerId,NET,leaseAlias,2,leaseId),c=activityTask(leaseId,leaseAlias);await consumeActivityTask(c);const before=activitySnap(c.task_id);
 db.run("UPDATE api_tokens SET revoked_at=datetime('now') WHERE token_id=?1",[tok.tokenId]);
 const response=await fetch(`${base}/mcp`,{method:"POST",headers:{Authorization:`Bearer ${tok.token}`,"Content-Type":"application/json",Accept:"application/json, text/event-stream"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"tools/call",params:{name:"mark_tasks_consumed",arguments:{task_ids:[c.task_id],task_contexts:[c],activity_only:true}}})});
 expect(response.status).toBe(401);expect(activitySnap(c.task_id)).toEqual(before);
});

test("activity lease: real runtime reporter payload traverses authenticated HTTP into the exact task clock",async()=>{
 const c=activityTask(leaseId,leaseAlias);let clock=0;const errors:string[]=[];
 const reporter=createTaskRuntimeEvidenceReporter({taskId:c.task_id,now:()=>clock,
  report:(_level,id,context)=>tool(leaseTok.token,"mark_tasks_consumed",{task_ids:[id],task_contexts:[{task_id:id,thread_id:context!.threadId,turn_id:context!.turnId}]}),
  reportActivity:(id,context)=>tool(leaseTok.token,"mark_tasks_consumed",taskActivityPayload(id,context)),debug:message=>errors.push(message)});
 reporter.consumed({threadId:c.thread_id,turnId:c.turn_id});await until(()=>!!activitySnap(c.task_id).consumed_at,"consumption stamped");
 const before=activitySnap(c.task_id);clock=30_000;reporter.activity({taskId:"other_task",threadId:c.thread_id,turnId:c.turn_id});await new Promise(resolve=>setTimeout(resolve,5));expect(activitySnap(c.task_id)).toEqual(before);
 reporter.activity({taskId:c.task_id,threadId:c.thread_id,turnId:c.turn_id});await until(()=>!!activitySnap(c.task_id).last_activity_at,"runtime activity stamped");
 expect(errors).toEqual([]);expect(activitySnap(c.task_id).consumed_at).toBe(before.consumed_at);expect(activitySnap(c.task_id).status).toBe("running");
});
