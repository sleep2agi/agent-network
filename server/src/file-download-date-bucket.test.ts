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
    // Whether Range is honoured is orthogonal to #509 and NOT decided by
    // this codebase: the handler is `new Response(Bun.file(path), {status:200})`
    // with no Range handling anywhere, so 200-vs-206 is decided purely by the
    // Bun runtime. Measured 2026-07-30 with byte-identical code:
    //   bun 1.2.22 → 200 + full body     bun 1.3.14 → 206 + correct slice
    // So both statuses are legitimate and this test must pass on both.
    //
    // 🔴 But "accept either status" must NOT mean "assert nothing". The first
    // version guarded the body check with `if (status === 200)`, so on the
    // runtime production actually runs (206) the body assertion never
    // executed — the test claimed to prove the blob path resolved correctly
    // while only ever checking a status code. Each branch asserts its own
    // bytes, and an unrecognised status fails loudly rather than silently
    // skipping.
    const res = await fetch(`${BASE}/api/files/${fileId}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${userAToken}`, Range: "bytes=0-4" },
    });
    expect([200, 206]).toContain(res.status);
    if (res.status === 206) {
      // Runtime honoured Range: body must be exactly the requested slice,
      // and the slice must come from THIS file (total length 20 proves the
      // resolved blob is the planted one, not some other bucket's file).
      expect(await res.text()).toBe("01234");
      expect(res.headers.get("content-range")).toBe(`bytes 0-4/${content.byteLength}`);
    } else {
      // Runtime ignored Range: body must be the complete planted blob.
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

  test("Item 3 (副指挥 b1082017) — server TZ / UTC-boundary: entry bucket is authoritative regardless of runtime clock", async () => {
    // 副指挥 7 硬门 ③: "覆盖服务时区与 UTC 日期边界".
    //
    // The read path is now structurally no-clock: pathForExistingBlob
    // takes only the stored dateBucket, calls no getDateBucket / new
    // Date() / Date.now(). This test pins that invariant with an
    // explicit UTC-boundary scenario rather than leaving it as
    // structural reasoning.
    //
    // Scenario: an entry recorded on 2026-07-29 (a hard-coded UTC
    // date, unrelated to today's runtime clock). Even if the server
    // process's runtime clock is anywhere in 2026-07-30..2026-08-01
    // (i.e. one, two, or more midnights past the recorded bucket),
    // the download must still resolve to the stored bucket path.
    //
    // The fixture uses a hard-coded date string (not offset from
    // today) so the assertion is anchored on the invariant, not on
    // "wall-clock happens to differ by exactly N days". If someone
    // future-dates the runtime environment, this test still passes
    // because the read path never consults the clock.
    const hardcodedPastBucket = "2026-07-29";
    const content = new TextEncoder().encode("tz-boundary-payload");
    const fileId = plantFileAtBucket({
      ownerToken: userAToken,
      ownerUserId: userAUserId,
      dateBucket: hardcodedPastBucket,
      content,
    });

    // Precondition: blob is at the hard-coded bucket, NOT at any
    // date derivable from `new Date()` at test time. If both paths
    // happened to exist the test would not distinguish a
    // stored-bucket read from a runtime-computed one.
    expect(existsSync(join(UPLOADS_DIR, hardcodedPastBucket, fileId + ".txt"))).toBe(true);
    // If today happens to be exactly 2026-07-29 (rare but possible
    // when re-running the fixture), the today-bucket path exists too;
    // the invariant we care about is the read succeeds because of the
    // stored bucket, not because of a runtime coincidence.

    const res = await downloadAs(userAToken, fileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("tz-boundary-payload");

    // Additional invariant grep: the fixture's stored bucket is the
    // ONLY bucket the read path should have visited. We can't observe
    // the exact filesystem access here without instrumenting, but the
    // structural property is enforced by pathForExistingBlob's API
    // (no `now` parameter, no Date import). Combined with Door 1
    // (yesterday-not-today) and this hard-coded case, the intent is
    // pinned in tests, not just in the function name.
  });

  // Helper: plant an index entry with a poisoned/invalid date_bucket.
  // Blob file is optional — the point is the bucket string itself.
  function plantPoisonedBucketEntry(dateBucket: unknown): string {
    const fileId = require("crypto").randomUUID().replace(/-/g, "");
    const indexDir = join(UPLOADS_DIR, ".index");
    mkdirSync(indexDir, { recursive: true });
    const entry = {
      file_id: fileId,
      date_bucket: dateBucket,
      ext: ".txt",
      name: "poison.txt",
      mime: "application/octet-stream",
      size: 4,
      owner: userAUserId,
      owner_id: userAUserId,
      uploaded_at: new Date().toISOString(),
    };
    writeFileSync(join(indexDir, fileId + ".json"), JSON.stringify(entry));
    return fileId;
  }

  // 副指挥 66983a19 hard-door: 稳定 404 非 500 for
  //   • path-escape poisoned buckets ("../etc", "..\\etc", etc.)
  //   • non-calendar buckets ("2026-02-30", "2026-13-01", ...)
  //   • shape-only-valid but semantically impossible dates
  // 500 says "server failed to handle input"; 404 says "input refused
  // at the boundary". The latter is a stronger, more auditable posture.
  const invalidBuckets: Array<[string, unknown]> = [
    ["path-escape ../etc", "../etc"],
    ["path-escape .. only", ".."],
    ["backslash traversal", "..\\etc"],
    ["contains null byte", " date"],
    ["contains slash", "2026/07/29"],
    ["empty string", ""],
    ["all-nines shape but not calendar", "9999-99-99"],
    ["month 13 (impossible)", "2026-13-01"],
    ["month 00 (impossible)", "2026-00-15"],
    ["day 30 in February 2026 (non-leap-year rejected)", "2026-02-30"],
    ["day 32 (impossible)", "2026-07-32"],
    ["Feb 29 on non-leap year", "2025-02-29"],
  ];

  for (const [label, badBucket] of invalidBuckets) {
    test(`Refinement (副指挥 66983a19) — invalid bucket "${label}" → 404 (not 500)`, async () => {
      const fileId = plantPoisonedBucketEntry(badBucket);
      const res = await downloadAs(userAToken, fileId);
      // 稳定 404: pre-check via isValidCalendarBucket rejects at the
      // boundary. 500 would signal a caught throw from deeper code —
      // that is exactly the shape we're refusing to accept per副指挥
      // b1082017 (可靠性差很远).
      expect(res.status).toBe(404);
      const body: any = await res.json();
      expect(body.error).toBe("not_found");
    });
  }

  test("Refinement (副指挥 66983a19) — valid Feb 29 on ACTUAL leap year 2024 is accepted (not over-rejected)", async () => {
    // Sanity: the calendar validator must not accidentally reject
    // legitimate leap-day buckets from a real leap year. Constructs
    // an entry at 2024-02-29 (valid), blob at that path, downloads it.
    const content = new TextEncoder().encode("leap-day-blob");
    const fileId = plantFileAtBucket({
      ownerToken: userAToken,
      ownerUserId: userAUserId,
      dateBucket: "2024-02-29",
      content,
    });
    const res = await downloadAs(userAToken, fileId);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("leap-day-blob");
  });
});
