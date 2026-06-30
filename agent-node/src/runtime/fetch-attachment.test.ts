// Unit tests for fetch-attachment.ts.
//
// Coverage matrix:
//   - file_id present → HTTP GET /api/files/<id> with Bearer auth,
//     stream-to-disk with chmod 600 atomic rename
//   - file_id absent + local path exists → returns path as-is
//   - file_id absent + local path missing → not_found error
//   - bad file_id (regex fail) → file_id_invalid, no HTTP call
//   - hub 404 → not_found
//   - hub 401 → auth_failed
//   - 🔴 Content-Length > cap → size_exceeded BEFORE consuming bytes
//   - 🔴 stream byte counter > cap → size_exceeded MID-FLIGHT (Content-Length lied)
//     [[feedback_assume_unit_before_threshold]] — verifies cap unit is BYTES
//     not chunks, and the abort point is mid-stream not after-read.
//   - cache hit (file exists + size matches) → no HTTP call, cached:true
//   - sweeper purges files older than TTL, keeps fresh

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
  resolveAttachmentToLocalPath,
  sweepAttachmentCacheOnce,
  FILE_ID_REGEX,
  DEFAULT_MAX_BYTES,
  CACHE_TTL_MS,
} from "./fetch-attachment";
import { mkdirSync, writeFileSync, existsSync, statSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TEST_ROOT = "/tmp/fetch-attachment-test";
function freshCacheDir(): string {
  const d = join(TEST_ROOT, `case-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  return d;
}
function cleanupCacheRoot() {
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ok */ }
}

beforeEach(cleanupCacheRoot);
afterEach(cleanupCacheRoot);

describe("FILE_ID_REGEX matches server contract", () => {
  test("accepts the same shapes the hub accepts", () => {
    expect(FILE_ID_REGEX.test("abcDEF12")).toBe(true);
    expect(FILE_ID_REGEX.test("a".repeat(64))).toBe(true);
    expect(FILE_ID_REGEX.test("with_under_score-and-dash_1234567890")).toBe(true);
  });
  test("rejects path-traversal + length-out-of-range", () => {
    expect(FILE_ID_REGEX.test("short")).toBe(false);
    expect(FILE_ID_REGEX.test("../../etc/passwd")).toBe(false);
    expect(FILE_ID_REGEX.test("a".repeat(65))).toBe(false);
    expect(FILE_ID_REGEX.test("has spaces")).toBe(false);
    expect(FILE_ID_REGEX.test("has/slash/in/id")).toBe(false);
  });
});

describe("resolveAttachmentToLocalPath — file_id path", () => {
  test("hub 200 OK → bytes written to cache + chmod 600 + Bearer auth attached", async () => {
    const cacheDir = freshCacheDir();
    const payload = Buffer.from("hello world from cross-host attachment fetch");
    let capturedUrl = "";
    let capturedAuth = "";
    const fakeFetch: typeof fetch = async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as any)?.Authorization || "";
      return new Response(payload, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream", "Content-Length": String(payload.length) },
      });
    };
    const r = await resolveAttachmentToLocalPath(
      { file_id: "abcdefgh12", size: payload.length, name: "msg.png", mime: "image/png" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_test123", cacheDir, fetch: fakeFetch },
    );
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    expect(r.cached).toBe(false);
    expect(r.bytes).toBe(payload.length);
    expect(existsSync(r.localPath)).toBe(true);
    expect(readFileSync(r.localPath)).toEqual(payload);
    const mode = statSync(r.localPath).mode & 0o777;
    expect(mode).toBe(0o600);                 // chmod 600 on cache file
    expect(capturedUrl).toBe("http://hub.test:9200/api/files/abcdefgh12");
    expect(capturedAuth).toBe("Bearer ntok_test123");
    // Filename uses ext picked from name
    expect(r.localPath.endsWith(".png")).toBe(true);
  });

  test("file_id_invalid before any HTTP call (path traversal attempt)", async () => {
    const cacheDir = freshCacheDir();
    let called = false;
    const fakeFetch: typeof fetch = async () => { called = true; return new Response("", { status: 200 }); };
    const r = await resolveAttachmentToLocalPath(
      { file_id: "../../etc/passwd" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_x", cacheDir, fetch: fakeFetch },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("file_id_invalid");
    expect(called).toBe(false);
  });

  test("hub 404 → not_found code", async () => {
    const cacheDir = freshCacheDir();
    const fakeFetch: typeof fetch = async () =>
      new Response('{"ok":false,"error":"not_found"}', { status: 404 });
    const r = await resolveAttachmentToLocalPath(
      { file_id: "missing_id_x123" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_x", cacheDir, fetch: fakeFetch },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
  });

  test("hub 401 → auth_failed code", async () => {
    const cacheDir = freshCacheDir();
    const fakeFetch: typeof fetch = async () => new Response('{"ok":false}', { status: 401 });
    const r = await resolveAttachmentToLocalPath(
      { file_id: "valid_id_abc12" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_revoked", cacheDir, fetch: fakeFetch },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("auth_failed");
  });
});

describe("resolveAttachmentToLocalPath — size cap (🔴 通信龙 nit: BYTE unit + mid-stream abort)", () => {
  test("Content-Length > cap → size_exceeded with declared-and-cap surfaced + no cache file written", async () => {
    const cacheDir = freshCacheDir();
    const maxBytes = 1024;             // 1 KiB cap
    const declared = 1024 * 1024 * 10;  // hub claims 10 MiB
    const fakeFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          pull(controller) { controller.close(); },
        }),
        { status: 200, headers: { "Content-Length": String(declared) } },
      );
    const r = await resolveAttachmentToLocalPath(
      { file_id: "bigfile_abcd1234" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_x", cacheDir, maxBytes, fetch: fakeFetch },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("size_exceeded");
    expect(r.error).toContain(String(declared));
    expect(r.error).toContain(String(maxBytes));
    expect(r.error).toContain("refused pre-stream");   // path: pre-check branch
    // No cache file should be left behind (no .tmp leak either)
    const { readdirSync } = require("node:fs");
    const entries = readdirSync(cacheDir);
    expect(entries.length).toBe(0);
  });

  test("Content-Length lies (says small, sends big) → size_exceeded MID-STREAM with cleanup", async () => {
    const cacheDir = freshCacheDir();
    const maxBytes = 100;              // 100-byte cap
    const declared = 50;               // hub LIES — declares 50
    const chunkSize = 80;              // one chunk = 80 bytes (under cap)
    const totalChunks = 5;             // total = 400 bytes (4× cap)
    let chunksSent = 0;
    const fakeFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          async pull(controller) {
            if (chunksSent >= totalChunks) {
              controller.close();
              return;
            }
            chunksSent++;
            controller.enqueue(new Uint8Array(chunkSize).fill(0x42));
          },
        }),
        { status: 200, headers: { "Content-Length": String(declared) } },
      );
    const r = await resolveAttachmentToLocalPath(
      { file_id: "lyinghub_xyz123" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_x", cacheDir, maxBytes, fetch: fakeFetch },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("size_exceeded");
    expect(r.error).toContain("mid-flight");
    // The stream MUST have been aborted mid-flight — we should have
    // consumed strictly fewer than totalChunks before the cap tripped.
    // 100-byte cap with 80-byte chunks → trips after chunk 2 (160 > 100).
    expect(chunksSent).toBeLessThan(totalChunks);
    expect(chunksSent).toBeGreaterThanOrEqual(2);   // chunk 1 alone is 80 < 100 → keep going; chunk 2 makes 160 > 100 → abort
    // No leaked .tmp files in cache dir
    const { readdirSync } = require("node:fs");
    const entries = readdirSync(cacheDir);
    expect(entries.filter((e: string) => e.endsWith(".tmp") || e.endsWith(`.tmp-${process.pid}`)).length).toBe(0);
  });

  test("DEFAULT_MAX_BYTES is 50 MiB unless COMMHUB_ATTACHMENT_MAX_BYTES is set (current process is unset → 50 MiB)", () => {
    // Lock the unit so future bumps are deliberate.
    if (!process.env.COMMHUB_ATTACHMENT_MAX_BYTES) {
      expect(DEFAULT_MAX_BYTES).toBe(50 * 1024 * 1024);
    }
  });
});

describe("resolveAttachmentToLocalPath — local path fallback (single-host / feishu compat)", () => {
  test("no file_id + path exists → returns the path as-is, no HTTP call", async () => {
    const cacheDir = freshCacheDir();
    const localFile = join(cacheDir, "single-host.png");
    writeFileSync(localFile, Buffer.from([1, 2, 3, 4, 5]));
    let called = false;
    const fakeFetch: typeof fetch = async () => { called = true; return new Response(""); };
    const r = await resolveAttachmentToLocalPath(
      { path: localFile, mime: "image/png" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_x", cacheDir, fetch: fakeFetch },
    );
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    expect(r.localPath).toBe(localFile);
    expect(r.cached).toBe(true);
    expect(r.bytes).toBe(5);
    expect(called).toBe(false);
  });

  test("no file_id + path does NOT exist → not_found error", async () => {
    const cacheDir = freshCacheDir();
    const r = await resolveAttachmentToLocalPath(
      { path: "/nonexistent/path/to/missing-attachment.png" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_x", cacheDir },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("not_found");
    expect(r.error).toContain("does not exist on this host");
  });

  test("no file_id AND no path → no_file_id_no_path error", async () => {
    const cacheDir = freshCacheDir();
    const r = await resolveAttachmentToLocalPath(
      { mime: "image/png" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_x", cacheDir },
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("no_file_id_no_path");
  });
});

describe("resolveAttachmentToLocalPath — cache hit", () => {
  test("same file_id + same size → no HTTP call, returns cached:true", async () => {
    const cacheDir = freshCacheDir();
    const fileId = "cached_abcd1234";
    const payload = Buffer.from("already cached payload bytes");
    const cachedPath = join(cacheDir, `${fileId}.png`);
    writeFileSync(cachedPath, payload);
    let called = false;
    const fakeFetch: typeof fetch = async () => { called = true; return new Response(""); };
    const r = await resolveAttachmentToLocalPath(
      { file_id: fileId, size: payload.length, name: "x.png" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_x", cacheDir, fetch: fakeFetch },
    );
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    expect(r.cached).toBe(true);
    expect(r.bytes).toBe(payload.length);
    expect(called).toBe(false);
  });

  test("same file_id + different size → cache miss, re-fetches", async () => {
    const cacheDir = freshCacheDir();
    const fileId = "stalecache_xyz123";
    const stalePayload = Buffer.from("old short");
    const freshPayload = Buffer.from("new longer payload from hub");
    const cachedPath = join(cacheDir, `${fileId}.png`);
    writeFileSync(cachedPath, stalePayload);
    let called = false;
    const fakeFetch: typeof fetch = async () => {
      called = true;
      return new Response(freshPayload, {
        status: 200,
        headers: { "Content-Length": String(freshPayload.length) },
      });
    };
    const r = await resolveAttachmentToLocalPath(
      { file_id: fileId, size: freshPayload.length, name: "x.png" },
      { hubUrl: "http://hub.test:9200", authToken: "ntok_x", cacheDir, fetch: fakeFetch },
    );
    if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
    expect(r.cached).toBe(false);
    expect(called).toBe(true);
    expect(readFileSync(r.localPath)).toEqual(freshPayload);
  });
});

describe("sweepAttachmentCacheOnce", () => {
  test("purges files older than TTL, keeps fresh", () => {
    const cacheDir = freshCacheDir();
    const fresh = join(cacheDir, "fresh_abc1234.png");
    const old = join(cacheDir, "old_xyz12345.png");
    writeFileSync(fresh, Buffer.from("x"));
    writeFileSync(old, Buffer.from("y"));
    // Backdate the old file's mtime
    const oldEnoughMs = Date.now() - (CACHE_TTL_MS + 60_000);
    const { utimesSync } = require("node:fs");
    utimesSync(old, oldEnoughMs / 1000, oldEnoughMs / 1000);
    const r = sweepAttachmentCacheOnce({ cacheDir });
    expect(r.scanned).toBe(2);
    expect(r.purged.length).toBe(1);
    expect(r.purged[0].name).toBe("old_xyz12345.png");
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(old)).toBe(false);
    expect(r.errors).toBe(0);
  });

  test("no-op when cache dir doesn't exist", () => {
    const r = sweepAttachmentCacheOnce({ cacheDir: "/tmp/this-dir-definitely-does-not-exist-xyz789" });
    expect(r.scanned).toBe(0);
    expect(r.purged.length).toBe(0);
    expect(r.errors).toBe(0);
  });
});
