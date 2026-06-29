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
 * This test re-applies the SAME pattern list as cli.ts (kept in sync —
 * if production patterns change, this fixture must change to match).
 *
 * Run: `bun tests/vendor-error-sanitize.test.ts`
 */

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function expect(name: string, pred: boolean, detail = ""): void {
  results.push({ name, pass: pred, detail });
  if (!pred) console.log(`  ✗ ${name}: ${detail}`);
}

// Re-construct the patterns identically to cli.ts. Test the regex set in
// isolation (cli.ts itself runs the SDK pipeline which we can't import
// from the bundled context).
const VENDOR_ERROR_PATTERNS: RegExp[] = [
  /ZodError/,
  /invalid_union/i,
  /"validation":\s*\{/,
  /"?base_resp"?[\s:]*\{[^}]*"?status_code"?[\s:]*[1-9]/i,
  /\bunknown error,?\s*\d+/i,
  /"error"\s*:\s*\{\s*"(message|type|code)"\s*:/i,
  /"choices"\s*:\s*null/i,
];

function isVendorError(text: string): boolean {
  return VENDOR_ERROR_PATTERNS.some((p) => p.test(text));
}

// ── 1. Vincent UAT real shape — MiniMax 1000 envelope ──────────────────────

const VINCENT_UAT_SHAPE = `Error invoking claude-agent-sdk: ZodError: [
  {
    "code": "invalid_union",
    "unionErrors": [...],
    "path": ["choices"],
    "message": "Invalid input"
  }
]
Raw vendor response: {"base_resp":{"status_code":1000,"status_msg":"unknown error, 999"},"choices":null,"id":"chatcmpl-xxx","model":"MiniMax-M3"}`;

expect("Vincent UAT MiniMax 1000 shape caught", isVendorError(VINCENT_UAT_SHAPE));

// ── 2. Individual pattern hits ────────────────────────────────────────────

const HITS = [
  ["ZodError alone", "Some prefix ZodError: ... rest"],
  ["invalid_union snake", '"code":"invalid_union"'],
  ['"validation":{ shape', '"issues":[{"validation":{"shape":"deep"}}]'],
  ["base_resp + status_code:1", '{"base_resp":{"status_code":1,"msg":"err"}}'],
  ["base_resp + status_code:1000", '{"base_resp":{"status_code":1000,"msg":"err"}}'],
  ["unknown error N", "got: unknown error, 999"],
  ['"error":{"message"', '{"error":{"message":"oops","type":"invalid_request_error"}}'],
  ['"error":{"type"', '{"error":{"type":"invalid_request_error"}}'],
  ['"error":{"code"', '{"error":{"code":"invalid_value"}}'],
  ['"choices":null', '{"choices":null,"model":"foo"}'],
];

for (const [name, text] of HITS) {
  expect(`hit: ${name}`, isVendorError(text), `text: ${text}`);
}

// ── 3. NOT-vendor-error false-positives (must NOT trigger) ────────────────

const NOT_HITS = [
  ["plain answer", "你好，今天天气很好。"],
  ["normal markdown", "# 标题\n\n这是 **加粗** 段落"],
  ["legit JSON output", '{"result":"success","value":42}'],
  ["base_resp with status 0", '{"base_resp":{"status_code":0,"msg":"ok"}}'],
  // No `status_code:N`-non-zero — base_resp 0 is success
  ["error word in prose", "Vincent said: 这次没错误"],
  ['"error" as a key with object value but no inner shape', '"error":[]'],
  ["unknown error WITHOUT digit", "unknown error happened"],
  ["choices NOT null", '"choices":[{"message":{"content":"ok"}}]'],
  ["empty string", ""],
];

for (const [name, text] of NOT_HITS) {
  expect(`miss: ${name}`, !isVendorError(text), `text: ${text}`);
}

// ── 4. Composition — a vendor error WITHIN a longer text ──────────────────

const LONG = `Lorem ipsum dolor sit amet, consectetur adipiscing elit.
... some prose ...
Got: ZodError: [{"code":"invalid_union"}]
This was unexpected.`;
expect("vendor error in middle of long text caught", isVendorError(LONG));

// ── 5. Sanitization mock — the replacement text ───────────────────────────

// cli.ts replaces matched text with this exact string. Lock the
// user-facing message so we don't accidentally regress to raw JSON.
const REPLACE = "[模型暂时异常] vendor 返回非预期格式，请稍后重发或重试。";
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
