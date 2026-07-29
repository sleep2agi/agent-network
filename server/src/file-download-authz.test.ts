// #495 — file download authorization (P0 staged hotfix, PR #500).
//
// Before this fix, /api/files/:file_id only checked authentication.
// Any authenticated principal could download any file cross-network by
// guessing / obtaining a file_id.
//
// This suite spawns a real Bun.serve hub in-process and validates the
// allow-list (owner + admin + legacy-master + null-owner-DEV_OPEN).
// Same-network non-owner is EXPLICITLY out of scope in this stage —
// see PR body access matrix + follow-up #503. That "same-network peer
// returns 404" is an intentional carve-out here, not a bug.
//
// The DEV_OPEN branch is verified in a sibling test file
// (file-download-authz-dev-open.test.ts) because DEV_OPEN is captured
// at server.ts module-load time and can't be flipped mid-suite.
//
// Skip discipline: master-token tests use `test.skipIf(!masterTokenActive)`
// so aggregate `bun test src/` reports "skipped" (not "passed") when
// the loaded server module's frozen AUTH_TOKEN binding predates our
// env setup. `if (!x) return` was previously used and Bun records
// that as PASS — which is exactly the "skip-as-pass" trap that let
// an earlier round claim coverage it never had. (See project memory
// `feedback_skip_via_early_return_shows_as_pass`.)

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-495-db-")) + "/commhub.db";
const UPLOADS_DIR = mkdtempSync(join(tmpdir(), "anet-495-fs-"));
const MASTER_TOKEN = process.env.COMMHUB_AUTH_TOKEN ?? `master-495-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

// Set env BEFORE importing anything that pulls in db-adapter.ts (which
// refuses to open a default DB under NODE_ENV=test) or server.ts (which
// captures DEV_OPEN + AUTH_TOKEN at module load).
process.env.COMMHUB_DB = SERVER_DB;
process.env.COMMHUB_UPLOADS_DIR = UPLOADS_DIR;
process.env.HOST = "127.0.0.1";
process.env.COMMHUB_AUTH_TOKEN = MASTER_TOKEN;
delete process.env.COMMHUB_DEV_OPEN;

const { register, addNetworkMember, getUserAllNetworks } = await import("./auth.js");
const { db } = await import("./db.js");

// Seed accounts. register()'s "first-user-is-admin" is not reliable in
// aggregate (earlier test files may seed users), so we promote via SQL.
const adminName = `admin_495_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const rAdmin = register(adminName, "BootstrapPw123Aa!", undefined, "seed");
if (!rAdmin.ok) throw new Error(`admin register failed: ${rAdmin.error}`);
const adminToken = rAdmin.token!;
db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [rAdmin.user!.user_id]);

const nameA = `useraaa_495_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const rA = register(nameA, "BootstrapPw123Aa!", undefined, "userA");
if (!rA.ok) throw new Error(`userA register failed: ${rA.error}`);
const userAToken = rA.token!;
const userAUserId = rA.user!.user_id;

const nameB = `userbbb_495_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const rB = register(nameB, "BootstrapPw123Aa!", undefined, "userB");
if (!rB.ok) throw new Error(`userB register failed: ${rB.error}`);
const userBToken = rB.token!;
const userBUserId = rB.user!.user_id;
const userBNetworkToken = rB.network_token!;
const userBNetworkId = getUserAllNetworks(userBUserId)[0]?.network_id!;
if (!userBNetworkId) throw new Error("userB default network not found");

// Add userA as a member of userB's default network. This is what makes
// the "same-network non-owner" test cell meaningful — without it, that
// test would only prove cross-network denial, which is a weaker claim.
const addMember = addNetworkMember(userBNetworkId, userAUserId, "member", userBUserId);
if (!addMember.ok) throw new Error(`add userA to userB network failed: ${addMember.error}`);

const { bootServer } = await import("./server.js");
const server = bootServer({ port: 0, hostname: "127.0.0.1" });
const BASE = `http://127.0.0.1:${server.port}`;
await new Promise((r) => setTimeout(r, 100));

// Probe the loaded server's frozen AUTH_TOKEN binding. If master token
// works we can exercise the legacy branch; if not (aggregate load-order
// effect), `test.skipIf` reports "skipped" (NOT "passed").
const _probeMaster = await fetch(`${BASE}/api/files/00000000000000000000000000000000`, {
  headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
});
const masterTokenActive = _probeMaster.status === 404;

// Probe the loaded server's frozen DEV_OPEN binding. This file is
// meant to run against a DEV_OPEN=false server. In aggregate mode,
// if file-download-authz-dev-open.test.ts loaded server.ts first
// with DEV_OPEN=true, the singleton wins — we can't flip it. Skip
// the whole production-mode suite via `describe.skipIf` (NOT
// early-return in each test body) so the runner reports "skipped".
async function _uploadProbe(): Promise<number> {
  const form = new FormData();
  form.append("file", new Blob([new TextEncoder().encode("p")], { type: "application/octet-stream" }), "p");
  const r = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
  return r.status;
}
const devOpenSuspected = (await _uploadProbe()) === 200;
const isProdMode = !devOpenSuspected;

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

describe.skipIf(!isProdMode)("#495 — GET /api/files/:file_id authorization (owner-only staged)", () => {
  let userBFileId = "";

  beforeAll(async () => {
    userBFileId = await uploadAs(userBToken, new TextEncoder().encode("secret-from-B"), "b-secret.txt");
    expect(userBFileId.length).toBe(32);
  });

  test("owner (userB) via utok_ downloads own file → 200 (normal path)", async () => {
    const res = await downloadAs(userBToken, userBFileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("secret-from-B");
  });

  test("owner (userB) via ntok_ downloads own file → 200 (agent self-upload+self-download)", async () => {
    const agentFileId = await uploadAs(userBNetworkToken, new TextEncoder().encode("agent-blob"), "agent.bin");
    const res = await downloadAs(userBNetworkToken, agentFileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("agent-blob");
  });

  test("🔴 non-owner (userA) downloads userB's file → 404 (was 200 pre-#495)", async () => {
    const res = await downloadAs(userAToken, userBFileId);
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error).toBe("not_found");
  });

  test("🔴 same-network non-owner (userA is a member of userB's network) → 404 (STAGED carve-out; follow-up #503)", async () => {
    // Precondition — userA really is a member of userB's default
    // network (added in module setup). Guard the invariant so the
    // 404 result actually represents "same-network peer denied",
    // not "cross-network denied".
    const rows = db.all<{ network_id: string }>(
      "SELECT network_id FROM network_members WHERE user_id = ?1 AND network_id = ?2",
      userAUserId, userBNetworkId,
    );
    expect(rows.length).toBe(1);
    const res = await downloadAs(userAToken, userBFileId);
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error).toBe("not_found");
  });

  test("admin caller downloads any file → 200 (operational access preserved)", async () => {
    const res = await downloadAs(adminToken, userBFileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("secret-from-B");
  });

  test.skipIf(!masterTokenActive)("legacy master AUTH_TOKEN downloads any file → 200 (single-tenant deployments)", async () => {
    const res = await downloadAs(MASTER_TOKEN, userBFileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("secret-from-B");
  });

  test("anonymous request → 401 (auth still required)", async () => {
    const res = await downloadAs(null, userBFileId);
    expect(res.status).toBe(401);
  });

  test("non-owner request for an UNKNOWN file_id → 404 with same shape as owner-denied (no enumeration signal)", async () => {
    const res = await downloadAs(userAToken, "0123456789abcdef0123456789abcdef");
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error).toBe("not_found");
  });
});

describe.skipIf(!isProdMode)("#495 — null-owner policy in production (DEV_OPEN=off, non-admin/non-legacy)", () => {
  let nullOwnerFileId = "";

  beforeAll(async () => {
    // Simulate a legacy null-owner index entry by uploading normally
    // then rewriting the on-disk index to owner_id=null. This precisely
    // reproduces the shape a DEV_OPEN or legacy master upload would
    // create, without needing to spin up a second server in a
    // different mode.
    nullOwnerFileId = await uploadAs(userAToken, new TextEncoder().encode("legacy-blob"), "legacy.txt");
    const { readFileSync: rfs, writeFileSync: wfs } = await import("fs");
    const entryFile = join(UPLOADS_DIR, ".index", `${nullOwnerFileId}.json`);
    if (!existsSync(entryFile)) throw new Error(`index entry not found: ${entryFile}`);
    const entry = JSON.parse(rfs(entryFile, "utf-8"));
    entry.owner = null;
    entry.owner_id = null;
    wfs(entryFile, JSON.stringify(entry, null, 2));
  });

  test.skipIf(!masterTokenActive)("null-owner + legacy master → 200 (RFC-001 read-only backward-compat)", async () => {
    const res = await downloadAs(MASTER_TOKEN, nullOwnerFileId);
    expect(res.status).toBe(200);
  });

  test("null-owner + admin utok_ → 200 (operational access preserved)", async () => {
    const res = await downloadAs(adminToken, nullOwnerFileId);
    expect(res.status).toBe(200);
  });

  test("🔴 Test A (production default) — null-owner + normal user + DEV_OPEN off → 404 fail-closed", async () => {
    // Runtime invariant: this test file explicitly deletes COMMHUB_DEV_OPEN
    // at module setup, so the DEV_OPEN branch in authorizeFileDownload
    // MUST NOT execute here. If someone weakens the guard so that
    // null-owner is granted even without DEV_OPEN, this assertion turns
    // red. That IS the mutation self-check for the production carve-out.
    expect(process.env.COMMHUB_DEV_OPEN).toBeUndefined();
    const res = await downloadAs(userAToken, nullOwnerFileId);
    expect(res.status).toBe(404);
    const body: any = await res.json();
    expect(body.error).toBe("not_found");
  });
});
