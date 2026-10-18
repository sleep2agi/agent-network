import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";

process.env.COMMHUB_DB ||= `${mkdtempSync("/tmp/session689-")}/hub.db`;
let db: any, hub: ReturnType<typeof Bun.serve>, base: string;
let owner: any, holder: any, member: any, admin: any, outsider: any;
let generateNetworkToken: () => string, hashToken: (token: string) => string;
async function mint(actor: any, alias: string, nodeId?: string, network = owner.network_id) {
  const response = await fetch(`${base}/api/auth/node-token`, {
    method: "POST", headers: { Authorization: `Bearer ${actor.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ network_id: network, node_name: alias, ...(nodeId ? { node_id: nodeId } : {}) }),
  });
  return { status: response.status, body: await response.json() as any };
}
function session(alias: string, network = owner.network_id, nodeId: string | null = null) {
  db.run("INSERT INTO sessions(resume_id,alias,network_id,node_id,status) VALUES(?1,?2,?3,?4,'offline')",
    [crypto.randomUUID(), alias, network, nodeId]);
}
function credential(alias: string, actor = holder, options: { epoch?: number; revoked?: boolean; expired?: boolean; network?: string; bound?: string; scope?: string } = {}) {
  const id = crypto.randomUUID();
  db.run(`INSERT INTO api_tokens(token_id,token_hash,user_id,network_id,name,scope,node_identity_epoch,bound_node_id,revoked_at,expires_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
    [id, hashToken(generateNetworkToken()), actor.user.user_id, options.network ?? owner.network_id,
      `node:${alias}`, options.scope ?? "network", options.epoch ?? 0, options.bound ?? null,
      options.revoked ? "2000-01-01 00:00:00" : null, options.expired ? "2000-01-01 00:00:00" : null]);
}
function snapshot() {
  return {
    tokens: db.all("SELECT token_id,user_id,name,bound_node_id FROM api_tokens ORDER BY token_id"),
    sessions: db.all("SELECT resume_id,alias,network_id,node_id,status FROM sessions ORDER BY resume_id"),
    nodes: db.all("SELECT node_id,alias,network_id,owner_user_id FROM nodes ORDER BY node_id"),
    audits: db.all("SELECT id,action,target_id FROM audit_log ORDER BY id"),
  };
}
async function denied(actor: any, alias: string, nodeId?: string) {
  const before = snapshot();
  expect(await mint(actor, alias, nodeId)).toEqual({ status: 400, body: { ok: false, error: "node_owner_mismatch" } });
  expect(snapshot()).toEqual(before);
}
beforeAll(async () => {
  ({ db, generateNetworkToken, hashToken } = await import("./db.js"));
  const { register } = await import("./auth.js");
  owner = register("owner689", "Fixture-Strong1!");
  holder = register("holder689", "Fixture-Strong1!");
  member = register("member689", "Fixture-Strong1!");
  admin = register("admin689", "Fixture-Strong1!");
  outsider = register("outside689", "Fixture-Strong1!");
  for (const actor of [holder, member, admin]) {
    db.run("INSERT INTO network_members(network_id,user_id,role,agent_access) VALUES(?1,?2,?3,'all')",
      [owner.network_id, actor.user.user_id, actor === admin ? "admin" : "member"]);
  }
  const { bootServer } = await import("./server.js");
  hub = bootServer({ port: 0, hostname: "127.0.0.1" }); base = `http://127.0.0.1:${hub.port}`;
}, 60000);
afterAll(() => hub?.stop(true));

test("existing session requires authority for both request shapes without writes", async () => {
  session("existing689");
  await denied(member, "existing689");
  await denied(member, "existing689", "n_existing689");
});
test("network owner and administrator can restore a legacy identity", async () => {
  for (const [actor, alias] of [[owner, "restore-owner689"], [admin, "restore-admin689"]]) {
    session(alias);
    expect((await mint(actor, alias)).status).toBe(200);
    const withId = await mint(actor, alias, `n_${alias}`);
    expect(withId.status).toBe(200);
    expect(db.get("SELECT owner_user_id FROM nodes WHERE node_id=?1", `n_${alias}`).owner_user_id).toBe(actor.user.user_id);
  }
});
test("unique legacy holder can refresh without rewriting the session", async () => {
  session("holder-session689"); credential("holder-session689");
  await denied(member, "holder-session689");
  const before = db.get("SELECT * FROM sessions WHERE alias='holder-session689'");
  expect((await mint(holder, "holder-session689")).status).toBe(200);
  expect((await mint(holder, "holder-session689", "n_holder-session689")).status).toBe(200);
  expect(db.get("SELECT * FROM sessions WHERE alias='holder-session689'")).toEqual(before);
});
test("current name-only holder can refresh while registration is pending", async () => {
  expect((await mint(holder, "pending689")).status).toBe(200);
  session("pending689");
  await denied(member, "pending689", "n_pending689");
  expect((await mint(holder, "pending689")).status).toBe(200);
});
for (const [label, options] of [
  ["revoked", { revoked: true }], ["expired", { expired: true }],
  ["renamed-general", { epoch: 1 }], ["wrong-scope", { scope: "full" }],
  ["missing-bound-row", { bound: "n_missing689" }],
] as const) {
  test(`${label} credential is not session holder evidence`, async () => {
    const alias = `${label}689`; session(alias); credential(alias, holder, options);
    await denied(holder, alias);
  });
}
test("conflicting legacy holders need administrator recovery", async () => {
  session("ambiguous689"); credential("ambiguous689"); credential("ambiguous689", member);
  await denied(holder, "ambiguous689"); await denied(member, "ambiguous689", "n_ambiguous689");
  expect((await mint(admin, "ambiguous689")).status).toBe(200);
});
test("session and holder evidence stay in the requested network", async () => {
  session("foreign-session689", outsider.network_id);
  expect((await mint(member, "foreign-session689")).status).toBe(200);
  session("foreign-holder689"); credential("foreign-holder689", holder, { network: holder.network_id });
  await denied(holder, "foreign-holder689");
  expect((await mint(outsider, "foreign-holder689")).body.error).toBe("no write access to this network");
});
test("administrators do not bypass an existing node owner", async () => {
  db.run("INSERT INTO nodes(node_id,node_name,alias,network_id,owner_user_id) VALUES('n_owned689','owned689','owned689',?1,?2)",
    [owner.network_id, holder.user.user_id]);
  session("owned689", owner.network_id, "n_owned689");
  await denied(admin, "owned689"); await denied(owner, "owned689", "n_owned689");
  expect((await mint(holder, "owned689")).body.node_id).toBe("n_owned689");
});
test("viewer and restricted member gates still precede session recovery", async () => {
  session("restricted689"); credential("restricted689");
  db.run("UPDATE network_members SET agent_access='granted' WHERE network_id=?1 AND user_id=?2", [owner.network_id, holder.user.user_id]);
  try { expect((await mint(holder, "restricted689")).body.error).toBe("restricted members cannot create network tokens"); }
  finally { db.run("UPDATE network_members SET agent_access='all' WHERE network_id=?1 AND user_id=?2", [owner.network_id, holder.user.user_id]); }
  db.run("UPDATE network_members SET role='viewer' WHERE network_id=?1 AND user_id=?2", [owner.network_id, member.user.user_id]);
  try { expect((await mint(member, "restricted689")).body.error).toBe("no write access to this network"); }
  finally { db.run("UPDATE network_members SET role='member' WHERE network_id=?1 AND user_id=?2", [owner.network_id, member.user.user_id]); }
});
