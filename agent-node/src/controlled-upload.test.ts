import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  mkdirSync, writeFileSync, symlinkSync, rmSync, chmodSync, existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CONTROLLED_UPLOAD_MAX_BYTES,
  defaultControlledUploadRoots,
  normalizeUploadName,
  resolveControlledUploadPath,
  uploadControlledLocalFile,
} from "./controlled-upload";

const ROOT = join(tmpdir(), `anet-693-upload-test-${process.pid}`);

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

describe("resolveControlledUploadPath", () => {
  const roots = () => [join(ROOT, "allowed")];

  it("accepts regular file under root", () => {
    const p = join(ROOT, "allowed", "pic.png");
    writeFileSync(p, PNG_1x1);
    const r = resolveControlledUploadPath(p, roots());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.canonicalPath.endsWith("pic.png")).toBe(true);
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
    const p = join(ROOT, "allowed", "sub", "..", "..", "outside", "x.png");
    writeFileSync(join(ROOT, "outside", "x.png"), PNG_1x1);
    const r = resolveControlledUploadPath(p, roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_untrusted");
  });

  it("rejects symlink leaf even when link sits inside root", () => {
    const target = join(ROOT, "outside", "secret.png");
    writeFileSync(target, PNG_1x1);
    const link = join(ROOT, "allowed", "looks-safe.png");
    symlinkSync(target, link);
    const r = resolveControlledUploadPath(link, roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(["path_symlink", "path_untrusted"]).toContain(r.error);
  });

  it("rejects directory", () => {
    const r = resolveControlledUploadPath(join(ROOT, "allowed"), roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_not_regular");
  });

  it("rejects missing path", () => {
    const r = resolveControlledUploadPath(join(ROOT, "allowed", "nope.png"), roots());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("path_not_found");
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

  it("refuses oversize file before network", async () => {
    const p = join(ROOT, "allowed", "big.bin");
    // sparse-ish write: write beyond limit via buffer of max+1 would OOM;
    // write a small file and stub stat via resolving path then patch size
    // by writing max+1 bytes only if feasible — use 64KiB chunk repeated? 
    // Keep unit cheap: write empty then manually call size gate via huge buffer file of 100 bytes
    // and inject by temporarily monkeying CONTROLLED — instead write file and mock:
    writeFileSync(p, Buffer.alloc(100));
    // Direct path: create real oversized only when env asks — skip real 12MiB in unit.
    // Use a mock by placing file and checking path_untrusted for wrong roots is enough;
    // size gate covered by constructing via read of a file we claim:
    // We'll call resolve + size check by writing CONTROLLED_UPLOAD_MAX_BYTES+1 is heavy.
    // Write 1 byte over using sparse? Node writeFileSync Buffer.alloc(12*1024*1024+1) ~12MB ok in tests.
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

  it("never falls back to path when file_id missing in hub response", async () => {
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
