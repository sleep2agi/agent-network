// #503 F3=A static guard: every 4xx return in the /api/upload handler
// that fires BEFORE `req.formData()` drains the request body MUST be
// wrapped in `earlyReject` (which sets `Connection: close`). Otherwise
// the client's still-inbound body poisons the keepalive pool and the
// next pooled request stalls.
//
// Why a STATIC guard (not a runtime one): mutation M9 in
// docs/tests/p-503-file-network-scope/mutation-matrix.txt showed that
// under Bun's fetch client in this test setup, removing
// `Connection: close` does NOT turn any dynamic test red — the pool
// poisoning is real HTTP-level behavior but the client under test does
// not reliably reproduce it. Without a guard, deleting the helper or
// forgetting to wrap a NEW 15th pre-drain return goes silent. This
// test judges the SOURCE FILE, per lead 7a88ce29 and Constraint 3-1
// pattern (source-based, not runner-output-based).
//
// PRIOR-ART GOTCHA (lead 7a88ce29 踩过): parse boundaries MUST exclude
// comments. `req.formData()` appears in a doc comment near the top of
// the handler too; if the boundary matches on that, the pre-drain
// range collapses to empty and this guard silently becomes vacuously
// true. Same trap family as "范围为空的全称断言恒真". So this test
// has an explicit precondition: the parsed pre-drain return count must
// be ≥ 10 (currently 14). If the count drops to 0, the boundary parser
// broke, not the code.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const SOURCE_PATH = join(import.meta.dirname, "server.ts");
const RAW = readFileSync(SOURCE_PATH, "utf-8");
const LINES = RAW.split("\n");

// Strip line-comments so we don't match on comment-mentioned tokens
// like the "req.formData()" doc references at the top of the handler.
// (Block comments /* */ are rare inside this handler; if you add one
// that mentions the boundary, extend this helper.)
//
// KNOWN LIMITATION (lead 50208c1b): this naive strip cuts on ANY `//`,
// including one inside a string literal (e.g. `"https://…"`). If a
// pre-drain line ever contains such a literal, the strip could snip
// off the return statement after it and produce a false NEGATIVE (miss
// a genuine unwrapped return). Currently no pre-drain line in the
// /api/upload handler holds this shape; the precondition floor of 10
// catches only "range collapsed to empty", not "silently minus one".
// If someone adds a URL-string literal in this range in the future,
// upgrade to a real tokenizer — not because block-comment mentions of
// req.formData() need it, but because the string-literal-with-`//`
// case is the actual gap.
function stripLineComment(s: string): string {
  const idx = s.indexOf("//");
  return idx >= 0 ? s.slice(0, idx) : s;
}
const CODE = LINES.map(stripLineComment);

// Find the /api/upload handler start (guard against a repo rename).
const handlerStartIdx = CODE.findIndex((line) =>
  line.includes('url.pathname === "/api/upload"') &&
  line.includes('req.method === "POST"'),
);

// Find the true body-drain boundary: `await req.formData()` INSIDE the
// handler. Search from handler start forward for the first NON-COMMENT
// occurrence (stripLineComment above already ate any `// ... formData ...`
// mention).
let drainIdx = -1;
if (handlerStartIdx >= 0) {
  for (let i = handlerStartIdx + 1; i < CODE.length; i++) {
    if (CODE[i].includes("req.formData()")) {
      drainIdx = i;
      break;
    }
  }
}

// Collect every `return` statement in the pre-drain range. Classify:
//   earlyReject  — the correct wrapping (sets Connection: close)
//   withCors     — bare wrapping without Connection: close (regression)
//   other        — produces a Response some OTHER way (e.g.
//                  `return Response.json(...)` / `return new Response(...)`);
//                  this shape ALSO skips earlyReject and MUST fail the guard.
//                  Detected via /Response\b/ so `return wrapped;` /
//                  `return;` / `return blob;` (helper body, non-response
//                  returns) are correctly skipped, but any new Response-
//                  producing path (Response.json / new Response / etc.) is
//                  caught. Lead 50208c1b: earlier version used implicit-skip
//                  which made the third assertion恒真 — it counted only what
//                  it recognised, so "unrecognised = 0" was vacuous.
//                  Order matters: earlyReject → withCors → other. A line
//                  like `return earlyReject(new Response(…))` contains
//                  both `earlyReject` AND `Response`, and must classify as
//                  earlyReject (already-wrapped), not as other.
type ReturnHit = { lineNumber: number; text: string; kind: "earlyReject" | "withCors" | "other" };
const preDrainReturns: ReturnHit[] = [];
if (handlerStartIdx >= 0 && drainIdx > handlerStartIdx) {
  for (let i = handlerStartIdx; i < drainIdx; i++) {
    const code = CODE[i];
    if (!/\breturn\b/.test(code)) continue;
    if (/\breturn earlyReject\b/.test(code)) {
      preDrainReturns.push({ lineNumber: i + 1, text: LINES[i].trim(), kind: "earlyReject" });
    } else if (/\breturn withCors\b/.test(code)) {
      preDrainReturns.push({ lineNumber: i + 1, text: LINES[i].trim(), kind: "withCors" });
    } else if (/Response\b/.test(code)) {
      // `return new Response(...)` / `return Response.json(...)` / etc.
      // — produces a Response but skips the earlyReject wrapper.
      preDrainReturns.push({ lineNumber: i + 1, text: LINES[i].trim(), kind: "other" });
    }
    // Bare `return wrapped;`, `return;`, `return blob;` are non-response
    // returns and correctly skipped (no `Response` token).
  }
}

describe("#503 F3=A static guard: /api/upload pre-body-drain returns use earlyReject", () => {
  test("precondition: scanner located handler + drain boundary + non-trivial return count (defends against parse collapse)", () => {
    expect(handlerStartIdx).toBeGreaterThanOrEqual(0);
    expect(drainIdx).toBeGreaterThan(handlerStartIdx);
    // If boundary parsing collapses (someone renames req.formData(),
    // or a comment-strip bug lets a doc reference win), this range
    // becomes 0 and the second test would vacuously pass. Anchor
    // the range: at time of writing (85e5c140 + #503) the count is
    // 14; lead 7a88ce29 confirmed 14/14. Floor at 10 to leave room
    // for genuine deletions while still catching a full collapse.
    expect(preDrainReturns.length).toBeGreaterThanOrEqual(10);
  });

  test("every pre-drain return is wrapped in earlyReject (not bare withCors)", () => {
    const bareWithCors = preDrainReturns.filter((r) => r.kind === "withCors");
    if (bareWithCors.length > 0) {
      const detail = bareWithCors
        .map((r) => `  L${r.lineNumber}: ${r.text}`)
        .join("\n");
      throw new Error(
        `#503 F3=A regression: ${bareWithCors.length} pre-body-drain return(s) in ` +
        `/api/upload use bare withCors() instead of earlyReject():\n${detail}\n\n` +
        `Every early-reject in this range MUST set Connection: close. Otherwise ` +
        `the client's in-flight request body poisons the keepalive pool and the ` +
        `next pooled request stalls. Wrap with the earlyReject() helper defined ` +
        `at the top of the upload handler.`,
      );
    }
    expect(bareWithCors.length).toBe(0);
  });

  test("no pre-drain return produces a Response without going through earlyReject (catches new response shapes)", () => {
    // Catches `return Response.json(...)` / `return new Response(...)` /
    // any other pre-drain Response-producing path that skips the wrapper.
    // Lead 50208c1b: previous version was 恒真 because unrecognised
    // shapes were silently dropped from `preDrainReturns` — the filter
    // then counted "recognised = recognised" and never failed. Now the
    // collector classifies unrecognised Response-producers as "other";
    // this assertion reports them by line, not just count.
    const unknown = preDrainReturns.filter((r) => r.kind === "other");
    expect(unknown.map((r) => `L${r.lineNumber}: ${r.text}`)).toEqual([]);
  });
});
