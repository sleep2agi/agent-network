// #221 — unit tests for the upload primitives. The HTTP wire-up + Bun
// multipart parsing lives in server/src/index.ts; this file pins the
// path / regex / rate-limit / attachment-schema invariants that the
// 6-item security checklist depends on.
//
// Coverage matrix:
//   1. file_id regex accepts server-generated ids + rejects traversal attempts
//   2. sanitizeExt strips client-side filename paths, lowercases ext
//   3. buildStoragePath rejects malformed id / ext, places file under date bucket
//   4. isPathInsideUploadsRoot defends against symlink / traversal escape
//   5. UploadRateLimiter — first call allowed, exhausting bucket blocks, window expiry resets
//   6. validateAttachments accepts MCP-compatible shape, rejects too-many / bad type / bad file_id
//   7. validateIndexEntry refuses tampered shapes
//   8. indexEntryPath rejects malformed file_id
import { describe, expect, test } from "bun:test";
import {
  FILE_ID_REGEX,
  MAX_UPLOAD_BYTES,
  UploadRateLimiter,
  UPLOAD_RATE_MAX_PER_WINDOW,
  UPLOAD_RATE_WINDOW_MS,
  buildStoragePath,
  generateFileId,
  getDateBucket,
  indexEntryPath,
  isPathInsideUploadsRoot,
  sanitizeExt,
  validateAttachments,
  validateIndexEntry,
} from "./uploads";

describe("FILE_ID_REGEX", () => {
  test("accepts the server-generated uuidv4-without-hyphens shape (32 hex chars)", () => {
    for (let i = 0; i < 20; i++) {
      const id = generateFileId();
      expect(FILE_ID_REGEX.test(id)).toBe(true);
      expect(id.length).toBe(32);
    }
  });

  test("rejects every directory-traversal attempt a client might try", () => {
    const traversals = [
      "../foo",
      "..%2Ffoo",
      "foo/bar",
      "foo\\bar",
      "foo.bar",
      ".bashrc",
      "/etc/passwd",
      "foo bar",
      "",
      "abc", // too short
      "x".repeat(65), // too long
    ];
    for (const t of traversals) {
      expect(FILE_ID_REGEX.test(t)).toBe(false);
    }
  });
});

describe("sanitizeExt", () => {
  test("returns a leading-dot lowercase extension for a normal filename", () => {
    expect(sanitizeExt("photo.PNG")).toBe(".png");
    expect(sanitizeExt("report.pdf")).toBe(".pdf");
    expect(sanitizeExt("archive.tar.gz")).toBe(".gz");
  });

  test("strips any client-supplied directory prefix before reading the ext", () => {
    // The handler must NEVER use the client filename for storage paths,
    // but the ext is allowed through for nicer URLs. We still strip any
    // path separator the client tries to sneak in.
    expect(sanitizeExt("../../etc/passwd.jpg")).toBe(".jpg");
    expect(sanitizeExt("..\\..\\windows\\boot.ini")).toBe(".ini");
    expect(sanitizeExt("foo/bar/baz.html")).toBe(".html");
  });

  test("returns empty string for missing / weird inputs", () => {
    expect(sanitizeExt(undefined)).toBe("");
    expect(sanitizeExt(null)).toBe("");
    expect(sanitizeExt("")).toBe("");
    expect(sanitizeExt("noext")).toBe("");
    // ".bashrc" → ".bashrc" is acceptable: storage uses the server-generated
    // file_id, so the file lands as "<file_id>.bashrc". The download handler
    // forces Content-Disposition: attachment + X-Content-Type-Options: nosniff,
    // so the ext can't be leveraged to execute / mis-render the file.
    expect(sanitizeExt(".bashrc")).toBe(".bashrc");
    // ext > 16 chars is rejected; "extensiontoolong1" is 17 chars.
    expect(sanitizeExt("foo.extensiontoolong1")).toBe("");
  });

  test("rejects exts with non-alphanumeric characters", () => {
    expect(sanitizeExt("payload.exe;.png")).toBe(".png");
    expect(sanitizeExt("foo.<script>")).toBe("");
  });
});

describe("buildStoragePath", () => {
  test("places the file under a YYYY-MM-DD bucket with file_id+ext as the name", () => {
    const now = new Date("2026-06-11T03:00:00Z");
    const r = buildStoragePath("abcdef1234567890abcdef1234567890", ".png", {
      uploadsRoot: "/srv/uploads",
      now,
    });
    expect(r.dateBucket).toBe("2026-06-11");
    expect(r.relativePath).toBe("2026-06-11/abcdef1234567890abcdef1234567890.png");
    expect(r.absolutePath).toBe("/srv/uploads/2026-06-11/abcdef1234567890abcdef1234567890.png");
  });

  test("rejects malformed file_id", () => {
    expect(() => buildStoragePath("../etc/passwd", ".png", { uploadsRoot: "/srv" })).toThrow(/invalid/);
    expect(() => buildStoragePath("ok", ".png", { uploadsRoot: "/srv" })).toThrow(/invalid/);
  });

  test("rejects malformed ext", () => {
    expect(() => buildStoragePath(generateFileId(), "../passwd", { uploadsRoot: "/srv" })).toThrow(/invalid/);
    expect(() => buildStoragePath(generateFileId(), ".x".repeat(40), { uploadsRoot: "/srv" })).toThrow(/invalid/);
  });

  test("allows empty ext", () => {
    const r = buildStoragePath(generateFileId(), "", { uploadsRoot: "/srv" });
    expect(r.relativePath.endsWith("/")).toBe(false);
    expect(r.relativePath.includes(".")).toBe(false);
  });
});

describe("getDateBucket", () => {
  test("uses UTC so the bucket is consistent across hub timezones", () => {
    expect(getDateBucket(new Date("2026-06-11T23:59:59Z"))).toBe("2026-06-11");
    expect(getDateBucket(new Date("2026-06-12T00:00:01Z"))).toBe("2026-06-12");
  });
});

describe("isPathInsideUploadsRoot", () => {
  test("true for a normal nested path", () => {
    expect(isPathInsideUploadsRoot("/srv/uploads/2026-06-11/abc.png", "/srv/uploads")).toBe(true);
  });

  test("false for an upward traversal that lands outside the root", () => {
    expect(isPathInsideUploadsRoot("/srv/uploads/../etc/passwd", "/srv/uploads")).toBe(false);
    expect(isPathInsideUploadsRoot("/etc/passwd", "/srv/uploads")).toBe(false);
  });

  test("false for the root itself (must be a file underneath, not the root dir)", () => {
    expect(isPathInsideUploadsRoot("/srv/uploads", "/srv/uploads")).toBe(false);
  });
});

describe("UploadRateLimiter", () => {
  test("first N calls within window are allowed; the (N+1)th is blocked", () => {
    const lim = new UploadRateLimiter(60_000, 3); // 3 per minute
    const t0 = 1_700_000_000_000;
    const a1 = lim.check("token-x", t0);
    const a2 = lim.check("token-x", t0 + 100);
    const a3 = lim.check("token-x", t0 + 200);
    const a4 = lim.check("token-x", t0 + 300);
    expect(a1.allowed).toBe(true);
    expect(a2.allowed).toBe(true);
    expect(a3.allowed).toBe(true);
    expect(a4.allowed).toBe(false);
    if (!a4.allowed) {
      expect(a4.retryAfterMs).toBeGreaterThan(0);
      expect(a4.retryAfterMs).toBeLessThanOrEqual(60_000);
    }
  });

  test("different keys are isolated", () => {
    const lim = new UploadRateLimiter(60_000, 1);
    expect(lim.check("alice", 1).allowed).toBe(true);
    expect(lim.check("alice", 2).allowed).toBe(false);
    expect(lim.check("bob", 3).allowed).toBe(true);
  });

  test("window expiry resets the bucket", () => {
    const lim = new UploadRateLimiter(60_000, 1);
    const t0 = 1_700_000_000_000;
    expect(lim.check("token-x", t0).allowed).toBe(true);
    expect(lim.check("token-x", t0 + 30_000).allowed).toBe(false);
    expect(lim.check("token-x", t0 + 60_001).allowed).toBe(true);
  });

  test("default constructor matches documented public defaults", () => {
    const lim = new UploadRateLimiter();
    expect(UPLOAD_RATE_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(UPLOAD_RATE_MAX_PER_WINDOW).toBe(60);
    for (let i = 0; i < UPLOAD_RATE_MAX_PER_WINDOW; i++) {
      expect(lim.check("token-y", 1 + i).allowed).toBe(true);
    }
    expect(lim.check("token-y", 1000).allowed).toBe(false);
  });

  test("caps in-memory state by evicting oldest entries past maxEntries", () => {
    // A small maxEntries lets us drive the eviction path deterministically.
    // Without this cap the limiter would grow unbounded under an IP-flood
    // (public-facing hub, IPv6 rotation makes each request a "new" key).
    const lim = new UploadRateLimiter(60_000, 5, 4);
    const t0 = 1_700_000_000_000;
    // Fill to cap with non-expired entries — eviction should fire on insert 5.
    for (let i = 0; i < 4; i++) {
      lim.check(`key-${i}`, t0);
    }
    expect(lim.size()).toBe(4);
    lim.check("key-new", t0 + 100);
    expect(lim.size()).toBeLessThanOrEqual(4);
    // Hitting an EXISTING key while at cap must NOT trigger an eviction
    // (an attacker hitting the same key shouldn't push out other callers).
    const beforeSize = lim.size();
    lim.check("key-new", t0 + 200);
    expect(lim.size()).toBe(beforeSize);
  });
});

describe("validateAttachments", () => {
  test("undefined / null input → empty array", () => {
    const a = validateAttachments(undefined);
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.attachments).toEqual([]);
    const b = validateAttachments(null);
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.attachments).toEqual([]);
  });

  test("rejects non-array input", () => {
    expect(validateAttachments("nope").ok).toBe(false);
    expect(validateAttachments({}).ok).toBe(false);
  });

  test("accepts a well-formed attachment matching MCP send_task shape", () => {
    const fileId = generateFileId();
    const res = validateAttachments([
      { type: "file", file_id: fileId, name: "photo.png", mime: "image/png", size: 12345 },
    ]);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.attachments[0].file_id).toBe(fileId);
      expect(res.attachments[0].mime).toBe("image/png");
    }
  });

  test("rejects too many attachments (>20)", () => {
    const fileId = generateFileId();
    const many = Array.from({ length: 21 }, () => ({ type: "file" as const, file_id: fileId }));
    const res = validateAttachments(many);
    expect(res.ok).toBe(false);
  });

  test("rejects invalid file_id (path traversal)", () => {
    const res = validateAttachments([{ type: "file", file_id: "../etc/passwd" }]);
    expect(res.ok).toBe(false);
  });

  test("rejects size larger than MAX_UPLOAD_BYTES", () => {
    const fileId = generateFileId();
    const res = validateAttachments([{ type: "file", file_id: fileId, size: MAX_UPLOAD_BYTES + 1 }]);
    expect(res.ok).toBe(false);
  });

  test("rejects unexpected type", () => {
    const res = validateAttachments([{ type: "image", file_id: generateFileId() }]);
    expect(res.ok).toBe(false);
  });
});

describe("validateIndexEntry", () => {
  test("accepts a well-formed entry", () => {
    const id = generateFileId();
    expect(
      validateIndexEntry({
        file_id: id,
        date_bucket: "2026-06-11",
        ext: ".png",
        name: "anything",
        mime: "image/png",
        size: 12345,
        uploaded_at: "2026-06-11T03:00:00Z",
      }),
    ).toBe(true);
  });

  test("rejects bad date_bucket (anti-tamper)", () => {
    expect(
      validateIndexEntry({ file_id: generateFileId(), date_bucket: "../etc", ext: ".png", size: 1 }),
    ).toBe(false);
  });

  test("rejects bad ext", () => {
    expect(
      validateIndexEntry({ file_id: generateFileId(), date_bucket: "2026-06-11", ext: "/etc/passwd", size: 1 }),
    ).toBe(false);
  });

  test("rejects size beyond MAX_UPLOAD_BYTES (anti-tamper)", () => {
    expect(
      validateIndexEntry({
        file_id: generateFileId(),
        date_bucket: "2026-06-11",
        ext: "",
        size: MAX_UPLOAD_BYTES + 1,
      }),
    ).toBe(false);
  });
});

describe("indexEntryPath", () => {
  test("returns null on malformed file_id", () => {
    expect(indexEntryPath("../etc/passwd", { uploadsRoot: "/srv" })).toBeNull();
    expect(indexEntryPath("", { uploadsRoot: "/srv" })).toBeNull();
  });

  test("places the index file under <uploadsRoot>/.index/", () => {
    const id = generateFileId();
    const p = indexEntryPath(id, { uploadsRoot: "/srv/up" });
    expect(p).toBe(`/srv/up/.index/${id}.json`);
  });
});
