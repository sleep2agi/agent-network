// #509 — file download must use the date_bucket stored in the index
// entry, NOT today's date computed from the runtime clock.
//
// Bug: server.ts:1793 called `buildStoragePath(entry.file_id, entry.ext)`
// without passing a bucket. buildStoragePath internally calls
// getDateBucket(opts.now) which defaults to `new Date()` → today. Any
// file uploaded on a previous day would look under today's directory
// and return 404 blob_missing, even though authorization passed and
// the blob was still on disk in yesterday's directory.
//
// The 6 layers of pre-release verification (byte-for-byte review, two
// independent audits, dev-confirm, two validator container matrices,
// pre-release smoke) all uploaded + downloaded within the same UTC day,
// so the paths coincidentally matched. See project memory
// `feedback_time_based_storage_tests_must_inject_time`.
//
// This suite constructs fixture entries with hard-coded past date
// buckets and matching on-disk blobs; the runtime clock is never
// advanced. Mutation self-check: reverting the download path to use
// buildStoragePath (which computes today) must turn Door 1 tests red.
//
// Cross-lane note: This is orthogonal to #495/#500/#505 (authz).
// Reuses the utok_ + admin fixture pattern from file-download-authz
// but constructs entries by writing the .index JSON + blob directly
// so we can pin the date_bucket without waiting for real time.

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SERVER_DB = mkdtempSync(join(tmpdir(), "anet-509-db-")) + "/commhub.db";
const UPLOADS_DIR = mkdtempSync(join(tmpdir(), "anet-509-fs-"));

// Set env BEFORE importing anything that pulls in db-adapter.ts or
// server.ts (which capture DEV_OPEN + AUTH_TOKEN at module load).
process.env.COMMHUB_DB = SERVER_DB;
process.env.COMMHUB_UPLOADS_DIR = UPLOADS_DIR;
process.env.HOST = "127.0.0.1";
delete process.env.COMMHUB_DEV_OPEN;

const { register } = await import("./auth.js");
const { db } = await import("./db.js");

// Register an admin FIRST to consume the "first-user-auto-admin" slot,
// then register userA as a regular user. Prior CR rounds landed the
// fixture-drift guard as a canonical pattern (see project memory
// `feedback_first_registered_user_is_admin_fake_green`).
const seedName = `seed509_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const rSeed = register(seedName, "BootstrapPw123Aa!", undefined, "seed509");
if (!rSeed.ok) throw new Error(`seed509 register failed: ${rSeed.error}`);
// Also promote via SQL in case the auto-admin heuristic changes.
db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [rSeed.user!.user_id]);

const nameA = `user509a_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
const rA = register(nameA, "BootstrapPw123Aa!", undefined, "user509A");
if (!rA.ok) throw new Error(`user509A register failed: ${rA.error}`);
const userAToken = rA.token!;
const userAUserId = rA.user!.user_id;

// #500 CR2 fixture-drift guard — assert userA is NOT admin so tests
// exercise the regular utok_ path, not the admin bypass.
{
  const row = db.get<{ role: string }>("SELECT role FROM users WHERE user_id = ?1", userAUserId);
  if (!row) throw new Error("userA missing after register");
  if (row.role === "admin") {
    throw new Error(
      `[#509 fixture-drift guard] userA was auto-promoted to admin ` +
      `(role=${row.role}). Refusing to run: download tests would ` +
      `short-circuit through the admin allow-list and validate nothing.`,
    );
  }
}

const { bootServer } = await import("./server.js");
const server = bootServer({ port: 0, hostname: "127.0.0.1" });
const BASE = `http://127.0.0.1:${server.port}`;
await new Promise((r) => setTimeout(r, 100));

async function _uploadProbe(): Promise<number> {
  const form = new FormData();
  form.append("file", new Blob([new TextEncoder().encode("p")], { type: "application/octet-stream" }), "p");
  const r = await fetch(`${BASE}/api/upload`, { method: "POST", body: form });
  return r.status;
}
const isProdMode = (await _uploadProbe()) !== 200;

afterAll(() => {
  try { server?.stop?.(true); } catch {}
  try { rmSync(UPLOADS_DIR, { recursive: true, force: true }); } catch {}
  try { rmSync(SERVER_DB, { recursive: true, force: true }); } catch {}
});

/**
 * Manually construct an index entry + matching blob at a caller-chosen
 * date bucket. This lets Door 1 tests pin "yesterday" without waiting
 * for real time — the whole point of #509's fix is that read path must
 * respect index-recorded bucket, so we test by placing a blob in a
 * bucket that is NOT today.
 */
function plantFileAtBucket(opts: {
  ownerToken: string;
  ownerUserId: string;
  dateBucket: string;         // "YYYY-MM-DD" — put blob HERE
  content: Uint8Array;
  ext?: string;               // default ".txt"
  name?: string;              // metadata only
}): string {
  const ext = opts.ext ?? ".txt";
  const fileId = require("crypto").randomUUID().replace(/-/g, "");
  const bucketDir = join(UPLOADS_DIR, opts.dateBucket);
  mkdirSync(bucketDir, { recursive: true });
  writeFileSync(join(bucketDir, fileId + ext), opts.content);

  const indexDir = join(UPLOADS_DIR, ".index");
  mkdirSync(indexDir, { recursive: true });
  const entry = {
    file_id: fileId,
    date_bucket: opts.dateBucket,
    ext,
    name: opts.name ?? "planted.txt",
    mime: "application/octet-stream",
    size: opts.content.length,
    owner: opts.ownerUserId,
    owner_id: opts.ownerUserId,
    uploaded_at: new Date().toISOString(),
  };
  writeFileSync(join(indexDir, fileId + ".json"), JSON.stringify(entry, null, 2));
  return fileId;
}

async function downloadAs(token: string, fileId: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}/api/files/${fileId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
  });
}

async function headAs(token: string, fileId: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}/api/files/${fileId}`, {
    method: "HEAD",
    headers: { Authorization: `Bearer ${token}`, ...extraHeaders },
  });
}

// Yesterday, three-days-ago (relative to test-run time). Fully static
// dates would rot; computing offsets keeps the test durable while
// still isolating the "yesterday" case from today.
const _pad = (n: number) => String(n).padStart(2, "0");
function bucketNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return `${d.getUTCFullYear()}-${_pad(d.getUTCMonth() + 1)}-${_pad(d.getUTCDate())}`;
}
const BUCKET_YESTERDAY = bucketNDaysAgo(1);
const BUCKET_3_DAYS_AGO = bucketNDaysAgo(3);
const BUCKET_TODAY = bucketNDaysAgo(0);

describe.skipIf(!isProdMode)("#509 — download uses index date_bucket, not today's date", () => {
  test("Door 1: yesterday's file downloads today → 200 (was 404 blob_missing pre-fix)", async () => {
    const content = new TextEncoder().encode("blob-from-yesterday");
    const fileId = plantFileAtBucket({
      ownerToken: userAToken,
      ownerUserId: userAUserId,
      dateBucket: BUCKET_YESTERDAY,
      content,
    });

    // Precondition: blob is REALLY in yesterday's bucket, not today's.
    // If both existed the test would be indistinguishable from a
    // buildStoragePath-uses-today bug regression.
    expect(existsSync(join(UPLOADS_DIR, BUCKET_YESTERDAY, fileId + ".txt"))).toBe(true);
    expect(existsSync(join(UPLOADS_DIR, BUCKET_TODAY, fileId + ".txt"))).toBe(false);

    const res = await downloadAs(userAToken, fileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("blob-from-yesterday");
  });

  test("Door 1 (further past): 3-days-ago file downloads today → 200", async () => {
    const content = new TextEncoder().encode("blob-from-3-days-ago");
    const fileId = plantFileAtBucket({
      ownerToken: userAToken,
      ownerUserId: userAUserId,
      dateBucket: BUCKET_3_DAYS_AGO,
      content,
    });

    const res = await downloadAs(userAToken, fileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("blob-from-3-days-ago");
  });

  test("Door 2 regression: today's file downloads today → 200 (unchanged behavior)", async () => {
    const content = new TextEncoder().encode("blob-from-today");
    const fileId = plantFileAtBucket({
      ownerToken: userAToken,
      ownerUserId: userAUserId,
      dateBucket: BUCKET_TODAY,
      content,
    });

    const res = await downloadAs(userAToken, fileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("blob-from-today");
  });

  test("Door 3 GET: yesterday's file via GET → 200 with correct body", async () => {
    const content = new TextEncoder().encode("GET-cross-day");
    const fileId = plantFileAtBucket({
      ownerToken: userAToken,
      ownerUserId: userAUserId,
      dateBucket: BUCKET_YESTERDAY,
      content,
    });
    const res = await downloadAs(userAToken, fileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("GET-cross-day");
  });

  test("Door 3 HEAD: yesterday's file via HEAD → 200 with Content-Length, no body", async () => {
    const content = new TextEncoder().encode("HEAD-cross-day-payload");
    const fileId = plantFileAtBucket({
      ownerToken: userAToken,
      ownerUserId: userAUserId,
      dateBucket: BUCKET_YESTERDAY,
      content,
    });
    const res = await headAs(userAToken, fileId);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Length")).toBe(String(content.length));
    // HEAD must not return a body — Bun exposes the stream but reads to
    // 0 bytes. Some HTTP stacks return no ReadableStream at all; either
    // is acceptable per RFC 9110 §9.3.2 — check size, not presence.
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(0);
  });

  test("Door 3 Range: yesterday's file with Range header → data served from correct bucket", async () => {
    const content = new TextEncoder().encode("0123456789ABCDEFGHIJ");
    const fileId = plantFileAtBucket({
      ownerToken: userAToken,
      ownerUserId: userAUserId,
      dateBucket: BUCKET_YESTERDAY,
      content,
    });
    // Whether the current handler honours Range or returns full 200 is
    // orthogonal to #509 — both prove the blob path was resolved
    // correctly. #509 fails as 404 when path is wrong. Accept 200 or
    // 206 as pass; refuse 404 (path bug not fixed).
    const res = await fetch(`${BASE}/api/files/${fileId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${userAToken}`, Range: "bytes=0-4" },
    });
    expect([200, 206]).toContain(res.status);
    if (res.status === 200) {
      expect(await res.text()).toBe("0123456789ABCDEFGHIJ");
    }
  });

  test("Door 3 conditional: yesterday's file with If-None-Match → served or 304, never 404", async () => {
    const content = new TextEncoder().encode("cond-cross-day");
    const fileId = plantFileAtBucket({
      ownerToken: userAToken,
      ownerUserId: userAUserId,
      dateBucket: BUCKET_YESTERDAY,
      content,
    });
    const res = await downloadAs(userAToken, fileId, { "If-None-Match": '"never-matches-509"' });
    expect([200, 304]).toContain(res.status);
    expect(res.status).not.toBe(404);
  });

  test("Door 4: existing bucket-recorded blob is immediately readable without migration", async () => {
    // Simulate the scenario Vincent hit: yesterday's PPT still on disk
    // in yesterday's bucket, index intact — no re-upload, no data move,
    // fix alone should make it readable.
    const yesterdayBlob = new TextEncoder().encode("Vincents-actual-PPT-payload");
    const fileId = plantFileAtBucket({
      ownerToken: userAToken,
      ownerUserId: userAUserId,
      dateBucket: BUCKET_YESTERDAY,
      content: yesterdayBlob,
      ext: ".pptx",
      name: "presentation.pptx",
    });

    // The blob file was NEVER moved after "plantFileAtBucket" wrote it
    // to yesterday's bucket. Post-fix, the server must find it there.
    const res = await downloadAs(userAToken, fileId);
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(yesterdayBlob);
  });

  test("Door 1 defence: poisoned index date_bucket (e.g. '../etc') is rejected", async () => {
    // The read-path helper validates dateBucket with the same regex
    // family used for file_id path-escape defence. A poisoned .index
    // JSON claiming date_bucket = "../etc" should trip index_invalid
    // (500), not silently traverse the filesystem.
    const fileId = require("crypto").randomUUID().replace(/-/g, "");
    const indexDir = join(UPLOADS_DIR, ".index");
    mkdirSync(indexDir, { recursive: true });
    const entry = {
      file_id: fileId,
      date_bucket: "../etc",  // poisoned
      ext: ".txt",
      name: "poison.txt",
      mime: "application/octet-stream",
      size: 4,
      owner: userAUserId,
      owner_id: userAUserId,
      uploaded_at: new Date().toISOString(),
    };
    writeFileSync(join(indexDir, fileId + ".json"), JSON.stringify(entry));
    const res = await downloadAs(userAToken, fileId);
    // Some layer up-front (validateIndexEntry) may catch this before
    // pathForExistingBlob; either 500 index_invalid or 404 not_found
    // is acceptable — the invariant is "no traversal into ../etc".
    expect([404, 500]).toContain(res.status);
  });
});
