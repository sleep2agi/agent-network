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
 * 通信牛 #331 round 1 contract — single unified gate:
 *   sanitize / retry ONLY when BOTH conditions hold:
 *     (a) `failed === true`  — SDK threw / `<runtime> 错误:` prefix
 *                              (real failure context, not LLM prose
 *                              discussing error formats).
 *     (b) `matchCount >= 2`  — at least two DISTINCT vendor-envelope
 *                              signals correlate. A single broad term
 *                              ("ZodError", "base_resp") could appear
 *                              in a normal reply; correlation is the
 *                              signature of a real envelope leak.
 *
 * Trade-off accepted: a rare SDK-throw whose error text has only ONE
 * signal slips through un-sanitized; user sees raw `claude 错误:
 * ZodError: ...`. Stricter, but eliminates false-positives on
 * legitimate technical replies (success context with multi-signal
 * prose). Operator can still see raw via stderr.
 *
 * This test imports the SAME `isVendorErrorForUser` production export —
 * no regex duplication. Any change in cli.ts is visible here. Both
 * sanitize and retry gates use a single predicate; no drift between them.
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
//
// The actual Vincent UAT envelope (MiniMax 1000) contains ZodError +
// invalid_union + base_resp(non-zero status_code) + "choices":null — at
// least 4 distinct signals. With failed=true (SDK threw, processWithClaude
// wrapped in `claude 错误:` prefix), this MUST trigger sanitize.

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

// Same shape but failed=false (LLM happened to echo this in a reply — eg.
// "show me what the error looked like"): MUST NOT sanitize. failed-context
// is the load-bearing signal; raw envelope in a successful think() output
// is the LLM faithfully quoting an error format the user asked about.
expect(
  "Vincent UAT shape + failed=false → NOT sanitize (no failure context)",
  !isVendorErrorForUser(VINCENT_UAT_SHAPE, false),
);

// ── 2. 通信牛 #330+#331 counter-examples — single-signal prose ─────────────
// These are the false-positives that the OLD `failed=true + ≥1 signal`
// gate misfired on. Under the new gate, single-signal text in either
// success or failure context passes through untouched.

const NIU_COUNTER_CASES: Array<[string, string]> = [
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
for (const [name, text] of NIU_COUNTER_CASES) {
  // success context, single signal — pass through
  expect(
    `counter (failed=false, single signal) → NOT sanitize: ${name}`,
    !isVendorErrorForUser(text, false),
    `text: ${text.slice(0, 80)}`,
  );
  // failure context, single signal — also pass through under the new
  // gate. The user sees the raw single-signal error line, which is the
  // accepted trade-off vs misfiring on success-context discussion.
  expect(
    `counter (failed=true, single signal) → NOT sanitize: ${name}`,
    !isVendorErrorForUser(text, true),
    `text: ${text.slice(0, 80)}`,
  );
}

// ── 3. Success-context multi-signal — NOT sanitize (no failure context) ──
// The OLD gate's `failed=false + ≥2 signals` branch misfired on legit
// technical replies that happened to discuss multiple error terms (eg.
// my own gate-verify prompt to feishu-local, which mentioned both
// ZodError and base_resp in the same prompt — the bot's faithful echo
// was sanitized in preview.8 prod). Under the new gate, success context
// never sanitizes regardless of signal count.

const SUCCESS_MULTI_SIGNAL_CASES: Array<[string, string]> = [
  [
    "ZodError + invalid_union prose",
    'ZodError 抛 invalid_union 时，看 union 分支的 issues 数组',
  ],
  [
    "base_resp + choices:null in docs prose",
    'MiniMax 的 base_resp:{status_code:1} 表示失败；如果 choices:null 通常说明 vendor 拒绝了请求',
  ],
  [
    "unknown error + choices:null docs",
    'unknown error, 999 是 vendor 内部异常；伴随 "choices":null 时可重试',
  ],
  [
    'OpenAI envelope + "choices":null example',
    '示例：{"error":{"message":"bad","type":"x"}} 会让 "choices":null',
  ],
];
for (const [name, text] of SUCCESS_MULTI_SIGNAL_CASES) {
  expect(
    `success-context multi-signal → NOT sanitize: ${name}`,
    !isVendorErrorForUser(text, false),
    text,
  );
}

// ── 4. Failure-context multi-signal — sanitize ───────────────────────────
// The ONLY combination that triggers sanitize: `failed=true + matchCount ≥ 2`.

const FAILED_MULTI_SIGNAL_CASES: Array<[string, string]> = [
  [
    "ZodError + invalid_union after SDK throw",
    'claude 错误: ZodError: [{"code":"invalid_union","path":["choices"]}]',
  ],
  [
    "base_resp + choices:null after SDK throw",
    'claude 错误: vendor returned {"base_resp":{"status_code":1000},"choices":null}',
  ],
  [
    "unknown error + ZodError after SDK throw",
    'agent-node 错误: ZodError on response; vendor said unknown error, 999',
  ],
  [
    "OpenAI envelope + choices:null after SDK throw",
    'claude 错误: {"error":{"message":"bad","type":"x"}} → "choices":null',
  ],
];
for (const [name, text] of FAILED_MULTI_SIGNAL_CASES) {
  expect(
    `failure-context multi-signal → sanitize: ${name}`,
    isVendorErrorForUser(text, true),
    text,
  );
  // Sanity: same text WITHOUT failure context → NOT sanitize.
  expect(
    `same text without failure context → NOT sanitize: ${name}`,
    !isVendorErrorForUser(text, false),
    text,
  );
}

// ── 5. Single-signal + failed=true — NOT sanitize (new contract) ─────────
// These were locked in the OLD #330 test as "sanitize=true". Under #331
// the gate is stricter; user sees raw line in this rare case, operator
// has stderr trace. Accepted trade-off.

const SINGLE_SIGNAL_FAILED_CASES: Array<[string, string]> = [
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
for (const [name, text] of SINGLE_SIGNAL_FAILED_CASES) {
  expect(
    `single-signal + failed=true → NOT sanitize (new contract): ${name}`,
    !isVendorErrorForUser(text, true),
    text,
  );
}

// ── 6. Zero signals — never sanitize ──────────────────────────────────────

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
  expect(`zero signals + failed=true: ${name}`, !isVendorErrorForUser(text, true), text);
}

// ── 7. Defensive — bad input ──────────────────────────────────────────────

expect("null text", !isVendorErrorForUser(null as any, true));
expect("undefined text", !isVendorErrorForUser(undefined as any, true));
expect("non-string", !isVendorErrorForUser(42 as any, true));

// ── 8. Sanitization replacement text (regression-locked) ──────────────────

const REPLACE = VENDOR_ERROR_REPLACEMENT;
expect("replacement starts with [模型暂时异常]", REPLACE.startsWith("[模型暂时异常]"));
expect("replacement does NOT contain ZodError", !REPLACE.includes("ZodError"));
expect("replacement does NOT contain base_resp", !REPLACE.includes("base_resp"));
expect("replacement does NOT contain status_code", !REPLACE.includes("status_code"));
expect("replacement is Chinese-readable", REPLACE.includes("请稍后重发"));

// ── 9. isTransientVendorError — retry gate uses SAME base predicate ──────
// `isTransientVendorError` MUST be a strict subset of `isVendorErrorForUser`:
// retry only when (a) the predicate fires AND (b) the error isn't auth /
// quota / 429. No second judgement of its own.

// Multi-signal + failed=true + no auth-class signal → transient
const TRANSIENT_CASES: Array<[string, string, boolean]> = [
  [
    "MiniMax 1000 envelope (Vincent UAT real shape)",
    'claude 错误: ZodError [{"code":"invalid_union"}] vendor returned {"base_resp":{"status_code":1000},"choices":null}',
    true,
  ],
  [
    "ZodError + invalid_union after SDK throw",
    'claude 错误: ZodError: [{"code":"invalid_union","path":["choices"]}]',
    true,
  ],
  [
    "base_resp + choices:null after SDK throw",
    'agent-node 错误: vendor returned {"base_resp":{"status_code":1001},"choices":null}',
    true,
  ],
  [
    "unknown error + ZodError after SDK throw",
    'claude 错误: ZodError on response; vendor said unknown error, 999',
    true,
  ],
];
for (const [name, text, failed] of TRANSIENT_CASES) {
  expect(
    `transient (failure-context multi-signal, no auth): ${name}`,
    isTransientVendorError(text, failed),
    `text: ${text.slice(0, 80)}`,
  );
}

// NON-transient — auth/quota/rate-limit. These DO trigger sanitize (via
// isVendorErrorForUser, since multi-signal + failed=true) but should NOT retry.
const NON_TRANSIENT_CASES: Array<[string, string, boolean]> = [
  ['401 unauthorized + zod + choices:null', 'claude 错误: ZodError invalid_union "choices":null 401 unauthorized', true],
  ['403 forbidden + base_resp + choices:null', 'claude 错误: 403 forbidden {"base_resp":{"status_code":1}} "choices":null', true],
  ['quota exceeded + zod multi-signal', 'claude 错误: ZodError invalid_union "choices":null insufficient_quota', true],
  ['rate limit 429 multi-signal', 'claude 错误: ZodError invalid_union "choices":null too many requests 429', true],
  ['rate_limit prose multi-signal', 'agent-node 错误: ZodError invalid_union "choices":null rate limit hit', true],
];
for (const [name, text, failed] of NON_TRANSIENT_CASES) {
  expect(
    `non-transient (sanitize but no retry): ${name}`,
    !isTransientVendorError(text, failed),
    `expected !transient. text: ${text.slice(0, 80)}`,
  );
  // Sanity: these still hit the sanitize predicate (multi-signal + failure context).
  expect(
    `non-transient still triggers sanitize: ${name}`,
    isVendorErrorForUser(text, failed),
    `text: ${text.slice(0, 80)}`,
  );
}

// Single-signal + failed=true → NOT vendor error → NOT transient (new contract)
const SINGLE_FAILED_NOT_TRANSIENT: Array<[string, string]> = [
  ["only ZodError after SDK throw", "claude 错误: ZodError: cannot parse response"],
  ["only unknown error after SDK throw", "claude 错误: unknown error, 200"],
];
for (const [name, text] of SINGLE_FAILED_NOT_TRANSIENT) {
  expect(
    `single-signal + failed=true → NOT transient (slips through, no retry): ${name}`,
    !isTransientVendorError(text, true),
    text,
  );
}

// Success context — never transient
for (const [name, text] of NIU_COUNTER_CASES) {
  expect(
    `counter (failed=false, single signal) → NOT transient: ${name}`,
    !isTransientVendorError(text, false),
    text,
  );
}
for (const [name, text] of SUCCESS_MULTI_SIGNAL_CASES) {
  expect(
    `success-context multi-signal → NOT transient: ${name}`,
    !isTransientVendorError(text, false),
    text,
  );
}

// Plain text — not transient
expect("plain text not transient", !isTransientVendorError("你好世界", false));
expect("empty not transient", !isTransientVendorError("", true));

// ── 10. VENDOR_RETRY_PROFILE shape lock ────────────────────────────────────

expect(
  "VENDOR_RETRY_PROFILE.maxRetries >= 1",
  typeof VENDOR_RETRY_PROFILE.maxRetries === "number" && VENDOR_RETRY_PROFILE.maxRetries >= 1,
);
expect(
  "VENDOR_RETRY_PROFILE.maxRetries <= 5 (runaway retry guard)",
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

// ── 11. Gate symmetry — both helpers share base predicate ─────────────────
// Every text where isTransientVendorError(t, f) === true MUST also have
// isVendorErrorForUser(t, f) === true. (Retry without sanitize would mean
// retry on text that gets through unchanged.) Negative direction is allowed:
// auth/quota/429 sanitize-but-don't-retry.

const SYMMETRY_PROBES: Array<[string, boolean]> = [
  [VINCENT_UAT_SHAPE, true],
  ['claude 错误: ZodError: [{"code":"invalid_union"}] "choices":null', true],
  ['claude 错误: ZodError: [{"code":"invalid_union"}] "choices":null 401', true],
  [VINCENT_UAT_SHAPE, false],
  ["你好世界", true],
  ["", false],
  ["only ZodError", true],
];
for (const [t, f] of SYMMETRY_PROBES) {
  if (isTransientVendorError(t, f)) {
    expect(
      `symmetry: transient ⊆ sanitize for: ${t.slice(0, 40)}|failed=${f}`,
      isVendorErrorForUser(t, f),
    );
  }
}

// ── Summary (gates exit — MUST be last) ────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} vendor-error-sanitize tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
