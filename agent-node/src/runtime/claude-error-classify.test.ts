// Unit coverage for the rate-limit / empty-result classifiers extracted
// from cli.ts. Each describe block targets one of the failure modes the
// #261 P1-① review flagged — see claude-error-classify.ts header for
// the M3 incident reference.

import { describe, expect, test } from "bun:test";
import {
  isRateLimitOrQuotaError,
  isEmptyResultSoftFailure,
  quotaRemediationHint,
} from "./claude-error-classify";

describe("isRateLimitOrQuotaError — POSITIVE (must classify as quota/rate-limit)", () => {
  test("HTTP 429 standalone", () => {
    expect(isRateLimitOrQuotaError("HTTP 429 from vendor")).toBe(true);
  });
  test("HTTP 529 overloaded (Anthropic spec)", () => {
    expect(isRateLimitOrQuotaError("Got 529 from API")).toBe(true);
  });
  test("rate_limit_exceeded (Anthropic / OpenAI shape)", () => {
    expect(isRateLimitOrQuotaError("error: rate_limit_exceeded")).toBe(true);
  });
  test("rate-limit hyphen variant", () => {
    expect(isRateLimitOrQuotaError("rate-limit hit")).toBe(true);
  });
  test("rate limit space variant", () => {
    expect(isRateLimitOrQuotaError("you have hit your rate limit")).toBe(true);
  });
  test("quota exceeded phrase", () => {
    expect(isRateLimitOrQuotaError("quota exceeded for the day")).toBe(true);
  });
  test("quota exhausted phrase", () => {
    expect(isRateLimitOrQuotaError("monthly quota exhausted")).toBe(true);
  });
  test("Anthropic spec overloaded_error", () => {
    expect(isRateLimitOrQuotaError("API returned overloaded_error")).toBe(true);
  });
  test("plain overloaded mention", () => {
    expect(isRateLimitOrQuotaError("server overloaded, please try later")).toBe(true);
  });
  test("too_many_requests OpenAI-compat", () => {
    expect(isRateLimitOrQuotaError("too_many_requests")).toBe(true);
  });
  test("too many requests space form", () => {
    expect(isRateLimitOrQuotaError("Too Many Requests")).toBe(true);
  });
  test("insufficient_quota OpenAI shape", () => {
    expect(isRateLimitOrQuotaError("error code: insufficient_quota")).toBe(true);
  });
  test("usage_limit hit", () => {
    expect(isRateLimitOrQuotaError("usage_limit reached for free tier")).toBe(true);
  });
  test("MiniMax Chinese Token Plan 上限", () => {
    expect(isRateLimitOrQuotaError("Token Plan 上限 reached")).toBe(true);
  });
  test("capacity exceeded vendor message", () => {
    expect(isRateLimitOrQuotaError("regional capacity-exceeded")).toBe(true);
  });
});

describe("isRateLimitOrQuotaError — NEGATIVE (regression gate, must NOT match)", () => {
  test("401 unauthorized (auth, not quota)", () => {
    expect(isRateLimitOrQuotaError("HTTP 401 unauthorized")).toBe(false);
  });
  test("403 forbidden (auth, not quota)", () => {
    expect(isRateLimitOrQuotaError("403 forbidden")).toBe(false);
  });
  test("plain timeout (not quota)", () => {
    expect(isRateLimitOrQuotaError("request timed out after 120s")).toBe(false);
  });
  test("400 bad request (not quota)", () => {
    expect(isRateLimitOrQuotaError("400 invalid request body")).toBe(false);
  });
  test("499 client closed (not quota)", () => {
    expect(isRateLimitOrQuotaError("499 client closed request")).toBe(false);
  });
  test("ETIMEDOUT network error (not quota)", () => {
    expect(isRateLimitOrQuotaError("ETIMEDOUT connect")).toBe(false);
  });
  test("HTTP 4290 not a real status (avoid false positive on substring)", () => {
    // Note: this DOES match `\b429\b` if "4290" were tokenized weirdly,
    // but `\b` enforces word boundary so 4290 won't match. Belt + braces.
    expect(isRateLimitOrQuotaError("ref token: 4290abc")).toBe(false);
  });
  test("empty string", () => {
    expect(isRateLimitOrQuotaError("")).toBe(false);
  });
  test("null / undefined", () => {
    expect(isRateLimitOrQuotaError(null)).toBe(false);
    expect(isRateLimitOrQuotaError(undefined)).toBe(false);
  });
});

describe("isEmptyResultSoftFailure — POSITIVE (must flag as empty-vendor-reply)", () => {
  test("result null + output_tokens 0", () => {
    expect(isEmptyResultSoftFailure({ result: null, usage: { input_tokens: 100, output_tokens: 0 } })).toBe(true);
  });
  test("result undefined (M3 incident shape)", () => {
    expect(isEmptyResultSoftFailure({ usage: { output_tokens: 0 } })).toBe(true);
  });
  test("result empty string but usage non-zero", () => {
    expect(isEmptyResultSoftFailure({ result: "", usage: { output_tokens: 5 } })).toBe(true);
  });
  test("result has text but output_tokens 0 (suspicious)", () => {
    // Vendor returned text but 0 output_tokens reported — flagged because
    // the consistent-state invariant is broken; the lying-usage case is
    // also worth surfacing rather than silently shipping.
    expect(isEmptyResultSoftFailure({ result: "some text", usage: { output_tokens: 0 } })).toBe(true);
  });
  test("usage missing entirely (defaulting to 1 = non-zero) but result empty", () => {
    expect(isEmptyResultSoftFailure({ result: "" })).toBe(true);
  });
});

describe("isEmptyResultSoftFailure — NEGATIVE (regression gate, normal success)", () => {
  test("normal success — result + non-zero tokens", () => {
    expect(isEmptyResultSoftFailure({ result: "Done.", usage: { input_tokens: 100, output_tokens: 5 } })).toBe(false);
  });
  test("short single-char reply still counts as success", () => {
    expect(isEmptyResultSoftFailure({ result: "0", usage: { output_tokens: 1 } })).toBe(false);
  });
  test("usage entirely missing but result non-empty", () => {
    // We default missing output_tokens to 1 (non-zero) — don't penalise
    // a vendor that just doesn't report usage.
    expect(isEmptyResultSoftFailure({ result: "Reply text." })).toBe(false);
  });
});

describe("quotaRemediationHint — vendor URL routing", () => {
  test("intern-ai routing", () => {
    expect(quotaRemediationHint("https://chat.intern-ai.org.cn")).toMatch(/chat\.intern-ai\.org\.cn/);
  });
  test("minimax routing", () => {
    expect(quotaRemediationHint("https://api.minimaxi.com/anthropic")).toMatch(/platform\.minimaxi\.com/);
  });
  test("deepseek routing", () => {
    expect(quotaRemediationHint("https://api.deepseek.com/anthropic")).toMatch(/platform\.deepseek\.com/);
  });
  test("anthropic-native routing", () => {
    expect(quotaRemediationHint("https://api.anthropic.com")).toMatch(/console\.anthropic\.com/);
  });
  test("unknown vendor falls back to generic hint", () => {
    expect(quotaRemediationHint("https://my-private-llm.example.com")).toMatch(/vendor 配额/);
  });
  test("empty / undefined → generic", () => {
    expect(quotaRemediationHint(undefined)).toMatch(/vendor 配额/);
    expect(quotaRemediationHint("")).toMatch(/vendor 配额/);
  });
});
