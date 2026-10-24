// #993 first slice — network-scoped rules: GET / PUT /api/networks/:id/rules
//
// The contract this fixes:
//   * any member may READ (the rules are what nodes obey);
//   * only owner/admin may WRITE, and only with a matching `expected_revision`
//     (blind writes would let two people overwrite the document every node inherits);
//   * node tokens cannot write (user_token_required), and non-members cannot read;
//   * reads before any write report revision 0 with empty content, so a client can
//     create with `expected_revision: 0` and no special "create" path;
//   * size is capped in UTF-8 bytes.
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import "./require-explicit-test-db.js";
import { register } from "./auth.js";
import { db } from "./db.js";

let BASE = "";
let server: any = null;
let adminToken = "";
let memberToken = "";
let netId = "";
let nodeToken = "";

async function send(token: string, method: string, path: string, payload?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

beforeAll(async () => {
  process.env.HOST = "127.0.0.1";
  const suffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const pw = "NetworkRulesPw123Aa!";
  const a = register(`nr_admin_${suffix}`, pw, undefined, "admin");
  if (!a.ok) throw new Error("admin register failed");
  adminToken = a.token!;
  netId = a.network_id!;
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [a.user!.user_id]);

  // The server must be listening before any HTTP call below.
  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;

  const m = await send(adminToken, "POST", "/api/admin/users", { username: `nr_member_${suffix}`, password: pw, network_id: netId, role: "member" });
  expect(m.status).toBe(200);
  const login = await send("", "POST", "/api/auth/login", { username: `nr_member_${suffix}`, password: pw });
  expect(login.status).toBe(200);
  memberToken = login.body.token;

  const { createNetworkTokenForNode } = await import("./auth.js");
  const nt = createNetworkTokenForNode(a.user!.user_id, netId, "rules-node");
  expect(nt.ok).toBe(true);
  nodeToken = nt.token!;
}, 30_000);

afterAll(() => { try { server?.stop?.(true); } catch {} });

describe("#993 — network rules storage + CAS write", () => {
  test("a member reads an empty document as revision 0", async () => {
    const r = await send(memberToken, "GET", `/api/networks/${netId}/rules`);
    expect(r.status).toBe(200);
    expect(r.body.rules).toMatchObject({ network_id: netId, content: "", revision: 0, updated_at: null, updated_by: null });
  });

  test("a plain member cannot write", async () => {
    const r = await send(memberToken, "PUT", `/api/networks/${netId}/rules`, { content: "nope", expected_revision: 0 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("owner/admin required");
  });

  test("admin writes with expected_revision 0 and reads it back", async () => {
    const w = await send(adminToken, "PUT", `/api/networks/${netId}/rules`, {
      content: "# Team rules\n\n- be precise\n", expected_revision: 0,
    });
    expect(w.status).toBe(200);
    expect(w.body.rules.revision).toBe(1);
    expect(w.body.rules.updated_by.username).toBeTruthy();
    const r = await send(memberToken, "GET", `/api/networks/${netId}/rules`);
    expect(r.body.rules.content).toContain("be precise");
    expect(r.body.rules.revision).toBe(1);
  });

  test("a stale expected_revision is a 409, and nothing is overwritten", async () => {
    const w = await send(adminToken, "PUT", `/api/networks/${netId}/rules`, { content: "clobber", expected_revision: 0 });
    expect(w.status).toBe(409);
    expect(w.body.error).toBe("rules_revision_conflict");
    const r = await send(adminToken, "GET", `/api/networks/${netId}/rules`);
    expect(r.body.rules.content).toContain("be precise");
    expect(r.body.rules.revision).toBe(1);
  });

  test("a node token cannot write (user_token_required)", async () => {
    const r = await send(nodeToken, "PUT", `/api/networks/${netId}/rules`, { content: "x", expected_revision: 1 });
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("user_token_required");
  });

  test("oversized content is refused (bytes, not UTF-16 units)", async () => {
    const r = await send(adminToken, "PUT", `/api/networks/${netId}/rules`, { content: "a".repeat(256 * 1024 + 1), expected_revision: 1 });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("rules_too_large");
  });

  test("re-writing identical bytes is idempotent (revision does not move, changed=false)", async () => {
    // The next slice injects a managed block keyed by revision; a no-op save that
    // bumped the number would make every node rewrite its file for nothing.
    const before = (await send(adminToken, "GET", `/api/networks/${netId}/rules`)).body.rules;
    const w = await send(adminToken, "PUT", `/api/networks/${netId}/rules`, {
      content: before.content, expected_revision: before.revision,
    });
    expect(w.status).toBe(200);
    expect(w.body.changed).toBe(false);
    expect(w.body.rules.revision).toBe(before.revision);
    // …and a real edit still moves it.
    const w2 = await send(adminToken, "PUT", `/api/networks/${netId}/rules`, {
      content: before.content + "\n- one more line\n", expected_revision: before.revision,
    });
    expect(w2.status).toBe(200);
    expect(w2.body.changed).toBe(true);
    expect(w2.body.rules.revision).toBe(before.revision + 1);
  });

  test("the 256 KiB cap is the same ruler as write_node_rules_file", async () => {
    // 200 KiB used to be the cap here while node rules allowed 256 KiB — the same text
    // could fit in the Hub and then be refused at the node.
    const atCap = "a".repeat(256 * 1024);
    const rev = (await send(adminToken, "GET", `/api/networks/${netId}/rules`)).body.rules.revision;
    const ok = await send(adminToken, "PUT", `/api/networks/${netId}/rules`, { content: atCap, expected_revision: rev });
    expect(ok.status).toBe(200);
    const rev2 = ok.body.rules.revision;
    const over = await send(adminToken, "PUT", `/api/networks/${netId}/rules`, { content: atCap + "a", expected_revision: rev2 });
    expect(over.status).toBe(413);
  });

  test("deleting the network deletes its rules row (no orphans)", async () => {
    const own = register(`nr_del_${Date.now()}`, "DelPw123Aa!", undefined, "del");
    expect(own.ok).toBe(true);
    const put = await send(own.token!, "PUT", `/api/networks/${own.network_id}/rules`, { content: "team rules", expected_revision: 0 });
    expect(put.status).toBe(200);
    const del = await send(own.token!, "DELETE", `/api/networks/${own.network_id}`);
    expect(del.status).toBe(200);
    const left = db.get<{ cnt: number }>("SELECT COUNT(*) as cnt FROM network_rules WHERE network_id = ?1", own.network_id!);
    expect(left!.cnt).toBe(0);
  });

  test("a node token cannot read another network's rules", async () => {
    // The node token belongs to a hub admin (that is how it was minted), so the
    // hubAdmin branch alone would have allowed it. A node stays inside its network.
    const other = register(`nr_net2_${Date.now()}`, "OtherPw123Aa!", undefined, "net2");
    expect(other.ok).toBe(true);
    const r = await send(nodeToken, "GET", `/api/networks/${other.network_id}/rules`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_a_member");
  });

  test("a non-member cannot read", async () => {
    const other = register(`nr_other_${Date.now()}`, "OtherPw123Aa!", undefined, "other");
    expect(other.ok).toBe(true);
    const r = await send(other.token!, "GET", `/api/networks/${netId}/rules`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_a_member");
  });
});
