// Task #25 — regression pins for ext validation in validateIndexEntry.
//
// 🔴 SCOPE: this suite exercises the stored-index boundary through
// `validateIndexEntry`. Issue #527 removed the three independent copies
// of the stored extension-token grammar: buildStoragePath,
// pathForExistingBlob and validateIndexEntry now use one shared private
// validator. `ext-token-shared.test.ts` separately pins all three call
// sites. sanitizeExt remains intentionally independent because it parses
// a client filename rather than validating an already-extracted token.
//
// Background (通信龙 d01bb8ce): the stored extension-token grammar
// `/^\.[A-Za-z0-9]{1,16}$/` correctly rejects 11 known malicious ext
// values (path-escape, traversal, absolute paths, doubles, NUL bytes,
// backslash forms, over-length, whitespace). Verified via real-run on
// origin/main by lead — 11/11 malicious values → false.
//
// But NO test locked that behavior. Anyone who widens the regex in the
// future (accidentally or on purpose) would not hit a red test — the
// live protection would degrade silently. This suite pins current
// behavior in two directions:
//
//   1. SAFETY  (欠修 direction) — 11 malicious values → false, one row
//      per value with the exact literal. If regex is widened to accept
//      any of them, that row turns red.
//   2. NON-REGRESSION (过修 direction) — a set of common legitimate
//      extensions → true. If regex is tightened to reject any of them
//      (e.g. someone locks down to a whitelist), that row turns red.
//
// Witnessed-red for the SAFETY rows: temporarily widen the regex to
// `/./` (or comment it out) in validateIndexEntry, run this suite,
// confirm all 11 malicious rows turn red, then revert. The mutation
// itself is not committed; the assertion IS the mutation-red proof
// for the reader. Recording the mutation output in the followup PR
// body (per Constraint 3 discipline established in #503).
//
// Pure unit test — no server setup, no DB, no filesystem. The regex
// lives in a pure function, so the guard is testable at that level.

import { describe, expect, test } from "bun:test";
import { validateIndexEntry } from "./uploads.js";

// A structurally-valid base entry — file_id / date_bucket / size all
// pass their own checks — so `ext` is the only field a test row varies.
// This isolates the ext regex as the deciding factor.
const validBase = {
  file_id: "0123456789abcdef0123456789abcdef",
  date_bucket: "2026-07-30",
  size: 0,
};

describe("Task #25 (#503 followup) — ext validation regression pins", () => {
  describe("SAFETY: the 11 malicious ext values from lead d01bb8ce all return false", () => {
    // Each row uses the exact literal from lead's verification list so
    // a widening regex catches on the same value the manual audit did.
    const malicious: Array<{ label: string; ext: string }> = [
      { label: "path-escape prefix",          ext: "../x" },
      { label: "deep traversal to /etc",       ext: "../../etc/passwd" },
      { label: "absolute path",               ext: "/abs/x" },
      { label: "double-dot alone",            ext: ".." },
      { label: "single-dot alone",            ext: "." },
      { label: "chained after legit prefix",  ext: ".png/../../y" },
      { label: "embedded whitespace",         ext: ".p ng" },
      { label: "over-length (>16 chars)",     ext: "." + "a".repeat(17) },
      { label: "embedded NUL byte",           ext: ".p\x00ng" },
      { label: "backslash traversal",         ext: ".\\..\\x" },
      { label: "double-backslash prefix",     ext: "..\\x" },
    ];
    for (const { label, ext } of malicious) {
      test(`rejects: ${label} — ext=${JSON.stringify(ext)}`, () => {
        expect(validateIndexEntry({ ...validBase, ext })).toBe(false);
      });
    }

    test("precondition: 11 malicious cases enumerated (defends against silent test-shrink)", () => {
      // If someone deletes rows from the malicious list, this fails
      // instead of the deletion silently narrowing the guard. Number
      // matches lead's verification list — bump only when lead adds a
      // case and confirms it via real-run.
      expect(malicious.length).toBe(11);
    });
  });

  describe("NON-REGRESSION: common legitimate extensions all return true (防过修)", () => {
    // These are the extensions the live upload path actually produces
    // via sanitizeExt / mime-typed multipart uploads. If someone
    // tightens the regex to a stricter whitelist, any of these turning
    // red flags a break in a normal user path.
    const legal = [".png", ".pdf", ".pptx", ".jpg", ".jpeg", ".txt", ".mp4", ".zip", ".json", ".md"];
    for (const ext of legal) {
      test(`accepts: ext=${JSON.stringify(ext)}`, () => {
        expect(validateIndexEntry({ ...validBase, ext })).toBe(true);
      });
    }

    test("empty ext is accepted (file with no extension is a legitimate upload)", () => {
      expect(validateIndexEntry({ ...validBase, ext: "" })).toBe(true);
    });

    test("precondition: at least 10 legitimate ext values pinned", () => {
      // Same discipline as the malicious side — reject silent shrink.
      expect(legal.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe("regex shape assumptions (documented, not enforced by the function)", () => {
    // These rows document facts the current regex enforces beyond the
    // 11 malicious literals. They are close to the boundary and would
    // be the first things to move if someone reworked the regex.
    test("upper-case extensions accepted (regex is case-insensitive by [A-Za-z])", () => {
      expect(validateIndexEntry({ ...validBase, ext: ".PNG" })).toBe(true);
    });
    test("mixed-case extensions accepted", () => {
      expect(validateIndexEntry({ ...validBase, ext: ".PdF" })).toBe(true);
    });
    test("digits after dot accepted (e.g. .mp4, .mp3)", () => {
      expect(validateIndexEntry({ ...validBase, ext: ".mp4" })).toBe(true);
    });
    test("exactly 16 chars after dot is accepted (upper bound of {1,16})", () => {
      expect(validateIndexEntry({ ...validBase, ext: "." + "a".repeat(16) })).toBe(true);
    });
    test("exactly 17 chars after dot is rejected (immediately past upper bound)", () => {
      expect(validateIndexEntry({ ...validBase, ext: "." + "a".repeat(17) })).toBe(false);
    });
    test("compound extensions like .tar.gz are rejected (contains inner dot)", () => {
      // Documented: the current regex does not support compound
      // extensions. If we ever want .tar.gz support, it needs its
      // own explicit design + this row updated with lead sign-off.
      expect(validateIndexEntry({ ...validBase, ext: ".tar.gz" })).toBe(false);
    });
  });
});
