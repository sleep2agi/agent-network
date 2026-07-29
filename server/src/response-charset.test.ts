// #426 unit tests for the withUtf8CharsetContentType helper — the
// piece that rewrites text-y Content-Type headers to include
// charset=utf-8 so legacy Windows clients don't fall back to
// ISO-8859-1 decoding. The helper lives in server/src/index.ts;
// to keep the test standalone we re-implement its pure semantics here
// and assert those. Any drift between this pure copy and the
// production helper is caught by the "identical semantics" test at
// the bottom via a source grep.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Pure re-implementation — MUST match server/src/index.ts:withUtf8CharsetContentType.
function withUtf8CharsetContentType(res: Response): Response {
  const ct = res.headers.get("content-type");
  if (!ct) return res;
  if (/;\s*charset=/i.test(ct)) return res;
  const trimmed = ct.trim();
  if (
    trimmed === "application/json" ||
    trimmed.startsWith("text/") ||
    trimmed.startsWith("application/json;") ||
    trimmed === "application/ld+json" ||
    trimmed === "application/xml"
  ) {
    res.headers.set("content-type", `${trimmed}; charset=utf-8`);
  }
  return res;
}

function makeRes(contentType: string | null, body = ""): Response {
  return new Response(body, { headers: contentType ? { "content-type": contentType } : {} });
}

describe("withUtf8CharsetContentType — #426", () => {
  test("appends charset to text/event-stream", () => {
    const res = withUtf8CharsetContentType(makeRes("text/event-stream"));
    expect(res.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
  });

  test("appends charset to application/json (bare)", () => {
    const res = withUtf8CharsetContentType(makeRes("application/json"));
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  test("appends charset to text/plain", () => {
    const res = withUtf8CharsetContentType(makeRes("text/plain"));
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  });

  test("appends charset to text/html", () => {
    const res = withUtf8CharsetContentType(makeRes("text/html"));
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  });

  test("no-op when charset already present (case-insensitive)", () => {
    for (const ct of [
      "application/json; charset=utf-8",
      "application/json;charset=UTF-8",
      "text/event-stream;Charset=us-ascii",
      "text/plain; CHARSET=iso-8859-1",
    ]) {
      const res = withUtf8CharsetContentType(makeRes(ct));
      expect(res.headers.get("content-type")).toBe(ct);
    }
  });

  test("no-op on binary types (opaque)", () => {
    for (const ct of [
      "application/octet-stream",
      "image/png",
      "image/jpeg",
      "video/mp4",
      "application/pdf",
      "font/woff2",
    ]) {
      const res = withUtf8CharsetContentType(makeRes(ct));
      expect(res.headers.get("content-type")).toBe(ct);
    }
  });

  test("no-op when Content-Type header is absent entirely (returns as-is)", () => {
    const res = withUtf8CharsetContentType(makeRes(null));
    expect(res.headers.get("content-type")).toBeNull();
  });

  test("handles application/ld+json / application/xml", () => {
    expect(withUtf8CharsetContentType(makeRes("application/ld+json")).headers.get("content-type"))
      .toBe("application/ld+json; charset=utf-8");
    expect(withUtf8CharsetContentType(makeRes("application/xml")).headers.get("content-type"))
      .toBe("application/xml; charset=utf-8");
  });

  test("preserves non-charset parameters and appends charset (application/json; boundary=…)", () => {
    // Bun's Response.json emits `application/json;charset=utf-8`; the test
    // above covers that no-op path. When a caller sends a parametrised
    // header like `application/json; profile=…`, the helper still recognises
    // it via the `application/json;` prefix and appends the charset.
    const res = withUtf8CharsetContentType(makeRes("application/json; profile=example"));
    expect(res.headers.get("content-type")).toBe("application/json; profile=example; charset=utf-8");
  });

  test("returns the same Response instance (mutates in place)", () => {
    const input = makeRes("text/event-stream");
    const output = withUtf8CharsetContentType(input);
    expect(output).toBe(input);
  });

  // Drift guard: the pure copy in this file MUST match the production
  // helper's branching set. If someone edits one without touching the
  // other, this test fails visibly instead of the helper going silently
  // out of sync. Kept as fragment-level greps (not whole-body match) so
  // added comments don't break the assertion.
  test("production helper covers the same content-type branches", () => {
    const src = readFileSync(join(import.meta.dir, "server.ts"), "utf-8");
    expect(src).toContain("function withUtf8CharsetContentType(res: Response): Response {");
    expect(src).toContain("if (/;\\s*charset=/i.test(ct)) return res;");
    for (const branch of [
      'trimmed === "application/json"',
      'trimmed.startsWith("text/")',
      'trimmed.startsWith("application/json;")',
      'trimmed === "application/ld+json"',
      'trimmed === "application/xml"',
    ]) {
      expect(src).toContain(branch);
    }
    expect(src).toContain('res.headers.set("content-type", `${trimmed}; charset=utf-8`);');
  });
});
