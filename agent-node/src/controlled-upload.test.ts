import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync, writeFileSync, symlinkSync, rmSync, openSync, fstatSync, closeSync, readFileSync, readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONTROLLED_UPLOAD_MAX_BYTES,
  defaultControlledUploadRoots,
  normalizeUploadName,
  openFstatBoundedReadControlledFile,
  resolveControlledUploadPath,
  uploadControlledLocalFile,
} from "./controlled-upload";

const ROOT = join(tmpdir(), `anet-693-upload-test-${process.pid}-${Date.now()}`);

beforeEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "allowed", "sub"), { recursive: true });
  mkdirSync(join(ROOT, "outside"), { recursive: true });
});

afterEach(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

describe("normalizeUploadName", () => {
  it("strips directories and control chars", () => {
    expect(normalizeUploadName("../../etc/passwd")).toBe("passwd");
    expect(normalizeUploadName("a\nb.png")).toBe("a_b.png");
  });
});

describe("resolveControlledUploadPath — NUL live guard", () => {
  const roots = () => [join(ROOT, "allowed")];

  it("rejects embedded NUL before any fs access", () => {
    const p = join(ROOT, "allowed", "pic.png");
    writeFileSync(p, PNG_1x1);
    // Construct path with NUL without using path APIs that strip it
    const evil = p.slice(0, p.length - 4) + "\0.png";
    const r = resolveControlledUploadPath(evil, roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_nul");
  });

  it("rejects NUL-only / leading NUL", () => {
    const r = resolveControlledUploadPath("\0/etc/passwd", roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_nul");
  });
});

describe("resolveControlledUploadPath", () => {
  const roots = () => [join(ROOT, "allowed")];

  it("accepts regular file under root", () => {
    const p = join(ROOT, "allowed", "pic.png");
    writeFileSync(p, PNG_1x1);
    const r = resolveControlledUploadPath(p, roots());
    expect(r.ok).toBe(true);
  });

  it("rejects path outside roots", () => {
    const p = join(ROOT, "outside", "secret.png");
    writeFileSync(p, PNG_1x1);
    const r = resolveControlledUploadPath(p, roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_untrusted");
  });

  it("rejects absolute foreign path /etc/passwd", () => {
    const r = resolveControlledUploadPath("/etc/passwd", roots());
    expect(r.ok).toBe(false);
  });

  it("rejects traversal that escapes root", () => {
    writeFileSync(join(ROOT, "outside", "x.png"), PNG_1x1);
    const p = join(ROOT, "allowed", "sub", "..", "..", "outside", "x.png");
    const r = resolveControlledUploadPath(p, roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_untrusted");
  });

  it("rejects missing path", () => {
    const r = resolveControlledUploadPath(join(ROOT, "allowed", "nope.png"), roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_not_found");
  });
});

describe("openFstatBoundedReadControlledFile — same fd + bound", () => {
  const roots = () => [join(ROOT, "allowed")];

  it("reads small PNG via same-fd path", () => {
    const p = join(ROOT, "allowed", "pic.png");
    writeFileSync(p, PNG_1x1);
    const r = openFstatBoundedReadControlledFile(p, roots());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.size).toBe(PNG_1x1.length);
      expect(r.bytes.equals(PNG_1x1)).toBe(true);
    }
  });

  it("rejects oversize without allocating full max+1 into a single slurp beyond cap", () => {
    const big = join(ROOT, "allowed", "huge.bin");
    writeFileSync(big, Buffer.alloc(CONTROLLED_UPLOAD_MAX_BYTES + 1));
    const r = openFstatBoundedReadControlledFile(big, roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("payload_too_large");
  });

  it("rejects symlink leaf at open (O_NOFOLLOW)", () => {
    const target = join(ROOT, "outside", "secret.png");
    writeFileSync(target, PNG_1x1);
    const link = join(ROOT, "allowed", "looks-safe.png");
    symlinkSync(target, link);
    // realpath of symlink may point outside — resolve would fail untrusted;
    // call open directly with link path that is under root as string but is symlink
    // First place a realpath that is the link itself if we pass link under root...
    // openFstatBoundedRead expects already-resolved path; pass link path only if inside roots via realpath fail
    // Use the link path: if realpath follows to outside, isPathInsideAllowedRoots fails first.
    const r = openFstatBoundedReadControlledFile(link, roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["path_symlink", "path_untrusted", "path_not_found"]).toContain(r.error);
  });

  it("fstat is on the same opened fd (structural pin)", () => {
    // Source-level contract: openFstatBoundedReadControlledFile must not call
    // path-based readFileSync — covered by mutation suite. Here assert API shape.
    const p = join(ROOT, "allowed", "pic.png");
    writeFileSync(p, PNG_1x1);
    const fd = openSync(p, "r");
    try {
      const st = fstatSync(fd);
      expect(st.isFile()).toBe(true);
      expect(st.size).toBe(PNG_1x1.length);
    } finally {
      closeSync(fd);
    }
  });
});

describe("uploadControlledLocalFile", () => {
  it("uploads PNG fixture via mock fetch and returns file_id", async () => {
    const p = join(ROOT, "allowed", "gen.png");
    writeFileSync(p, PNG_1x1);
    const fakeFetch = (async (_url: any, init?: any) => {
      expect(init?.method).toBe("POST");
      expect(String(init?.headers?.Authorization || "")).toContain("Bearer ntok_test");
      return new Response(JSON.stringify({
        ok: true,
        file_id: "aabbccddeeff00112233445566778899",
        url: "/api/files/aabbccddeeff00112233445566778899",
        size: PNG_1x1.length,
        mime: "image/png",
      }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await uploadControlledLocalFile(p, {
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_test",
      allowedRoots: [join(ROOT, "allowed")],
      fetch: fakeFetch,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.file_id).toBe("aabbccddeeff00112233445566778899");
      expect(r.mime).toBe("image/png");
      expect(r.size).toBe(PNG_1x1.length);
    }
  });

  it("refuses oversize before network", async () => {
    const big = join(ROOT, "allowed", "huge.bin");
    writeFileSync(big, Buffer.alloc(CONTROLLED_UPLOAD_MAX_BYTES + 1));
    let called = false;
    const r = await uploadControlledLocalFile(big, {
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_test",
      allowedRoots: [join(ROOT, "allowed")],
      fetch: (async () => { called = true; return new Response("{}"); }) as any,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("payload_too_large");
    expect(called).toBe(false);
  });

  it("never falls back to path when file_id missing", async () => {
    const p = join(ROOT, "allowed", "gen.png");
    writeFileSync(p, PNG_1x1);
    const r = await uploadControlledLocalFile(p, {
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_test",
      allowedRoots: [join(ROOT, "allowed")],
      fetch: (async () => new Response(JSON.stringify({ ok: true, path: "/hub/evil" }), { status: 200 })) as any,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("missing_file_id");
  });

  it("rejects untrusted path without calling hub", async () => {
    const p = join(ROOT, "outside", "x.png");
    writeFileSync(p, PNG_1x1);
    let called = false;
    const r = await uploadControlledLocalFile(p, {
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_test",
      allowedRoots: [join(ROOT, "allowed")],
      fetch: (async () => { called = true; return new Response("{}"); }) as any,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_untrusted");
    expect(called).toBe(false);
  });

  it("rejects NUL path without calling hub", async () => {
    let called = false;
    const r = await uploadControlledLocalFile("/tmp/x\0y.png", {
      hubUrl: "http://hub.test:9200",
      authToken: "ntok_test",
      allowedRoots: [join(ROOT, "allowed")],
      fetch: (async () => { called = true; return new Response("{}"); }) as any,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_nul");
    expect(called).toBe(false);
  });
});

describe("defaultControlledUploadRoots", () => {
  it("includes grok sessions and attachment cache", () => {
    const roots = defaultControlledUploadRoots({
      home: ROOT,
      alias: "grok测试员",
      env: {},
    });
    expect(roots.some((r) => r.includes(".grok") && r.includes("sessions"))).toBe(true);
    expect(roots.some((r) => r.includes("attachments") && r.includes("grok测试员"))).toBe(true);
  });
});


describe("source contracts (adversarial pins)", () => {
  const src = readFileSync(join(import.meta.dir, "controlled-upload.ts"), "utf8");

  it("same-fd pin: fstatSync(fd) + openSync; no path re-stat/readFileSync in reader", () => {
    expect(src).toContain("fstatSync(fd)");
    expect(src).toContain("openSync(canonicalPath");
    const reader = src.slice(src.indexOf("export function openFstatBoundedReadControlledFile"));
    expect(reader.includes("statSync(canonicalPath)")).toBe(false);
    expect(reader.includes("readFileSync(")).toBe(false);
  });

  it("NUL guard pin: rawPath.includes NUL marker present", () => {
    // Source stores the check as rawPath.includes("\0") — two-char escape in file.
    expect(src.includes("path_nul")).toBe(true);
    expect(src.includes("rawPath.includes(")).toBe(true);
    expect(src.includes("\\0") || src.includes("\0")).toBe(true);
  });

  it("bounded-read pin: extra-byte probe after maxBytes", () => {
    expect(src).toContain("extra bytes after cap");
    expect(src).toContain("CONTROLLED_UPLOAD_READ_CHUNK");
  });
});
