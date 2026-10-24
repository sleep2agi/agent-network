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
    const r = await send(adminToken, "PUT", `/api/networks/${netId}/rules`, { content: "a".repeat(200 * 1024 + 1), expected_revision: 1 });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe("rules_too_large");
  });

  test("a non-member cannot read", async () => {
    const other = register(`nr_other_${Date.now()}`, "OtherPw123Aa!", undefined, "other");
    expect(other.ok).toBe(true);
    const r = await send(other.token!, "GET", `/api/networks/${netId}/rules`);
    expect(r.status).toBe(403);
    expect(r.body.error).toBe("not_a_member");
  });
});
