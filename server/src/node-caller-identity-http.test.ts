// Caller identity goes through one resolver (resolveNodeCaller).
//
// Real HTTP, both SQLite and PostgreSQL:
//   cd server && COMMHUB_DB=/tmp/x.db bun test src/node-caller-identity-http.test.ts
//   PG: COMMHUB_TEST_PG_URL=… COMMHUB_PG_EXPERIMENTAL=1
//       (tests/node-caller-identity runs both, plus the two mutations)
//
// An unbound token with zero rows keeps the name in the token. First
// registration still depends on that. A bound token whose row is gone is
// refused and must not fall back to the name. The mutation harness deletes
// the shared owner check and expects every "caller identity boundary:"
// test to go assertion-red together (12). A second mutation restores a
// name lookup for a missing bound row and expects
// "bound row missing does not fall back to the name" to go red.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addNetworkMember, createNetworkTokenForNode, register } from "./auth.js";
import { db, generateNetworkToken, hashToken } from "./db.js";

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

test("refused report_status leaves the session and the token name unchanged", async () => {
  const before = sessionSnap(victimAlias, NET);
  const boundName = tokenName(victimTok.tokenId);
  const unboundName = tokenName(p10Owner.tokenId);
  expect(before).toBeTruthy();
  const mismatch = await tool(p10Owner.token, "report_status", {
    resume_id: `sdk-${victimAlias}`,
    alias: victimAlias,
    status: "working",
    output: "mutated-output",
    node_id: `n_idv_claim_${stamp}`,
    network_id: NET,
  });
  expect(mismatch.ok).toBe(false);
  expect(mismatch.error).toBe("alias_identity_mismatch");
  expect(sessionSnap(victimAlias, NET)).toEqual(before);
  expect(tokenName(p10Owner.tokenId)).toBe(unboundName);
  const wrongNode = await tool(victimTok.token, "report_status", {
    resume_id: `sdk-${victimAlias}`,
    alias: victimAlias,
    status: "working",
    output: "mutated-output",
    node_id: otherId,
    network_id: NET,
  });
  expect(wrongNode.ok).toBe(false);
  expect(wrongNode.error).toBe("alias_identity_mismatch");
  expect(sessionSnap(victimAlias, NET)).toEqual(before);
  expect(tokenName(victimTok.tokenId)).toBe(boundName);
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
  expect(sessionSnap(victimAlias, NET)).toEqual(before);
  expect(db.get("SELECT resume_id FROM sessions WHERE resume_id = ?1", `sdk-squat-${stamp}`)).toBeNull();
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
