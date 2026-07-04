// Cross-runtime classifier coverage. The two underlying detectors
// (`isRateLimitOrQuotaError` + `isEmptyResultSoftFailure`) ship with
// 32 unit tests in claude-error-classify.test.ts already — these tests
// focus on the *combination*: precedence between the kinds, the
// in=0 & out=0 & cost=0 silent-reject rule, the formatClassificationError
// shape that the IM bridge / dashboard parse.

import { describe, expect, test } from "bun:test";
import {
  classifyRuntimeResult,
  formatClassificationError,
  type ClassificationResult,
} from "./classify-result";

describe("classifyRuntimeResult — error precedence", () => {
  test("quota error msg → soft-fail-quota (highest precedence)", () => {
    const r = classifyRuntimeResult({ errorMessage: "HTTP 429 rate_limit", result: "" });
    expect(r.kind).toBe("soft-fail-quota");
    expect(r.reason).toContain("429");
  });

  test("non-quota error → hard error", () => {
    const r = classifyRuntimeResult({ errorMessage: "ECONNREFUSED" });
    expect(r.kind).toBe("error");
    expect(r.reason).toBe("ECONNREFUSED");
  });

  test("auth error msg (401) → hard error (NOT quota — auth has its own path)", () => {
    const r = classifyRuntimeResult({ errorMessage: "401 invalid_api_key" });
    expect(r.kind).toBe("error");
  });

  test("error msg outranks empty result (don't double-classify)", () => {
    const r = classifyRuntimeResult({ errorMessage: "boom", result: "" });
    expect(r.kind).toBe("error");
  });
});

describe("classifyRuntimeResult — in=0 & out=0 & cost=0 silent reject", () => {
  test("all three zero → soft-fail-empty (even when result text present)", () => {
    const r = classifyRuntimeResult({
      result: "stale text from previous turn",
      usage: { input_tokens: 0, output_tokens: 0 },
      totalCostUsd: 0,
    });
    expect(r.kind).toBe("soft-fail-empty");
    expect(r.reason).toContain("in=0 out=0 cost=0");
  });

  test("in=0 & out=0 but cost field MISSING + non-empty result → success (codex usage unreliable)", () => {
    // Per the strict-rule refactor: cost-field-missing should NOT
    // promote a non-empty result to soft-fail. Codex sometimes reports
    // zero output_tokens for healthy turns; previously the OR-rule
    // false-flagged these. The three-zero rule still catches the real
    // silent-reject shape because the M3 episode reports all three.
    const r = classifyRuntimeResult({
      result: "some text",
      usage: { input_tokens: 0, output_tokens: 0 },
    });
    expect(r.kind).toBe("success");
  });

  test("in=0 & cost=0 but out>0 → NOT silent reject (vendor returned something)", () => {
    const r = classifyRuntimeResult({
      result: "real reply",
      usage: { input_tokens: 0, output_tokens: 50 },
      totalCostUsd: 0,
    });
    expect(r.kind).toBe("success");
  });

  test("normal turn (all signals positive) → success", () => {
    const r = classifyRuntimeResult({
      result: "Done.",
      usage: { input_tokens: 100, output_tokens: 50 },
      totalCostUsd: 0.0042,
    });
    expect(r.kind).toBe("success");
  });

  test("non-empty result + output_tokens=0 + cost missing → success (codex false-positive guard)", () => {
    // Direct regression test for the 通信牛 CHANGE_REQ on classify
    // three-zero: a codex turn that returned text but didn't report
    // output token usage must NOT be flagged as soft-fail-empty.
    const r = classifyRuntimeResult({
      result: "Reply from codex",
      usage: { input_tokens: 50, output_tokens: 0 },
    });
    expect(r.kind).toBe("success");
  });
});

describe("classifyRuntimeResult — empty-result rule (strict)", () => {
  test("empty string result + non-zero tokens → soft-fail-empty", () => {
    const r = classifyRuntimeResult({
      result: "",
      usage: { input_tokens: 100, output_tokens: 5 },
    });
    expect(r.kind).toBe("soft-fail-empty");
  });

  test("null result + non-zero tokens → soft-fail-empty", () => {
    const r = classifyRuntimeResult({
      result: null,
      usage: { input_tokens: 100, output_tokens: 5 },
    });
    expect(r.kind).toBe("soft-fail-empty");
  });

  test("undefined result, missing usage → soft-fail-empty (empty result alone is enough)", () => {
    const r = classifyRuntimeResult({});
    expect(r.kind).toBe("soft-fail-empty");
  });

  test("single-char '0' result + tokens → success (not empty)", () => {
    const r = classifyRuntimeResult({
      result: "0",
      usage: { input_tokens: 10, output_tokens: 1 },
    });
    expect(r.kind).toBe("success");
  });

  test("result text present + missing usage → success (don't penalise unreported usage)", () => {
    const r = classifyRuntimeResult({ result: "Reply." });
    expect(r.kind).toBe("success");
  });

  test("empty string result + cost present + tokens → soft-fail-empty (text emptiness is the signal)", () => {
    const r = classifyRuntimeResult({
      result: "",
      usage: { input_tokens: 100, output_tokens: 5 },
      totalCostUsd: 0.001,
    });
    expect(r.kind).toBe("soft-fail-empty");
  });
});

describe("classifyRuntimeResult — vendor hint routing via baseUrl", () => {
  test("quota error with deepseek baseUrl → deepseek dashboard hint", () => {
    const r = classifyRuntimeResult(
      { errorMessage: "rate_limit hit" },
      { baseUrl: "https://api.deepseek.com/anthropic" },
    );
    expect(r.hint).toContain("deepseek");
  });

  test("quota error with intern baseUrl → intern hint", () => {
    const r = classifyRuntimeResult(
      { errorMessage: "Token Plan 上限 reached" },
      { baseUrl: "https://chat.intern-ai.org.cn" },
    );
    expect(r.hint).toContain("intern-ai");
  });

  test("empty result with anthropic baseUrl → anthropic hint", () => {
    const r = classifyRuntimeResult(
      { result: "", usage: { output_tokens: 0 } },
      { baseUrl: "https://api.anthropic.com" },
    );
    expect(r.hint).toContain("anthropic");
  });

  test("missing baseUrl → generic hint", () => {
    const r = classifyRuntimeResult({ errorMessage: "429" });
    expect(r.hint).toContain("vendor");
  });
});

describe("formatClassificationError — message shape (parsed by IM bridge)", () => {
  test("soft-fail-quota → 执行出错: [额度用尽][<code>] <runtime>: <body> — <hint>", () => {
    // #368 replaced the generic `<runtime> 限流/配额耗尽 (<reason>)` copy
    // with a vendor-phrase-pass-through format prefixed by `[额度用尽]` +
    // an optional vendor-native code tag (MiniMax 2056 / HTTP 429 / etc.).
    // This test locks the new format shape — the runtime label, the
    // vendor URL hint, and the [额度用尽] prefix must all be present.
    const c: ClassificationResult = {
      kind: "soft-fail-quota",
      reason: "HTTP 429",
      hint: "→ 检查 platform.deepseek.com 配额",
    };
    const s = formatClassificationError(c, { runtime: "codex" });
    expect(s).toMatch(/^执行出错: \[额度用尽\]/);
    expect(s).toContain("codex");
    expect(s).toContain("deepseek");
    // Code extractor recognises "HTTP 429" — tag should be present.
    expect(s).toContain("[HTTP 429]");
  });

  test("soft-fail-empty → 执行出错: <runtime> 返回空响应 with in/out", () => {
    const c: ClassificationResult = {
      kind: "soft-fail-empty",
      reason: "empty",
      hint: "→ 检查 vendor 配额",
    };
    const s = formatClassificationError(c, { runtime: "grok", usage: { input_tokens: 99, output_tokens: 0 } });
    expect(s).toContain("grok 返回空响应");
    expect(s).toContain("in=99 out=0");
  });

  test("error kind → 执行出错: <runtime> — <reason>", () => {
    const c: ClassificationResult = { kind: "error", reason: "ECONNREFUSED" };
    const s = formatClassificationError(c, { runtime: "claude" });
    expect(s).toBe("执行出错: claude — ECONNREFUSED");
  });

  test("success kind → empty string (caller should not call this; defensive)", () => {
    const c: ClassificationResult = { kind: "success" };
    const s = formatClassificationError(c, { runtime: "claude" });
    expect(s).toBe("");
  });

  test("missing usage in context → in=0 out=0 fallback", () => {
    const c: ClassificationResult = { kind: "soft-fail-empty" };
    const s = formatClassificationError(c, { runtime: "claude" });
    expect(s).toContain("in=0 out=0");
  });

  test("missing hint on quota → no trailing dash artifact", () => {
    const c: ClassificationResult = { kind: "soft-fail-quota", reason: "429" };
    const s = formatClassificationError(c, { runtime: "claude" });
    expect(s).not.toMatch(/—\s*$/);
  });

  test("reason longer than 80 chars is truncated on quota path", () => {
    const longReason = "x".repeat(200);
    const c: ClassificationResult = { kind: "soft-fail-quota", reason: longReason };
    const s = formatClassificationError(c, { runtime: "claude" });
    // 80-char slice + closing paren + remaining template chars
    expect(s.length).toBeLessThan(200);
  });
});
