// #503 — network scope for /api/files/:file_id + upload attribution.
//
// #495/#500 gave downloads an owner-only allow-list and explicitly
// deferred "same-network non-owner" to this issue. This suite covers
// both halves of the fix:
//   • upload decides WHICH network a blob belongs to (U rows), and
//   • download decides who may read a blob given that network (D rows),
// plus the enumeration-oracle rows (E) that pin denied responses to be
// byte-identical to "no such thing".
//
// FIXTURE DISCIPLINE — the whole suite is worthless if a probe is admin.
// `authorizeFileDownload` returns true for admin-utok before it ever
// looks at the network, so an admin probe passes every D row while
// proving nothing. commhub auto-promotes the FIRST registered user to
// admin (auth.ts register(): `isFirstUser ? "admin" : "user"`), so:
//   1. a throwaway `seedUser` is registered first to occupy that slot,
//   2. every non-admin probe is registered after it, and
//   3. each row re-reads the probe's role from the DB and asserts it is
//      not admin — inline, not via a helper, so the assertion cannot be
//      deleted in one place and lost everywhere.
// See project memory feedback_first_registered_user_is_admin_fake_green.
//
// DEV_OPEN rows live in file-network-scope-dev-open.test.ts: DEV_OPEN is
// captured at server.ts module-load time and cannot be flipped mid-suite
// (same reason #500 split its DEV_OPEN coverage into a sibling file).

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
// Type-only — erased at runtime, so it cannot pull server.ts in before
// the env below is set.
import type { Principal } from "./server.js";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-503-db-")) + "/commhub.db";
const UPLOADS_DIR = mkdtempSync(join(tmpdir(), "anet-503-fs-"));
const MASTER_TOKEN = `master-503-${Date.now()}-${Math.floor(Math.random() * 100000)}`;

// Env must be set before anything pulls in db-adapter.ts (which refuses
// the default DB under NODE_ENV=test) or server.ts (which freezes
// DEV_OPEN + AUTH_TOKEN at module load).
process.env.COMMHUB_DB = SERVER_DB;
process.env.COMMHUB_UPLOADS_DIR = UPLOADS_DIR;
process.env.HOST = "127.0.0.1";
process.env.COMMHUB_AUTH_TOKEN = MASTER_TOKEN;
delete process.env.COMMHUB_DEV_OPEN;

const { register, addNetworkMember, createNetworkTokenForNode } = await import("./auth.js");
const { db } = await import("./db.js");

const STAMP = `${Date.now()}${Math.floor(Math.random() * 100000)}`;

type Probe = {
  name: string;
  userId: string;
  token: string;      // utok_
  ntok: string;       // ntok_ bound to their own default network
  networkId: string;  // their own auto-created default network
};

function reg(label: string): Probe {
  const name = `u503${label}${STAMP}`;
  const r = register(name, "BootstrapPw123Aa!", undefined, label);
  if (!r.ok) throw new Error(`${label} register failed: ${r.error}`);
  return {
    name,
    userId: r.user!.user_id,
    token: r.token!,
    ntok: r.network_token!,
    networkId: r.network_id!,
  };
}

function roleOf(userId: string): string | null {
  return db.get<{ role: string }>("SELECT role FROM users WHERE user_id = ?1", userId)?.role ?? null;
}

// 1. Occupies the auto-admin slot so no probe below can inherit it.
const seedUser = reg("seed");
// 2. The admin probe is promoted explicitly rather than relying on
//    registration order, which is not stable under aggregate runs.
const adminUser = reg("admin");
db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [adminUser.userId]);
// 3. Non-admin probes.
const nonAdminUserA = reg("usera");
const nonAdminUserB = reg("userb");
const outsiderUser = reg("outsider");
const viewerOnlyUser = reg("vieweronly");
const mixedUser = reg("mixed");
// 4. Additional admins with different network-membership counts for
//    F2=F auto-derive (U11a/b/c). adminUser is multi-network (own
//    default + N1 below, → U11b). adminSingleUser stays single-network
//    on its own default → U11a. adminZeroUser has zero memberships
//    (own default is dropped below) → U11c.
const adminSingleUser = reg("adminsingle");
db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [adminSingleUser.userId]);
const adminZeroUser = reg("adminzero");
db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [adminZeroUser.userId]);
db.run("DELETE FROM network_members WHERE user_id = ?1", [adminZeroUser.userId]);

// N1 is userA's own default network — userA stays single-network so the
// "no query param, unambiguous membership" upload path (U6) is reachable.
const N1 = nonAdminUserA.networkId;
// N2 is userB's own default network. userB also joins N1, making userB
// multi-network (U7/U8) and a same-network non-owner peer of userA (D3).
const N2 = nonAdminUserB.networkId;
// N3 exists but userB is not a member — the "not yours" upload row (U9).
const N3 = seedUser.networkId;
const N_FAKE = `net_503fake${STAMP}`;

if (!addNetworkMember(N1, nonAdminUserB.userId, "member", nonAdminUserA.userId).ok) {
  throw new Error("fixture: userB → N1 member failed");
}
// The admin needs write access to N1 to be issued a node ntok_ there
// (createNetworkTokenForNode refuses non-members and viewers). That
// token is the D15 probe: a ntok_ ISSUED BY an admin.
if (!addNetworkMember(N1, adminUser.userId, "member", nonAdminUserA.userId).ok) {
  throw new Error("fixture: admin → N1 member failed");
}
// viewerOnlyUser must hold exactly one network, with role viewer, so the
// "no param + unambiguous network + no write access" row (U13) is
// reachable. register() makes everyone owner of a default network, so
// that membership is dropped here.
db.run("DELETE FROM network_members WHERE user_id = ?1", [viewerOnlyUser.userId]);
if (!addNetworkMember(N1, viewerOnlyUser.userId, "viewer", nonAdminUserA.userId).ok) {
  throw new Error("fixture: viewerOnly → N1 viewer failed");
}
// mixedUser can write in N1 but only read in N2 — U14 asserts that an
// explicit param pointing at the viewer network is refused.
if (!addNetworkMember(N1, mixedUser.userId, "member", nonAdminUserA.userId).ok) {
  throw new Error("fixture: mixed → N1 member failed");
}
if (!addNetworkMember(N2, mixedUser.userId, "viewer", nonAdminUserB.userId).ok) {
  throw new Error("fixture: mixed → N2 viewer failed");
}

const adminNtokN1 = createNetworkTokenForNode(adminUser.userId, N1, "d15probe");
if (!adminNtokN1.ok) throw new Error(`fixture: admin ntok_ on N1 failed: ${adminNtokN1.error}`);

const { bootServer, authorizeFileDownload, normalizeEntry } = await import("./server.js");
const server = bootServer({ port: 0, hostname: "127.0.0.1" });
const BASE = `http://127.0.0.1:${server.port}`;
await new Promise((r) => setTimeout(r, 100));

// The loaded server module's AUTH_TOKEN binding may predate our env in
// an aggregate run. Probe it and `skipIf` the legacy-master rows so the
// runner reports "skipped", never "passed".
const _probeMaster = await fetch(`${BASE}/api/files/00000000000000000000000000000000`, {
  headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
});
const masterTokenActive = _probeMaster.status === 404;

// This file asserts production semantics; if a sibling loaded server.ts
// with DEV_OPEN=1 first, the singleton wins and these rows would be
// measuring the wrong build.
async function _anonUploadStatus(): Promise<number> {
  const form = new FormData();
  form.append("file", new Blob([new TextEncoder().encode("p")]), "p.bin");
  const r = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
  return r.status;
}
const isProdMode = (await _anonUploadStatus()) !== 200;

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(UPLOADS_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(SERVER_DB, { recursive: true, force: true }); } catch {}
  delete process.env.COMMHUB_AUTH_TOKEN;
});

// ── helpers ────────────────────────────────────────────────────────────

function uploadUrl(networkId?: string): string {
  return networkId ? `${BASE}/api/upload?network_id=${encodeURIComponent(networkId)}` : `${BASE}/api/upload`;
}

async function upload(token: string | null, body: string, filename: string, networkId?: string): Promise<Response> {
  const form = new FormData();
  form.append("file", new Blob([new TextEncoder().encode(body)], { type: "application/octet-stream" }), filename);
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(uploadUrl(networkId), { method: "POST", body: form, headers });
}

async function uploadOk(token: string, body: string, filename: string, networkId?: string): Promise<string> {
  const res = await upload(token, body, filename, networkId);
  if (res.status !== 200) throw new Error(`upload expected 200, got ${res.status}: ${await res.text()}`);
  const json: any = await res.json();
  return json.file_id;
}

function entryPath(fileId: string): string {
  return join(UPLOADS_DIR, ".index", `${fileId}.json`);
}

function readEntry(fileId: string): any {
  return JSON.parse(readFileSync(entryPath(fileId), "utf-8"));
}

function writeEntry(fileId: string, entry: any): void {
  writeFileSync(entryPath(fileId), JSON.stringify(entry, null, 2));
}

async function download(token: string | null, fileId: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}/api/files/${fileId}`, { headers });
}

async function head(token: string | null, fileId: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(`${BASE}/api/files/${fileId}`, { method: "HEAD", headers });
}

const UNKNOWN_FILE_ID = "0123456789abcdef0123456789abcdef";

// Files used by the D rows. Built once, in beforeAll, through the real
// upload path so the D rows read what the U rows actually write.
let fileInN1 = "";
let fileInN2 = "";
let legacyOwnedByA = "";
let legacyNullOwner = "";

describe.skipIf(!isProdMode)("#503 — fixture integrity", () => {
  test("probes are registered after the auto-admin slot is taken, and are not admin", () => {
    expect(roleOf(nonAdminUserA.userId)).not.toBe("admin");
    expect(roleOf(nonAdminUserB.userId)).not.toBe("admin");
    expect(roleOf(outsiderUser.userId)).not.toBe("admin");
    expect(roleOf(viewerOnlyUser.userId)).not.toBe("admin");
    expect(roleOf(mixedUser.userId)).not.toBe("admin");
    // The admin probe must really be admin, or D6/D10/D14/U10b/U11/U12
    // would be measuring a non-admin and silently prove nothing.
    expect(roleOf(adminUser.userId)).toBe("admin");
    // F2=F auto-derive probes: adminSingleUser must be admin AND in exactly
    // one network; adminZeroUser must be admin AND in zero networks.
    // Fixture drift on either turns U11a/U11c into vacuously-true tests.
    expect(roleOf(adminSingleUser.userId)).toBe("admin");
    expect(roleOf(adminZeroUser.userId)).toBe("admin");
  });

  test("network membership is shaped as the matrix assumes", () => {
    const memberships = (userId: string) =>
      db.all<{ network_id: string; role: string }>(
        "SELECT network_id, role FROM network_members WHERE user_id = ?1", userId,
      );
    // userA single-network (U6 depends on it being unambiguous).
    expect(memberships(nonAdminUserA.userId).map((r) => r.network_id)).toEqual([N1]);
    // userB multi-network (U7 depends on it being ambiguous).
    expect(memberships(nonAdminUserB.userId).map((r) => r.network_id).sort()).toEqual([N1, N2].sort());
    // outsider is in neither N1 nor N2 (D4 depends on it).
    expect(memberships(outsiderUser.userId).some((r) => r.network_id === N1)).toBe(false);
    // viewerOnly holds exactly one network, as viewer (U13 depends on both).
    expect(memberships(viewerOnlyUser.userId)).toEqual([{ network_id: N1, role: "viewer" }]);
    // N_FAKE really does not exist (U10a/U10b/E8/E9 depend on it).
    expect(db.get<any>("SELECT * FROM networks WHERE network_id = ?1", N_FAKE)).toBeFalsy();
    // N3 really does exist and userB really is not in it (U9 must be
    // "exists but not yours", not accidentally "does not exist").
    expect(db.get<any>("SELECT * FROM networks WHERE network_id = ?1", N3)).toBeTruthy();
    expect(memberships(nonAdminUserB.userId).some((r) => r.network_id === N3)).toBe(false);
  });
});

// ── Upload matrix ──────────────────────────────────────────────────────

describe.skipIf(!isProdMode)("#503 U — upload network attribution", () => {
  // U1/U2 as designed assumed a legacy master could upload. It cannot:
  // requireAuth 401s master tokens on every non-GET /api/ request since
  // RFC-001 made them read-only, so the `legacy-master` upload branch is
  // unreachable. These two rows pin that fact instead — if RFC-001's
  // read-only rule is ever relaxed, they go red and the unattributed-write
  // question has to be answered deliberately rather than by accident.
  test.skipIf(!masterTokenActive)("U1: legacy master upload, no param → 401 (master tokens are read-only, RFC-001)", async () => {
    const res = await upload(MASTER_TOKEN, "u1", "u1.bin");
    expect(res.status).toBe(401);
  });

  test.skipIf(!masterTokenActive)("U2: legacy master upload, param=N1 → 401 (a query param does not buy write access)", async () => {
    const res = await upload(MASTER_TOKEN, "u2", "u2.bin", N1);
    expect(res.status).toBe(401);
    // Same token CAN read — proves the 401 is about the write verb, not a
    // dead/misconfigured master token (which would make U1 vacuous).
    const readBack = await fetch(`${BASE}/api/files/${UNKNOWN_FILE_ID}`, {
      headers: { Authorization: `Bearer ${MASTER_TOKEN}` },
    });
    expect(readBack.status).toBe(404);
  });

  test("U4: ntok_(N1), no param → 200 and entry.network_id === N1 (bound network is the attribution)", async () => {
    const fileId = await uploadOk(nonAdminUserA.ntok, "u4", "u4.bin");
    expect(readEntry(fileId).network_id).toBe(N1);
  });

  test("U5: ntok_(N1), param=N2 → 400 network_id_conflict (never silently overridden)", async () => {
    const res = await upload(nonAdminUserA.ntok, "u5", "u5.bin", N2);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("network_id_conflict");
    // The conflicting network must not have been written to either.
    expect(db.get<any>("SELECT * FROM networks WHERE network_id = ?1", N2)).toBeTruthy();
  });

  test("U6: utok_ single-network non-admin, no param → 200 and entry.network_id === N1", async () => {
    expect(roleOf(nonAdminUserA.userId)).not.toBe("admin");
    const fileId = await uploadOk(nonAdminUserA.token, "u6", "u6.bin");
    expect(readEntry(fileId).network_id).toBe(N1);
  });

  test("U7: utok_ multi-network non-admin, no param → 400 network_id_required ('first network' is never assumed)", async () => {
    expect(roleOf(nonAdminUserB.userId)).not.toBe("admin");
    const res = await upload(nonAdminUserB.token, "u7", "u7.bin");
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("network_id_required");
  });

  test("U8: utok_ multi-network non-admin, param=N1 (a network they belong to) → 200 and entry.network_id === N1", async () => {
    expect(roleOf(nonAdminUserB.userId)).not.toBe("admin");
    const fileId = await uploadOk(nonAdminUserB.token, "u8", "u8.bin", N1);
    expect(readEntry(fileId).network_id).toBe(N1);
  });

  // U9/U10a as designed expected a 404 emitted by the upload handler.
  // The request never reaches it: every REST /api endpoint already passes
  // through a shared network-scope guard (server.ts, `restScope.denied`)
  // that 403s a non-member's ?network_id=. The security property the
  // design wanted — a non-admin cannot tell "exists, not yours" from "no
  // such network" — holds there instead, and E8 pins it byte-for-byte.
  test("U9: utok_ non-admin, param=N3 (exists, not a member) → 403 at the shared REST scope guard", async () => {
    expect(roleOf(nonAdminUserB.userId)).not.toBe("admin");
    const res = await upload(nonAdminUserB.token, "u9", "u9.bin", N3);
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("access denied to requested network");
  });

  test("U10a: utok_ non-admin, param=N_FAKE (does not exist) → 403, indistinguishable from U9", async () => {
    expect(roleOf(nonAdminUserB.userId)).not.toBe("admin");
    const res = await upload(nonAdminUserB.token, "u10a", "u10a.bin", N_FAKE);
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("access denied to requested network");
  });

  test("U10b: admin utok_, param=N_FAKE → 400 unknown_network (admin already knows the network list; no oracle)", async () => {
    expect(roleOf(adminUser.userId)).toBe("admin");
    const res = await upload(adminUser.token, "u10b", "u10b.bin", N_FAKE);
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("unknown_network");
  });

  // #503 Finding 2 = Option F (lead 40be9845): admin gets the same
  // "auto-derive when unambiguous / require param when ambiguous"
  // rule as utok_. Split old U11 into three rows to pin all three
  // membership shapes.
  test("U11a: admin utok_, EXACTLY 1 network membership, no param → 200 and entry.network_id === that network (F auto-derive)", async () => {
    expect(roleOf(adminSingleUser.userId)).toBe("admin");
    const singleNet = db.all<{ network_id: string }>(
      "SELECT network_id FROM network_members WHERE user_id = ?1", adminSingleUser.userId,
    );
    expect(singleNet.length).toBe(1);
    const fileId = await uploadOk(adminSingleUser.token, "u11a", "u11a.bin");
    expect(readEntry(fileId).network_id).toBe(singleNet[0].network_id);
  });

  test("U11b: admin utok_, ≥2 network memberships, no param → 400 network_id_required (strict on ambiguity)", async () => {
    expect(roleOf(adminUser.userId)).toBe("admin");
    const multi = db.all<{ network_id: string }>(
      "SELECT network_id FROM network_members WHERE user_id = ?1", adminUser.userId,
    );
    expect(multi.length).toBeGreaterThanOrEqual(2);
    const res = await upload(adminUser.token, "u11b", "u11b.bin");
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("network_id_required");
  });

  test("U11c: admin utok_, ZERO network memberships, no param → 400 network_id_required (no unowned files even for admin)", async () => {
    expect(roleOf(adminZeroUser.userId)).toBe("admin");
    const zero = db.all<{ network_id: string }>(
      "SELECT network_id FROM network_members WHERE user_id = ?1", adminZeroUser.userId,
    );
    expect(zero.length).toBe(0);
    const res = await upload(adminZeroUser.token, "u11c", "u11c.bin");
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toBe("network_id_required");
  });

  test("U12: admin utok_, param=N1 → 200 and entry.network_id === N1", async () => {
    const fileId = await uploadOk(adminUser.token, "u12", "u12.bin", N1);
    expect(readEntry(fileId).network_id).toBe(N1);
  });

  test("U13: utok_ viewer, single network, no param → 403 permission_denied (read-only role cannot write)", async () => {
    expect(roleOf(viewerOnlyUser.userId)).not.toBe("admin");
    const res = await upload(viewerOnlyUser.token, "u13", "u13.bin");
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("permission_denied");
  });

  test("U14: utok_ member of N1 but viewer in N2, param=N2 → 403 permission_denied", async () => {
    expect(roleOf(mixedUser.userId)).not.toBe("admin");
    const res = await upload(mixedUser.token, "u14", "u14.bin", N2);
    expect(res.status).toBe(403);
    expect((await res.json() as any).error).toBe("permission_denied");
    // Same caller CAN write to the network where they hold member — proves
    // the 403 above is about the role in N2, not a blanket denial.
    const okFileId = await uploadOk(mixedUser.token, "u14ok", "u14ok.bin", N1);
    expect(readEntry(okFileId).network_id).toBe(N1);
  });
});

// ── Download matrix ────────────────────────────────────────────────────

describe.skipIf(!isProdMode)("#503 D — download network scope", () => {
  beforeAll(async () => {
    fileInN1 = await uploadOk(nonAdminUserA.token, "payload-N1", "n1.bin");
    fileInN2 = await uploadOk(nonAdminUserB.token, "payload-N2", "n2.bin", N2);
    expect(readEntry(fileInN1).network_id).toBe(N1);
    expect(readEntry(fileInN2).network_id).toBe(N2);

    // Legacy entries: uploaded through the real path, then stripped of
    // network_id so they carry the exact on-disk shape of a pre-#503
    // blob. `delete` (not `= null`) matches the writer, which omits the
    // key entirely when there is no attribution.
    legacyOwnedByA = await uploadOk(nonAdminUserA.token, "payload-legacy-A", "legacy-a.bin");
    const eA = readEntry(legacyOwnedByA);
    delete eA.network_id;
    writeEntry(legacyOwnedByA, eA);

    legacyNullOwner = await uploadOk(nonAdminUserA.token, "payload-legacy-null", "legacy-null.bin");
    const eN = readEntry(legacyNullOwner);
    delete eN.network_id;
    eN.owner = null;
    eN.owner_id = null;
    writeEntry(legacyNullOwner, eN);

    expect("network_id" in readEntry(legacyOwnedByA)).toBe(false);
    expect("network_id" in readEntry(legacyNullOwner)).toBe(false);
  });

  test("D1: ntok_ bound to N1 reads a file in N1 → 200", async () => {
    const res = await download(nonAdminUserA.ntok, fileInN1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payload-N1");
  });

  test("🔴 D2: ntok_ bound to N2 reads a file in N1 → 404 (the cross-network leak #503 closes)", async () => {
    const res = await download(nonAdminUserB.ntok, fileInN1);
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe("not_found");
  });

  test("D3: utok_ non-admin who is a member of N1 reads a file in N1 → 200 (the carve-out #495 deferred)", async () => {
    expect(roleOf(nonAdminUserB.userId)).not.toBe("admin");
    // userB is a same-network peer, not the owner — that distinction is
    // the whole point of the row.
    expect(readEntry(fileInN1).owner_id).toBe(nonAdminUserA.userId);
    expect(readEntry(fileInN1).owner_id).not.toBe(nonAdminUserB.userId);
    const res = await download(nonAdminUserB.token, fileInN1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payload-N1");
  });

  test("🔴 D4: utok_ non-admin who is not a member of N1 reads a file in N1 → 404", async () => {
    expect(roleOf(outsiderUser.userId)).not.toBe("admin");
    const res = await download(outsiderUser.token, fileInN1);
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe("not_found");
  });

  test("D5: utok_ non-admin with role viewer in N1 reads a file in N1 → 200 (viewer is read-only, not read-never)", async () => {
    expect(roleOf(viewerOnlyUser.userId)).not.toBe("admin");
    const res = await download(viewerOnlyUser.token, fileInN1);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payload-N1");
  });

  test("D6: admin utok_ reads a file in a network → 200 (operational access preserved)", async () => {
    expect(roleOf(adminUser.userId)).toBe("admin");
    const res = await download(adminUser.token, fileInN2);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payload-N2");
  });

  test.skipIf(!masterTokenActive)("D7: legacy master reads a file in a network → 200 (single-tenant deployments)", async () => {
    const res = await download(MASTER_TOKEN, fileInN2);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payload-N2");
  });

  test("D8: utok_ non-admin owner reads their own legacy (no network_id) file → 200", async () => {
    expect(roleOf(nonAdminUserA.userId)).not.toBe("admin");
    const res = await download(nonAdminUserA.token, legacyOwnedByA);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("payload-legacy-A");
  });

  test("🔴 D9: utok_ non-admin non-owner reads someone else's legacy file → 404 (owner match did not widen)", async () => {
    expect(roleOf(nonAdminUserB.userId)).not.toBe("admin");
    // userB shares network N1 with the owner — under the legacy branch
    // that must NOT be enough, or the compat path would become a hole
    // wider than the network branch it stands in for.
    expect(db.all("SELECT 1 FROM network_members WHERE user_id = ?1 AND network_id = ?2",
      nonAdminUserB.userId, N1).length).toBe(1);
    const res = await download(nonAdminUserB.token, legacyOwnedByA);
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe("not_found");
  });

  test("D10: admin utok_ reads a legacy file → 200 (存量可读性不变)", async () => {
    const res = await download(adminUser.token, legacyOwnedByA);
    expect(res.status).toBe(200);
  });

  test.skipIf(!masterTokenActive)("D11: legacy master reads a legacy file → 200", async () => {
    const res = await download(MASTER_TOKEN, legacyOwnedByA);
    expect(res.status).toBe(200);
  });

  test("D12: utok_ non-admin reads a null-owner legacy file with DEV_OPEN off → 404 fail-closed", async () => {
    expect(roleOf(nonAdminUserA.userId)).not.toBe("admin");
    expect(process.env.COMMHUB_DEV_OPEN).toBeUndefined();
    const res = await download(nonAdminUserA.token, legacyNullOwner);
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe("not_found");
  });

  test.skipIf(!masterTokenActive)("D13: legacy master reads a null-owner legacy file → 200", async () => {
    const res = await download(MASTER_TOKEN, legacyNullOwner);
    expect(res.status).toBe(200);
  });

  test("D14: admin utok_ reads a null-owner legacy file → 200", async () => {
    const res = await download(adminUser.token, legacyNullOwner);
    expect(res.status).toBe(200);
  });

  test("🔴 D15: an ntok_ ISSUED BY AN ADMIN, bound to N1, reads a file in N2 → 404", async () => {
    // The production shape: agent node tokens resolve to an admin user.
    // If resolvePrincipal classified by admin-ness before boundness, this
    // token would take the admin bypass and every node would keep its
    // cross-network read. Assert the premise (the token's user really is
    // admin) so a fixture drift cannot turn this into a trivial pass.
    expect(roleOf(adminUser.userId)).toBe("admin");
    const tokenRow = db.get<{ user_id: string; network_id: string }>(
      "SELECT user_id, network_id FROM api_tokens WHERE name = ?1", "node:d15probe",
    );
    expect(tokenRow?.user_id).toBe(adminUser.userId);
    expect(tokenRow?.network_id).toBe(N1);

    const res = await download(adminNtokN1.token!, fileInN2);
    expect(res.status).toBe(404);
    expect((await res.json() as any).error).toBe("not_found");

    // Same token in its own network still works — proves the 404 is
    // scope, not a broken token.
    const ok = await download(adminNtokN1.token!, fileInN1);
    expect(ok.status).toBe(200);
  });
});

// ── Enumeration oracle ─────────────────────────────────────────────────

describe.skipIf(!isProdMode)("#503 E — denied responses carry no enumeration signal", () => {
  let unknownBody = "";
  let unknownRes: Response;

  beforeAll(async () => {
    unknownRes = await download(nonAdminUserB.token, UNKNOWN_FILE_ID);
    unknownBody = await unknownRes.text();
  });

  test("E1: unknown file_id → 404 with the canonical not_found body", async () => {
    expect(unknownRes.status).toBe(404);
    expect(JSON.parse(unknownBody)).toEqual({ ok: false, error: "not_found" });
  });

  test("E2: cross-network deny (D2) is byte-identical to unknown file_id", async () => {
    const res = await download(nonAdminUserB.ntok, fileInN1);
    expect(res.status).toBe(unknownRes.status);
    expect(await res.text()).toBe(unknownBody);
  });

  test("E3: cross-network deny via utok_ (D4) is byte-identical to unknown file_id", async () => {
    expect(roleOf(outsiderUser.userId)).not.toBe("admin");
    const res = await download(outsiderUser.token, fileInN1);
    expect(res.status).toBe(unknownRes.status);
    expect(await res.text()).toBe(unknownBody);
  });

  test("E4: corrupted index JSON is byte-identical to unknown file_id", async () => {
    const fileId = await uploadOk(nonAdminUserA.token, "e4", "e4.bin");
    writeFileSync(entryPath(fileId), "{not json");
    const res = await download(nonAdminUserA.token, fileId);
    expect(res.status).toBe(unknownRes.status);
    expect(await res.text()).toBe(unknownBody);
  });

  test("E5: schema-invalid index entry is byte-identical to unknown file_id", async () => {
    const fileId = await uploadOk(nonAdminUserA.token, "e5", "e5.bin");
    const entry = readEntry(fileId);
    // Empty-string network_id: present but not a usable value. If
    // validateIndexEntry stopped rejecting it, normalizeEntry would coerce
    // it to null and the blob would silently fall back to the legacy
    // owner-only branch — a downgrade, not a denial.
    entry.network_id = "";
    writeEntry(fileId, entry);
    const res = await download(nonAdminUserA.token, fileId);
    expect(res.status).toBe(unknownRes.status);
    expect(await res.text()).toBe(unknownBody);
  });

  test("E6: HEAD on a cross-network deny matches HEAD on unknown file_id (status + headers)", async () => {
    const denied = await head(nonAdminUserB.ntok, fileInN1);
    const unknown = await head(nonAdminUserB.token, UNKNOWN_FILE_ID);
    expect(denied.status).toBe(404);
    expect(denied.status).toBe(unknown.status);
    expect(denied.headers.get("content-type")).toBe(unknown.headers.get("content-type"));
    expect(denied.headers.get("content-length")).toBe(unknown.headers.get("content-length"));
  });

  test("E7: upload to a network you are not a member of → 403 with the shared scope-guard body", async () => {
    expect(roleOf(nonAdminUserB.userId)).not.toBe("admin");
    const res = await upload(nonAdminUserB.token, "e7", "e7.bin", N3);
    expect(res.status).toBe(403);
    expect(JSON.parse(await res.text())).toEqual({ ok: false, error: "access denied to requested network" });
  });

  test("E8: for a non-admin, 'network exists but is not yours' and 'network does not exist' are byte-identical", async () => {
    // The premise both halves rest on: one network really exists and the
    // other really does not. Without this the rows could match by both
    // being the same kind of failure.
    expect(db.get<any>("SELECT * FROM networks WHERE network_id = ?1", N3)).toBeTruthy();
    expect(db.get<any>("SELECT * FROM networks WHERE network_id = ?1", N_FAKE)).toBeFalsy();
    expect(roleOf(nonAdminUserB.userId)).not.toBe("admin");
    const notMember = await upload(nonAdminUserB.token, "e8a", "e8a.bin", N3);
    const notExist = await upload(nonAdminUserB.token, "e8b", "e8b.bin", N_FAKE);
    expect(notExist.status).toBe(notMember.status);
    expect(await notExist.text()).toBe(await notMember.text());
  });

  test("E9: admin uploading to a nonexistent network gets the distinguishable 400 (no oracle — admin sees the list anyway)", async () => {
    expect(roleOf(adminUser.userId)).toBe("admin");
    const res = await upload(adminUser.token, "e9", "e9.bin", N_FAKE);
    expect(res.status).toBe(400);
    expect(JSON.parse(await res.text()).error).toBe("unknown_network");
  });
});

// ── Principal enumeration ──────────────────────────────────────────────
//
// Direct unit coverage of every Principal variant against both entry
// shapes. `anonymous` and `dev-open-anon` are unreachable over HTTP in
// production mode (requireAuth 401s first), so this is the only place
// they can be pinned at all.

describe("#503 — authorizeFileDownload covers every Principal variant", () => {
  const inNetwork = normalizeEntry({ owner_id: "u_owner", network_id: "net_1" });
  const legacyOwned = normalizeEntry({ owner_id: "u_owner" });
  const legacyNull = normalizeEntry({ owner_id: null });

  const anonymous: Principal = { kind: "anonymous" };
  const devOpenAnon: Principal = { kind: "dev-open-anon" };
  const legacyMaster: Principal = { kind: "legacy-master" };
  const utokOwner: Principal = { kind: "utok", userId: "u_owner", username: "owner", isAdmin: false };
  const ntokSame: Principal = { kind: "ntok", userId: "u_node", boundNetworkId: "net_1" };
  const ntokOther: Principal = { kind: "ntok", userId: "u_node", boundNetworkId: "net_2" };
  const adminUtok: Principal = { kind: "admin-utok", userId: "u_admin", username: "admin" };

  test("legacy-master and admin-utok bypass in both entry shapes", () => {
    for (const entry of [inNetwork, legacyOwned, legacyNull]) {
      expect(authorizeFileDownload(legacyMaster, entry)).toBe(true);
      expect(authorizeFileDownload(adminUtok, entry)).toBe(true);
    }
  });

  test("anonymous and dev-open-anon are denied an attributed file", () => {
    expect(authorizeFileDownload(anonymous, inNetwork)).toBe(false);
    expect(authorizeFileDownload(devOpenAnon, inNetwork)).toBe(false);
  });

  test("ntok_ is allowed only in its bound network", () => {
    expect(authorizeFileDownload(ntokSame, inNetwork)).toBe(true);
    expect(authorizeFileDownload(ntokOther, inNetwork)).toBe(false);
  });

  test("an attributed file ignores owner match — network membership is the rule", () => {
    // utokOwner IS the owner_id on this entry but holds no role in net_1,
    // so it must still be denied. Owner-match must not leak back in as a
    // second, weaker path around the network gate.
    expect(inNetwork.ownerId).toBe("u_owner");
    expect(authorizeFileDownload(utokOwner, inNetwork)).toBe(false);
  });

  test("legacy entries keep the pre-#503 owner-match rule", () => {
    expect(authorizeFileDownload(utokOwner, legacyOwned)).toBe(true);
    const other: Principal = { kind: "utok", userId: "u_other", username: "other", isAdmin: false };
    expect(authorizeFileDownload(other, legacyOwned)).toBe(false);
    expect(authorizeFileDownload(other, legacyNull)).toBe(false);
  });

  test("normalizeEntry is the only place on-disk values are narrowed", () => {
    expect(normalizeEntry({ owner_id: null, network_id: undefined })).toEqual({ ownerId: null, networkId: null });
    expect(normalizeEntry({ owner_id: "", network_id: "" })).toEqual({ ownerId: null, networkId: null });
    expect(normalizeEntry({ owner_id: 42, network_id: { evil: true } } as any)).toEqual({ ownerId: null, networkId: null });
    expect(normalizeEntry({ owner_id: "u1", network_id: "n1" })).toEqual({ ownerId: "u1", networkId: "n1" });
  });
});

// ── #509 regression under network scope ────────────────────────────────

describe.skipIf(!isProdMode)("#503 — network scope does not regress cross-day downloads (#509)", () => {
  test("a file indexed under a past date_bucket is still readable by its network", async () => {
    const fileId = await uploadOk(nonAdminUserA.token, "yesterday-payload", "yd.bin");
    const entry = readEntry(fileId);
    expect(entry.network_id).toBe(N1);

    // Move the blob and its index entry into a past bucket, mirroring a
    // file uploaded before midnight and read after. The read path must
    // use the indexed bucket, not today's.
    const past = "2026-01-02";
    const from = join(UPLOADS_DIR, entry.date_bucket, `${fileId}${entry.ext}`);
    const to = join(UPLOADS_DIR, past, `${fileId}${entry.ext}`);
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(from));
    rmSync(from, { force: true });
    entry.date_bucket = past;
    writeEntry(fileId, entry);
    expect(existsSync(to)).toBe(true);

    const res = await download(nonAdminUserA.ntok, fileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("yesterday-payload");
  });
});
