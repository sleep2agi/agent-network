/**
 * RFC-020 §14 — vendor-error sanitization (cli.ts).
 *
 * Vincent UAT 2026-06-29: MiniMax /anthropic endpoint returned
 * `base_resp:{status_code:1000,"unknown error, 999"}` + `choices:null`;
 * claude-agent-sdk's zod schema rejected with `invalid_union`, raw
 * ZodError JSON + vendor envelope fell through to user-facing Feishu
 * reply. cli.ts now scrubs known vendor-error shapes and replaces with
 * clean Chinese message; raw stays in stderr for operators.
 *
 * 通信牛 #330 round 1 refinement: single-pattern matches like `ZodError`
 * would false-positive on legitimate technical replies discussing error
 * formats. The new `isVendorErrorForUser(text, failed)` predicate combines
 * `failed` context with multi-signal correlation so normal Q&A about
 * Zod / OpenAI errors / base_resp passes through untouched.
 *
 * This test imports the SAME `isVendorErrorForUser` production exports —
 * no regex duplication. Any change in cli.ts is visible here.
 *
 * Run: `bun tests/vendor-error-sanitize.test.ts`
 */

import {
  isVendorErrorForUser,
  isTransientVendorError,
  VENDOR_ERROR_REPLACEMENT,
  VENDOR_RETRY_PROFILE,
} from "../src/vendor-error";

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// ── 1. Vincent UAT real shape — failed=true + multi-signal → sanitize ────

const VINCENT_UAT_SHAPE = `claude 错误: ZodError: [
  {
    "code": "invalid_union",
    "unionErrors": [...],
    "path": ["choices"],
    "message": "Invalid input"
  }
]
Raw vendor response: {"base_resp":{"status_code":1000,"status_msg":"unknown error, 999"},"choices":null,"id":"chatcmpl-xxx","model":"MiniMax-M3"}`;

expect(
  "Vincent UAT shape + failed=true → sanitize",
  isVendorErrorForUser(VINCENT_UAT_SHAPE, true),
);
// Even if `failed` accidentally false, the multi-signal correlation
// still catches it.
expect(
  "Vincent UAT shape + failed=false → still sanitize (multi-signal correlation)",
  isVendorErrorForUser(VINCENT_UAT_SHAPE, false),
);

// ── 2. 通信牛 #330 round 1 counterexamples — MUST NOT sanitize ─────────────

// (a) Plain technical discussion of ZodError term (failed=false, single signal)
const NIU_CASES: Array<[string, string]> = [
  ["ZodError discussion", "ZodError 是 Zod 校验库抛出的异常，常见于 schema mismatch。"],
  ["invalid_union discussion", "如果 union 不匹配，Zod 可能返回 invalid_union。"],
  [
    "error envelope example in docs",
    '示例错误响应：{"error":{"message":"bad request","type":"invalid_request_error"}}',
  ],
  [
    "base_resp explanation in prose",
    '正常讨论 base_resp：{"base_resp":{"status_code":1001}} 表示上游失败',
  ],
];
for (const [name, text] of NIU_CASES) {
  expect(
    `通信牛-counter (failed=false, single signal) NOT sanitized: ${name}`,
    !isVendorErrorForUser(text, false),
    `text: ${text.slice(0, 80)}`,
  );
}

// But if the LLM REALLY threw on these AND we're in failed=true context,
// sanitize is correct (operator-visible raw error wrapped in failure path).
// Pure-prose case is rare enough that failed=true context is itself a
// strong signal.
for (const [name, text] of NIU_CASES) {
  expect(
    `${name} + failed=true → sanitize (SDK threw, single signal OK in failure context)`,
    isVendorErrorForUser(text, true),
  );
}

// ── 3. Multi-signal correlation cases (failed=false but ≥2 signals) ───────

const MULTI_SIGNAL = [
  // ZodError + invalid_union — both common in zod error JSON output
  ['{"name":"ZodError","issues":[{"code":"invalid_union","path":["x"]}]}'],
  // base_resp + choices:null — MiniMax envelope shape
  ['{"base_resp":{"status_code":1000},"choices":null}'],
  // unknown error + choices:null
  ['Got: unknown error, 999 — "choices":null in response'],
  // error envelope + choices:null
  ['{"error":{"message":"bad","type":"x"}} caused "choices":null'],
];
for (const [text] of MULTI_SIGNAL) {
  expect(
    `multi-signal (failed=false, ≥2 signals) → sanitize: ${text.slice(0, 60)}`,
    isVendorErrorForUser(text, false),
    text,
  );
}

// ── 4. Single-signal + failed=true → sanitize (SDK-threw context) ─────────

const SINGLE_FAILED = [
  ["only ZodError after SDK throw", "claude 错误: ZodError: cannot parse response"],
  ["only invalid_union after SDK throw", "agent-node 错误: invalid_union at path .choices"],
  [
    "only base_resp after SDK throw",
    'claude 错误: vendor returned {"base_resp":{"status_code":1}}',
  ],
  [
    'only "choices":null after SDK throw',
    'agent-node 错误: parser failed on "choices":null',
  ],
];
for (const [name, text] of SINGLE_FAILED) {
  expect(
    `failed=true + single signal → sanitize: ${name}`,
    isVendorErrorForUser(text, true),
    text,
  );
}

// ── 5. Zero signals — never sanitize ──────────────────────────────────────

const NO_SIGNAL = [
  ["plain answer", "你好，今天天气很好。"],
  ["normal markdown", "# 标题\n\n这是 **加粗** 段落"],
  ["legit JSON output", '{"result":"success","value":42}'],
  ["base_resp with status 0", '{"base_resp":{"status_code":0,"msg":"ok"}}'],
  ["choices NOT null", '"choices":[{"message":{"content":"ok"}}]'],
  ["empty string", ""],
];
for (const [name, text] of NO_SIGNAL) {
  expect(`zero signals + failed=false: ${name}`, !isVendorErrorForUser(text, false), text);
  // Even failed=true with zero signals doesn't sanitize — leave operator's
  // generic error text alone.
  expect(`zero signals + failed=true: ${name}`, !isVendorErrorForUser(text, true), text);
}

// ── 6. Defensive — bad input ──────────────────────────────────────────────

expect("null text", !isVendorErrorForUser(null as any, true));
expect("undefined text", !isVendorErrorForUser(undefined as any, true));
expect("non-string", !isVendorErrorForUser(42 as any, true));

// ── 7. Sanitization replacement text (imported from production, regression-locked) ──

const REPLACE = VENDOR_ERROR_REPLACEMENT;
expect("replacement starts with [模型暂时异常]", REPLACE.startsWith("[模型暂时异常]"));
expect("replacement does NOT contain ZodError", !REPLACE.includes("ZodError"));
expect("replacement does NOT contain base_resp", !REPLACE.includes("base_resp"));
expect("replacement does NOT contain status_code", !REPLACE.includes("status_code"));
expect("replacement is Chinese-readable", REPLACE.includes("请稍后重发"));

// ── 8. isTransientVendorError — retry-worthy gate (Vincent UAT 2026-06-29) ──

// MiniMax 1000 / unknown error / choices:null — all transient, retry-able
const TRANSIENT_CASES: Array<[string, string, boolean]> = [
  [
    "MiniMax 1000 envelope (Vincent UAT)",
    'claude 错误: ZodError [{"code":"invalid_union"}] vendor returned {"base_resp":{"status_code":1000},"choices":null}',
    true,
  ],
  ["choices:null + ZodError", '{"choices":null,"name":"ZodError"}', false],
  ["base_resp + unknown error", '{"base_resp":{"status_code":1001}} unknown error, 999', false],
  ["just unknown error after SDK throw", "claude 错误: unknown error, 200", true],
];
for (const [name, text, failed] of TRANSIENT_CASES) {
  expect(`transient: ${name}`, isTransientVendorError(text, failed), `text: ${text.slice(0, 80)}`);
}

// NON-transient — auth/quota/rate-limit. These DO trigger sanitize (via
// isVendorErrorForUser) but should NOT retry.
const NON_TRANSIENT_CASES: Array<[string, string, boolean]> = [
  // Multi-signal vendor error WITH 401 token → not retryable
  ['401 unauthorized + zod context', 'ZodError invalid_union "choices":null 401 unauthorized', true],
  ['403 forbidden + base_resp', 'claude 错误: 403 forbidden {"base_resp":{"status_code":1}}', true],
  ['quota exceeded + zod', 'ZodError invalid_union choices:null insufficient_quota', true],
  ['rate limit 429', 'claude 错误: ZodError invalid_union choices:null too many requests 429', true],
  ['rate_limit text', 'ZodError invalid_union "choices":null rate limit hit', true],
];
for (const [name, text, failed] of NON_TRANSIENT_CASES) {
  expect(
    `non-transient (sanitize but no retry): ${name}`,
    !isTransientVendorError(text, failed),
    `expected !transient. text: ${text.slice(0, 80)}`,
  );
  // Sanity: these should still be vendor errors (just non-retryable)
  expect(
    `non-transient cases are still vendor errors: ${name}`,
    isVendorErrorForUser(text, failed),
    `text: ${text.slice(0, 80)}`,
  );
}

// NOT a vendor error at all — should NOT be transient either
for (const [name, text] of NIU_CASES) {
  // failed=false + single signal: NOT vendor error → NOT transient
  expect(
    `NIU counter (failed=false, NOT vendor error, NOT transient): ${name}`,
    !isTransientVendorError(text, false),
    text,
  );
}

// Plain text — not transient
expect("plain text not transient", !isTransientVendorError("你好世界", false));
expect("empty not transient", !isTransientVendorError("", true));

// ── 9. VENDOR_RETRY_PROFILE shape lock ─────────────────────────────────────

expect(
  "VENDOR_RETRY_PROFILE.maxRetries >= 1",
  typeof VENDOR_RETRY_PROFILE.maxRetries === "number" && VENDOR_RETRY_PROFILE.maxRetries >= 1,
);
expect(
  "VENDOR_RETRY_PROFILE.maxRetries <= 5 (sanity — runaway retry guard)",
  VENDOR_RETRY_PROFILE.maxRetries <= 5,
);
expect(
  "VENDOR_RETRY_PROFILE.backoffMs is array",
  Array.isArray(VENDOR_RETRY_PROFILE.backoffMs) && VENDOR_RETRY_PROFILE.backoffMs.length >= 1,
);
expect(
  "VENDOR_RETRY_PROFILE.backoffMs values are positive ms",
  VENDOR_RETRY_PROFILE.backoffMs.every((n) => typeof n === "number" && n > 0 && n <= 30_000),
);
expect(
  "VENDOR_RETRY_PROFILE backoff total wall-clock ≤ 30s",
  VENDOR_RETRY_PROFILE.backoffMs.reduce((a, b) => a + b, 0) <= 30_000,
);

// ── Summary (gates exit — MUST be last) ────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} vendor-error-sanitize tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
