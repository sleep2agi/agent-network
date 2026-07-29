// #495 — file download authorization: previously /api/files/:file_id
// only checked authentication (any resolved token), never ownership.
// Any authenticated principal could download any file cross-network by
// guessing / obtaining a file_id.
//
// This suite spawns a real Bun.serve hub in-process and validates the
// four axes of the fix:
//   1. Owner (utok_/ntok_) downloads their own file → 200 (normal path
//      preserved).
//   2. Non-owner (different utok_ in a different network) downloads
//      the same file_id → 404 (NOT 403 — 403 leaks existence and
//      enables enumeration).
//   3. Admin caller downloads any file → 200 (dashboard proxy /
//      operational access preserved).
//   4. Legacy master AUTH_TOKEN downloads any file → 200 (single-tenant
//      deployments preserved; deprecated path already read-only per
//      RFC-001).
// Plus null-owner rejection for non-admin, non-legacy callers.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { register, login } from "./auth.js";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-495-db-")) + "/commhub.db";
const UPLOADS_DIR = mkdtempSync(join(tmpdir(), "anet-495-fs-"));
// The server.ts AUTH_TOKEN binding is frozen at module first-load time
// (const AUTH_TOKEN = process.env.COMMHUB_AUTH_TOKEN). When this test
// file runs standalone (`bun test src/file-download-authz.test.ts`) we
// set the env before import and MASTER_TOKEN works. In aggregate
// (`bun test src/`) some other test file may have loaded server.ts
// first with AUTH_TOKEN unset → the master-token branch is inactive
// for the whole process. We detect that at boot and skip the two
// tests that depend on it; the fix's behaviour is fully covered by
// the utok_ + ntok_ + admin + null-owner tests either way.
const MASTER_TOKEN = process.env.COMMHUB_AUTH_TOKEN ?? `master-495-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
let masterTokenActive = false;

let BASE = "";
let server: any;
let adminToken = "";
let userAToken = "";
let userAUserId = "";
let userBToken = "";
let userBUserId = "";
let userBNetworkToken = ""; // ntok_ for userB — agent-node auth style

beforeAll(async () => {
  process.env.COMMHUB_DB = SERVER_DB;
  process.env.COMMHUB_UPLOADS_DIR = UPLOADS_DIR;
  process.env.HOST = "127.0.0.1";
  // Exercise the legacy master-token branch too so we can assert it
  // still works (backwards-compat property).
  process.env.COMMHUB_AUTH_TOKEN = MASTER_TOKEN;

  // First user is auto-admin. In aggregate `bun test src/` the db
  // singleton may already have users from earlier test files, so the
  // "first user" role assignment isn't guaranteed. We explicitly
  // promote our seed user to admin via direct SQL so this test's
  // admin coverage is deterministic across load orders.
  const adminName = `admin_495_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const r0 = register(adminName, "BootstrapPw123Aa!", undefined, "seed");
  if (!r0.ok) throw new Error(`admin register failed: ${r0.error}`);
  adminToken = r0.token!;
  const { db } = await import("./db.js");
  db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [r0.user!.user_id]);

  // Two normal users (in separate networks per register's default).
  const nameA = `useraaa_495_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const rA = register(nameA, "BootstrapPw123Aa!", undefined, "userA");
  if (!rA.ok) throw new Error(`userA register failed: ${rA.error}`);
  userAToken = rA.token!;
  userAUserId = rA.user!.user_id;

  const nameB = `userbbb_495_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const rB = register(nameB, "BootstrapPw123Aa!", undefined, "userB");
  if (!rB.ok) throw new Error(`userB register failed: ${rB.error}`);
  userBToken = rB.token!;
  userBUserId = rB.user!.user_id;
  userBNetworkToken = rB.network_token!; // ntok_ bound to B's default network

  const { bootServer } = await import("./server.js");
  server = bootServer({ port: 0, hostname: "127.0.0.1" });
  BASE = `http://127.0.0.1:${server.port}`;
  await new Promise((r) => setTimeout(r, 100));

  // Probe whether the loaded server module's frozen AUTH_TOKEN
  // binding matches our master token. If not (aggregate-mode load
  // order effect), skip the master-token cases — behaviour is
  // covered elsewhere in this file for the code paths we can reach.
  const probe = await fetch(`${BASE}/api/files/00000000000000000000000000000000`, {
    headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
  });
  // 401 → master token binding is inactive (frozen at other value);
  // 404 → binding active, request passed auth then hit "not found".
  masterTokenActive = probe.status === 404;
});

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(UPLOADS_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(SERVER_DB, { recursive: true, force: true }); } catch {}
  delete process.env.COMMHUB_AUTH_TOKEN;
});

async function uploadAs(token: string, content: Uint8Array, filename: string): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([content], { type: "application/octet-stream" }), filename);
  const res = await fetch(`${BASE}/api/upload`, {
    method: "POST",
    body: form,
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body: any = await res.json();
  expect(typeof body.file_id).toBe("string");
  return body.file_id;
}

async function downloadAs(token: string | null, fileId: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}/api/files/${fileId}`, { headers });
}

describe("#495 — GET /api/files/:file_id authorization", () => {
  let userBFileId = "";

  beforeAll(async () => {
    userBFileId = await uploadAs(userBToken, new TextEncoder().encode("secret-from-B"), "b-secret.txt");
    expect(userBFileId.length).toBe(32);
  });

  test("owner (userB) downloads own file → 200 (normal path preserved)", async () => {
    const res = await downloadAs(userBToken, userBFileId);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("secret-from-B");
  });

  test("owner via ntok_ (agent-node self-download) downloads own file → 200 (agent self-upload+self-download preserved)", async () => {
    // Agent uploads under its own ntok_ then reads back — the ntok_'s
    // resolved user_id matches the file's owner_id (both are userB).
    // This is the primary agent-node file-attach flow.
    const agentFileId = await uploadAs(userBNetworkToken, new TextEncoder().encode("agent-blob"), "agent.bin");
    const res = await downloadAs(userBNetworkToken, agentFileId);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("agent-blob");
  });

  test("cross-network ntok_ (userA's ntok would fail) — using userA's utok as proxy — still 404 on userB's file", async () => {
    // Any authenticated principal that is NOT userB and NOT admin
    // must not read userB's file. utok_ is the strictest test here
    // (broader than ntok_ scoping).
    const res = await downloadAs(userAToken, userBFileId);
    expect(res.status).toBe(404);
  });

  test("🔴 non-owner (userA) downloads userB's file → 404 (was 200 before #495)", async () => {
    const res = await downloadAs(userAToken, userBFileId);
    expect(res.status).toBe(404);
    const body: any = await res.json();
    // MUST be indistinguishable from an unknown file_id — no leak
    // of "the file exists but you can't have it".
    expect(body.error).toBe("not_found");
  });

  test("admin caller downloads any file → 200 (dashboard proxy / operational access preserved)", async () => {
    const res = await downloadAs(adminToken, userBFileId);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("secret-from-B");
  });

  test("legacy master AUTH_TOKEN downloads any file → 200 (single-tenant deployments preserved)", async () => {
    if (!masterTokenActive) {
      // See top-of-file note: this test only exercises the master-
      // token branch when the server.ts module was loaded with our
      // COMMHUB_AUTH_TOKEN in env. In aggregate `bun test src/` some
      // other file may load server.ts first without it. The branch's
      // behaviour is proved by running this file standalone.
      return;
    }
    const res = await downloadAs(MASTER_TOKEN, userBFileId);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("secret-from-B");
  });

  test("anonymous request → 401 (auth still required)", async () => {
    const res = await downloadAs(null, userBFileId);
    expect(res.status).toBe(401);
  });

  test("non-owner request for an UNKNOWN file_id → 404 with same shape as forbidden-owner (no enumeration signal)", async () => {
    const res = await downloadAs(userAToken, "0123456789abcdef0123456789abcdef");
    expect(res.status).toBe(404);
    const body: any = await res.json();
    // Both branches emit `not_found`; the responses are
    // observationally indistinguishable to an unauthorized caller.
    expect(body.error).toBe("not_found");
  });
});

describe("#495 — null-owner (legacy / DEV_OPEN uploads) policy", () => {
  // Legacy master AUTH_TOKEN can no longer POST /api/upload (only
  // read-only, per RFC-001 deprecation at server.ts:147 requireAuth),
  // so null-owner files in production arise from either:
  //   - files uploaded during a prior deployment where owner tracking
  //     didn't exist (historical), or
  //   - files uploaded in DEV_OPEN mode (authCtx null → owner_id null)
  // We reproduce it by uploading as a user, then rewriting the index
  // entry to owner_id=null in-place. This precisely simulates a
  // legacy blob without needing to spin up a second server instance
  // in DEV_OPEN mode (which would break other tests in this suite).
  let nullOwnerFileId = "";

  beforeAll(async () => {
    // Upload via userA (any authenticated user works — the point is
    // to land the blob + a valid index entry) then rewrite the entry.
    nullOwnerFileId = await uploadAs(userAToken, new TextEncoder().encode("legacy-blob"), "legacy.txt");

    // Rewrite the on-disk index entry to have owner_id=null. The
    // layout is `<UPLOADS_DIR>/.index/<file_id>.json` per
    // uploads.ts:indexEntryPath.
    const { readFileSync: rfs, writeFileSync: wfs } = await import("fs");
    const entryFile = join(UPLOADS_DIR, ".index", `${nullOwnerFileId}.json`);
    if (!existsSync(entryFile)) throw new Error(`index entry not found: ${entryFile}`);
    const entry = JSON.parse(rfs(entryFile, "utf-8"));
    entry.owner = null;
    entry.owner_id = null;
    wfs(entryFile, JSON.stringify(entry, null, 2));
  });

  test("null-owner file — legacy master token → 200 (backward compat, read-only branch)", async () => {
    if (!masterTokenActive) return;
    const res = await downloadAs(MASTER_TOKEN, nullOwnerFileId);
    expect(res.status).toBe(200);
  });

  test("null-owner file — admin utok_ → 200 (operational access preserved)", async () => {
    const res = await downloadAs(adminToken, nullOwnerFileId);
    expect(res.status).toBe(200);
  });

  test("🔴 null-owner file — normal user utok_ → 404 (closes vuln; no cross-user legitimate share exists)", async () => {
    const res = await downloadAs(userAToken, nullOwnerFileId);
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error).toBe("not_found");
  });
});
