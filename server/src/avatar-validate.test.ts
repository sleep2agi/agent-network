// #462 — unit tests for the avatar_url XSS boundary (avatar-validate.ts).
//
// The validator's whole job is to keep hostile values out of a dashboard
// <img src>; every rejection case here is a concrete injection shape.
// Live-gate check: replace validateAvatarUrl with `return { ok: true,
// value: String(raw) }` and the javascript:/data:/control-char tests go
// red.

import { describe, expect, test } from "bun:test";
import { MAX_AVATAR_URL_LENGTH, validateAvatarUrl } from "./avatar-validate";

describe("#462 validateAvatarUrl", () => {
  test("accepts plain https URL", () => {
    const r = validateAvatarUrl("https://cdn.example.com/a/b.png");
    expect(r).toEqual({ ok: true, value: "https://cdn.example.com/a/b.png" });
  });

  test("accepts http URL and trims surrounding whitespace", () => {
    const r = validateAvatarUrl("  http://example.com/x.jpg  ");
    expect(r).toEqual({ ok: true, value: "http://example.com/x.jpg" });
  });

  test("accepts URL with query string", () => {
    const r = validateAvatarUrl("https://example.com/img?size=64&v=2");
    expect(r.ok).toBe(true);
  });

  test("null / undefined / empty / whitespace-only → clear (value null)", () => {
    expect(validateAvatarUrl(null)).toEqual({ ok: true, value: null });
    expect(validateAvatarUrl(undefined)).toEqual({ ok: true, value: null });
    expect(validateAvatarUrl("")).toEqual({ ok: true, value: null });
    expect(validateAvatarUrl("   ")).toEqual({ ok: true, value: null });
  });

  test("rejects non-string types", () => {
    expect(validateAvatarUrl(42).ok).toBe(false);
    expect(validateAvatarUrl({ url: "https://x" }).ok).toBe(false);
    expect(validateAvatarUrl(["https://x"]).ok).toBe(false);
    expect(validateAvatarUrl(true).ok).toBe(false);
  });

  test("rejects javascript: pseudo-protocol", () => {
    expect(validateAvatarUrl("javascript:alert(1)").ok).toBe(false);
    expect(validateAvatarUrl("JavaScript:alert(1)").ok).toBe(false);
    expect(validateAvatarUrl("JAVASCRIPT:alert(document.cookie)").ok).toBe(false);
  });

  test("rejects javascript: smuggled via embedded tab/newline (URL() would strip them)", () => {
    expect(validateAvatarUrl("java\tscript:alert(1)").ok).toBe(false);
    expect(validateAvatarUrl("java\nscript:alert(1)").ok).toBe(false);
    expect(validateAvatarUrl("java\rscript:alert(1)").ok).toBe(false);
  });

  test("rejects data: / vbscript: / file: / blob: and other non-http protocols", () => {
    expect(validateAvatarUrl("data:text/html,<script>alert(1)</script>").ok).toBe(false);
    expect(validateAvatarUrl("data:image/png;base64,iVBORw0KGgo=").ok).toBe(false);
    expect(validateAvatarUrl("vbscript:msgbox(1)").ok).toBe(false);
    expect(validateAvatarUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateAvatarUrl("blob:https://example.com/uuid").ok).toBe(false);
    expect(validateAvatarUrl("ftp://example.com/a.png").ok).toBe(false);
  });

  test("rejects relative / protocol-relative / non-URL strings", () => {
    expect(validateAvatarUrl("/avatars/1.png").ok).toBe(false);
    expect(validateAvatarUrl("//cdn.example.com/1.png").ok).toBe(false);
    expect(validateAvatarUrl("not a url").ok).toBe(false);
    expect(validateAvatarUrl("example.com/x.png").ok).toBe(false);
  });

  test("rejects embedded whitespace and control characters", () => {
    expect(validateAvatarUrl("https://example.com/a b.png").ok).toBe(false);
    expect(validateAvatarUrl("https://example.com/a\u0000.png").ok).toBe(false);
    expect(validateAvatarUrl("https://example.com/a\u009f.png").ok).toBe(false);
  });

  test("normalizes to parsed.href: markup-hostile chars come out percent-encoded (finding 3)", () => {
    const r1 = validateAvatarUrl('https://example.com/a"b.png');
    expect(r1).toEqual({ ok: true, value: "https://example.com/a%22b.png" });
    const r2 = validateAvatarUrl("https://example.com/</script><script>.png");
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(r2.value).not.toContain("<");
      expect(r2.value).not.toContain(">");
    }
    const r3 = validateAvatarUrl("https://example.com/a`b.png");
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.value).not.toContain("`");
  });

  test("rejects values whose href still carries attribute-breaking chars (single quote)", () => {
    // WHATWG URL leaves ' un-encoded in the PATH component — href alone
    // doesn't neutralize it there, so the validator must refuse.
    expect(validateAvatarUrl("https://example.com/a'b.png").ok).toBe(false);
    // In the QUERY component ' IS percent-encoded by href → accepted,
    // but the stored value must carry no raw quote.
    const q = validateAvatarUrl("https://example.com/x.png?a='1'");
    expect(q.ok).toBe(true);
    if (q.ok) expect(q.value).not.toContain("'");
  });

  test("enforces the length cap", () => {
    const base = "https://example.com/";
    const ok = base + "a".repeat(MAX_AVATAR_URL_LENGTH - base.length);
    expect(validateAvatarUrl(ok).ok).toBe(true);
    expect(validateAvatarUrl(ok + "a").ok).toBe(false);
  });
});
