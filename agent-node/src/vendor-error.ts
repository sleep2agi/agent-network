/**
 * Vendor-error sanitization (RFC-020 §14, Vincent 2026-06-29 UAT).
 *
 * When a downstream vendor (MiniMax /anthropic, OpenAI, etc.) returns
 * a non-Anthropic shape or claude-agent-sdk's zod validator rejects it,
 * the raw JSON / ZodError text previously fell through to user-facing
 * IM replies — Vincent saw the SDK error envelope in his Feishu chat.
 *
 * This module owns the predicate that decides whether to replace such
 * text with a clean user-visible message. Extracted to its own file
 * (vs inlined in cli.ts) so unit tests can import it directly without
 * triggering cli.ts's top-level network side-effects (commhub mcp init).
 *
 * The decision combines:
 *   (a) `failed === true` (SDK threw / `<runtime> 错误:` prefix) AND
 *       at least one vendor-envelope signal — typical SDK-throws path;
 *   OR
 *   (b) `failed === false` AND at least TWO independent vendor-envelope
 *       signals — generic terms (e.g. `ZodError` as a noun) on their
 *       own are not enough; we need correlated signals.
 *
 * Counterexamples that MUST NOT trigger (single signal, failed=false):
 *   - "ZodError 是 Zod 校验库抛出的异常，常见于 schema mismatch。"
 *   - "如果 union 不匹配，Zod 可能返回 invalid_union。"
 *   - `示例错误响应：{"error":{"message":"bad request",...}}`
 *   - `正常讨论 base_resp：{"base_resp":{"status_code":1001}} 表示上游失败`
 *
 * Real Vincent UAT vendor 1000 envelope (multiple signals, MUST trigger):
 *   `claude 错误: ZodError [{"code":"invalid_union",...}]
 *    base_resp:{status_code:1000} "choices":null`
 */

/**
 * Vendor-error shapes whose raw bytes are signals. Each pattern is
 * tolerant on JSON separators / case where appropriate. Used by
 * `isVendorErrorForUser` to count correlated signals.
 */
export const VENDOR_ERROR_PATTERNS: RegExp[] = [
  // claude-agent-sdk zod schema failure shape (the SDK throws / surfaces a
  // ZodError JSON when vendor response doesn't match Anthropic shape).
  /ZodError/,
  /invalid_union/i,
  /"validation":\s*\{/,
  // MiniMax / generic vendor envelope (`base_resp:{status_code:N}`).
  // Tolerant on the JSON separators — `"base_resp":{"status_code":1000}`
  // and `base_resp: { status_code : 1 }` both hit.
  /"?base_resp"?[\s:]*\{[^}]*"?status_code"?[\s:]*[1-9]/i,
  /\bunknown error,?\s*\d+/i,
  // OpenAI-style top-level error envelope ("error":{"type":"..."}).
  /"error"\s*:\s*\{\s*"(message|type|code)"\s*:/i,
  // null `choices` array (no usable completion).
  /"choices"\s*:\s*null/i,
];

/**
 * User-facing replacement text when sanitization fires. Single source
 * of truth so the test and cli.ts stay in sync.
 */
export const VENDOR_ERROR_REPLACEMENT =
  "[模型暂时异常] vendor 返回非预期格式，请稍后重发或重试。";

/**
 * Decide whether `text` is the raw bytes of a vendor / SDK failure
 * envelope that must NOT reach the user-facing IM reply.
 *
 * See module docstring for the correlation rules.
 */
export function isVendorErrorForUser(
  text: string,
  failed: boolean,
): boolean {
  if (!text || typeof text !== "string") return false;
  const matchCount = VENDOR_ERROR_PATTERNS.filter((p) => p.test(text)).length;
  if (matchCount === 0) return false;
  if (failed) return true; // failure context + ≥1 signal → sanitize
  return matchCount >= 2; // success context: need ≥2 correlated signals
}
