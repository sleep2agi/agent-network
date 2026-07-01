/**
 * RFC-020 §20 — vendor quota error pass-through tests.
 *
 * Vincent 2026-07-01: MiniMax platform hit `已达到 Token Plan 用量上限
 * (2056)` HTTP 429. bot's error surfaced as generic `执行出错: ...
 * 限流/配额耗尽 (<truncated raw>) — → 检查 platform.X.com 配额` — the
 * vendor's actual wording buried in a `.slice(0, 80)`. Users read it as
 * a bot bug rather than a billing signal.
 *
 * This PR promotes vendor-native phrases + codes into the user-facing
 * error string so operators can match against vendor dashboards
 * without hunting the raw message.
 *
 * Also covers soft-fail-empty: since Vincent's session PAT + MiniMax
 * content filter triggered `out>0 result=""`, the message needs to
 * hint at the outbound-mask log correlation (content filter is a
 * common cause we now defend against upstream).
 *
 * Run: `bun tests/quota-error-passthrough.test.ts`
 */

import {
  extractQuotaCode,
  extractVendorQuotaPhrase,
  isRateLimitOrQuotaError,
} from "../src/runtime/claude-error-classify";
import { formatClassificationError } from "../src/runtime/classify-result";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── 1. extractQuotaCode — MiniMax 2056 (Vincent's exact case) ─────────────

expect(
  "MiniMax 2056 code extracted",
  extractQuotaCode("已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量 (2056)") ===
    "MiniMax code 2056",
);
expect(
  "MiniMax 2056 alone",
  extractQuotaCode("error 2056") === "MiniMax code 2056",
);

// ── 2. extractQuotaCode — OpenAI-compat error types ───────────────────────

expect(
  "insufficient_quota extracted",
  extractQuotaCode("error: insufficient_quota") === "insufficient_quota",
);
expect(
  "rate_limit_exceeded extracted",
  extractQuotaCode("code: rate_limit_exceeded, status 429") === "rate_limit_exceeded",
);
expect(
  "billing_hard_limit_reached",
  extractQuotaCode('{"code":"billing_hard_limit_reached"}') === "billing_hard_limit_reached",
);

// ── 3. extractQuotaCode — Anthropic HTTP status shorthand ────────────────

expect("HTTP 429 extracted", extractQuotaCode("HTTP 429 from vendor") === "HTTP 429");
expect("HTTP 529 extracted", extractQuotaCode("Got 529 from API") === "HTTP 529");

// ── 4. extractQuotaCode — defensive ───────────────────────────────────────

expect("null: null", extractQuotaCode(null) === null);
expect("undefined: null", extractQuotaCode(undefined) === null);
expect("empty: null", extractQuotaCode("") === null);
expect("non-string: null", extractQuotaCode(42 as any) === null);
expect("no known code: null", extractQuotaCode("some random error text") === null);

// ── 5. extractVendorQuotaPhrase — MiniMax Chinese phrase ─────────────────

expect(
  "MiniMax phrase extracted verbatim",
  extractVendorQuotaPhrase(
    "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量 (2056)",
  ) ===
    "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量 (2056)",
);

// Truncates at 200 chars.
{
  const long = "已达到 Token Plan 用量上限：" + "详细描述".repeat(100);
  const out = extractVendorQuotaPhrase(long);
  expect("phrase truncated at 200 chars", (out?.length || 0) <= 200);
}

// Only extracts if `已达到` present.
expect(
  "no 已达到: falls back to English pattern or null",
  extractVendorQuotaPhrase("normal error text") === null,
);

// ── 6. extractVendorQuotaPhrase — OpenAI phrase ──────────────────────────

expect(
  "insufficient_quota phrase",
  (extractVendorQuotaPhrase('error "code": "insufficient_quota"') || "").includes("insufficient_quota"),
);
expect(
  "quota exceeded phrase",
  (extractVendorQuotaPhrase("quota exceeded for the day") || "").includes("exceeded"),
);

// ── 7. formatClassificationError — soft-fail-quota with MiniMax phrase ──

{
  const s = formatClassificationError(
    {
      kind: "soft-fail-quota",
      reason: "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量 (2056)",
      hint: "→ 检查 platform.minimaxi.com 配额/Token Plan 上限/降并发",
    },
    { runtime: "claude-agent-sdk" },
  );
  expect(
    "soft-fail-quota: [额度用尽] prefix",
    s.startsWith("执行出错: [额度用尽]"),
    s,
  );
  expect(
    "soft-fail-quota: MiniMax code tag present",
    s.includes("[MiniMax code 2056]"),
    s,
  );
  expect(
    "soft-fail-quota: vendor phrase passed through (not truncated 80)",
    s.includes("已达到 Token Plan 用量上限"),
    s,
  );
  expect(
    "soft-fail-quota: hint appended",
    s.includes("platform.minimaxi.com"),
    s,
  );
  expect(
    "soft-fail-quota: NOT the old generic 'vendor 限流' text",
    !s.includes("限流/配额耗尽"),
    s,
  );
}

// ── 8. formatClassificationError — soft-fail-quota with OpenAI 429 ───────

{
  const s = formatClassificationError(
    {
      kind: "soft-fail-quota",
      reason: '{"error":{"code":"insufficient_quota","status":"HTTP 429"}}',
      hint: "→ 检查 platform.openai.com 配额",
    },
    { runtime: "codex" },
  );
  expect(
    "OpenAI: code tag present (insufficient_quota takes precedence)",
    s.includes("[insufficient_quota]"),
    s,
  );
  expect("OpenAI: still [额度用尽]", s.includes("[额度用尽]"));
  expect("OpenAI: runtime label", s.includes("codex:"), s);
}

// ── 9. formatClassificationError — soft-fail-quota fallback (no phrase) ──

{
  // Reason has NO extractable phrase or code — falls back to raw truncated.
  const s = formatClassificationError(
    { kind: "soft-fail-quota", reason: "vendor 忙 请稍后重试", hint: "→ 稍等 5min" },
    { runtime: "claude-agent-sdk" },
  );
  expect("fallback: uses raw truncated reason", s.includes("vendor 忙 请稍后重试"), s);
  expect("fallback: no [code] tag (no code found)", !s.includes("[code"), s);
  expect("fallback: still [额度用尽] prefix", s.startsWith("执行出错: [额度用尽]"));
}

// ── 10. formatClassificationError — soft-fail-empty (Vincent PAT case) ──

{
  const s = formatClassificationError(
    {
      kind: "soft-fail-empty",
      reason: "empty vendor result despite success signal",
      hint: "→ 检查 platform.minimaxi.com 配额",
    },
    { runtime: "claude-agent-sdk", usage: { input_tokens: 63853, output_tokens: 90 } },
  );
  expect("soft-fail-empty: token counts present", s.includes("in=63853") && s.includes("out=90"), s);
  expect(
    "soft-fail-empty: hint at outbound-mask log (content filter)",
    s.includes("[outbound-mask]") && s.includes("credential"),
    s,
  );
  expect(
    "soft-fail-empty: hint at quota (dashboard)",
    s.includes("配额") || s.includes("dashboard"),
    s,
  );
  expect(
    "soft-fail-empty: hint at reasoning/thinking",
    s.includes("reasoning") || s.includes("thinking") || s.includes("max_tokens"),
    s,
  );
  expect(
    "soft-fail-empty: NOT old '疑似 vendor 静默限流' generic",
    !s.includes("疑似 vendor 静默限流"),
    s,
  );
}

// ── 11. formatClassificationError — soft-fail-empty defensive ────────────

{
  const s = formatClassificationError(
    { kind: "soft-fail-empty", reason: "x", hint: "" },
    { runtime: "claude-agent-sdk" }, // no usage
  );
  expect("no usage: in=0 out=0 default", s.includes("in=0") && s.includes("out=0"));
  expect("no hint: still surfaces the three causes", s.includes("(a)") && s.includes("(b)") && s.includes("(c)"));
}

// ── 12. formatClassificationError — error / success paths unchanged ─────

expect(
  "error path unchanged",
  formatClassificationError(
    { kind: "error", reason: "some fatal error" },
    { runtime: "claude-agent-sdk" },
  ) === "执行出错: claude-agent-sdk — some fatal error",
);
expect(
  "success returns empty string",
  formatClassificationError({ kind: "success" }, { runtime: "claude-agent-sdk" }) === "",
);

// ── 13. isRateLimitOrQuotaError — verify Token Plan pattern already works ─

// Regression lock — this pattern was added in a prior PR; verify.
expect(
  "isRateLimitOrQuotaError catches Token Plan 上限",
  isRateLimitOrQuotaError("已达到 Token Plan 用量上限"),
);
expect(
  "isRateLimitOrQuotaError catches Token Plan exceeded",
  isRateLimitOrQuotaError("Token Plan exceeded"),
);

// ── 14. Real-world raw error shapes — golden coverage ──────────────────

const VENDOR_RAW_SHAPES: Array<{
  name: string;
  raw: string;
  expectCode: string | null;
  expectPhraseSubstr: string | null;
}> = [
  {
    name: "MiniMax exact prod message (Vincent 2026-07-01)",
    raw: "已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量 (2056)",
    expectCode: "MiniMax code 2056",
    expectPhraseSubstr: "已达到 Token Plan",
  },
  {
    // Anthropic's error envelope doesn't include the HTTP status code
    // inside the JSON body — status is on the HTTP response layer. Only
    // when the caller re-stringifies with "HTTP 429" prefix does the
    // extractor pick up a code. Baseline case: no literal 429 → null,
    // but isRateLimitOrQuotaError still catches via `rate_limit`.
    name: "Anthropic 429 JSON envelope (no HTTP code in body)",
    raw: '{"type":"error","error":{"type":"rate_limit_error","message":"Number of requests has exceeded your rate limit"}}',
    expectCode: null,
    expectPhraseSubstr: "exceeded",
  },
  {
    name: "OpenAI insufficient_quota",
    raw: '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}',
    expectCode: "insufficient_quota",
    expectPhraseSubstr: "exceeded",
  },
  {
    name: "Generic 429",
    raw: "HTTP 429 Too Many Requests",
    expectCode: "HTTP 429",
    expectPhraseSubstr: null,
  },
];

for (const s of VENDOR_RAW_SHAPES) {
  const code = extractQuotaCode(s.raw);
  const phrase = extractVendorQuotaPhrase(s.raw);
  if (s.expectCode !== null) {
    expect(
      `${s.name}: code extracted (want ${s.expectCode}, got ${code})`,
      code === s.expectCode,
    );
  } else {
    expect(`${s.name}: no code extracted (ok)`, code === null || code === "HTTP 429");
  }
  if (s.expectPhraseSubstr) {
    expect(
      `${s.name}: phrase contains "${s.expectPhraseSubstr}"`,
      (phrase || "").includes(s.expectPhraseSubstr),
      phrase ?? "null",
    );
  }
}

// The Anthropic JSON envelope case — no 429 literal in the JSON body,
// so code extraction correctly returns null. Verify.
{
  const raw = '{"type":"error","error":{"type":"rate_limit_error"}}';
  expect(
    "Anthropic JSON without 429: null code (correct — extraction is literal)",
    extractQuotaCode(raw) === null,
  );
  // But isRateLimitOrQuotaError catches it via `rate_limit`:
  expect(
    "Anthropic JSON: still classified as rate-limit (via isRateLimitOrQuotaError)",
    isRateLimitOrQuotaError(raw),
  );
}

// ── Summary ────────────────────────────────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} quota-error-passthrough tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
