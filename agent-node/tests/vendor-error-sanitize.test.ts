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

import { isVendorErrorForUser, VENDOR_ERROR_REPLACEMENT } from "../src/vendor-error";

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

// ── Summary (gates exit — MUST be last) ────────────────────────────────────

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} vendor-error-sanitize tests passed.`);
if (failed.length > 0) {
  console.log("\nfailures:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
  process.exit(1);
}
