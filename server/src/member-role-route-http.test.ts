// Regression tests for /api/networks/:id/members route matching & updateMemberRole validation.
//
// Bugs fixed:
// 1. updateMemberRole() previously only rejected "owner" without checking MEMBER_ROLES:
//    - missing role (e.g. {} or { task_access: "all" }) passed undefined to SQLite -> HTTP 500
//      ("NOT NULL constraint failed: network_members.role"), leaking DB schema.
//    - arbitrary role strings (e.g. "superadmin") succeeded with HTTP 200 and corrupted DB rows.
// 2. GET /api/networks/:id/members/:uid and POST /api/networks/:id/members/:uid previously matched
//    membersMatch without checking !targetUid, returning HTTP 200 (full member list) instead of 404.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register } from "./auth.js";
import { db } from "./db.js";

const DIR = mkdtempSync(join(tmpdir(), "anet-member-role-route-"));
let BASE = "";
let hub: any = null;

const PW = "MemberRouteTestPass0rd!";
let ownerToken = "";
let NET = "";
let bobId = "";

async function send(
  token: string,
  method: string,
  path: string,
  payload?: unknown,
  rawBody?: string,
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: rawBody !== undefined ? rawBody : payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch {}
  return { status: res.status, body };
}

function dbRole(userId: string): string | null {
  const row = db.get("SELECT role FROM network_members WHERE network_id = ?1 AND user_id = ?2", NET, userId) as
    { role: string } | null;
  return row?.role ?? null;
}

beforeAll(async () => {
  process.env.COMMHUB_DB ||= join(DIR, "hub.db");
  process.env.COMMHUB_UPLOADS_DIR = join(DIR, "uploads");
  process.env.HOST = "127.0.0.1";

  const owner = register(`mrr_owner_${Date.now()}`, PW, undefined, "Owner");
  expect(owner.ok).toBe(true);
  ownerToken = owner.token!;
  NET = owner.network_id!;

  const bob = register(`mrr_bob_${Date.now()}`, PW, undefined, "Bob");
  expect(bob.ok).toBe(true);
  bobId = bob.user!.user_id;

  const mod: any = await import("./server.js");
  hub = mod.bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${hub.port}`;

  const added = await send(ownerToken, "POST", `/api/networks/${NET}/members`, { user_id: bobId, role: "member" });
  expect(added.status).toBe(200);
}, 30_000);

afterAll(() => {
  try { hub?.stop?.(true); } catch {}
  try { rmSync(DIR, { recursive: true, force: true }); } catch {}
});

describe("PUT /api/networks/:id/members/:uid role validation", () => {
  test("missing role (empty body or unrelated field) returns 400 invalid role instead of 500", async () => {
    const r1 = await send(ownerToken, "PUT", `/api/networks/${NET}/members/${bobId}`, {});
    expect(r1.status).toBe(400);
    expect(r1.body?.error).toBe("invalid role");

    const r2 = await send(ownerToken, "PUT", `/api/networks/${NET}/members/${bobId}`, { task_access: "all" });
    expect(r2.status).toBe(400);
    expect(r2.body?.error).toBe("invalid role");
    expect(dbRole(bobId)).toBe("member");
  });

  test("arbitrary or non-string role is rejected with 400 invalid role and does not mutate DB", async () => {
    for (const bad of ["superadmin", "", "root", 123, null]) {
      const r = await send(ownerToken, "PUT", `/api/networks/${NET}/members/${bobId}`, { role: bad });
      expect(r.status).toBe(400);
      expect(r.body?.error).toBe("invalid role");
      expect(dbRole(bobId)).toBe("member");
    }
  });

  test("malformed JSON body returns 400 invalid JSON instead of 500", async () => {
    const r = await send(ownerToken, "PUT", `/api/networks/${NET}/members/${bobId}`, undefined, "{bad-json");
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("invalid JSON");
    expect(dbRole(bobId)).toBe("member");
  });

  test("assigning owner role stays rejected with 400 cannot assign owner role", async () => {
    const r = await send(ownerToken, "PUT", `/api/networks/${NET}/members/${bobId}`, { role: "owner" });
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe("cannot assign owner role");
    expect(dbRole(bobId)).toBe("member");
  });

  test("valid roles (admin / viewer / member) continue to succeed", async () => {
    for (const role of ["admin", "viewer", "member"] as const) {
      const r = await send(ownerToken, "PUT", `/api/networks/${NET}/members/${bobId}`, { role });
      expect(r.status).toBe(200);
      expect(r.body?.ok).toBe(true);
      expect(dbRole(bobId)).toBe(role);
    }
  });
});

describe("/api/networks/:id/members route matching boundaries", () => {
  test("GET /api/networks/:id/members returns member list (200)", async () => {
    const r = await send(ownerToken, "GET", `/api/networks/${NET}/members`);
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body?.members)).toBe(true);
    expect(r.body.members.length).toBe(2);
  });

  test("GET /api/networks/:id/members/:uid returns 404 instead of full member list", async () => {
    const r1 = await send(ownerToken, "GET", `/api/networks/${NET}/members/u_nonexistent_check`);
    expect(r1.status).toBe(404);
    expect(r1.body?.error).toBe("not_found");

    const r2 = await send(ownerToken, "GET", `/api/networks/${NET}/members/${bobId}`);
    expect(r2.status).toBe(404);
    expect(r2.body?.error).toBe("not_found");
  });

  test("POST /api/networks/:id/members/:uid returns 404 instead of member creation", async () => {
    const r = await send(ownerToken, "POST", `/api/networks/${NET}/members/${bobId}`, { user_id: bobId, role: "member" });
    expect(r.status).toBe(404);
    expect(r.body?.error).toBe("not_found");
  });
});
