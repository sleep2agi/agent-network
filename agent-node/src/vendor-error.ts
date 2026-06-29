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
 * Single unified gate (通信牛 #331 round 1):
 *   sanitize / retry ONLY when BOTH conditions hold:
 *     (a) `failed === true`  — the SDK threw or processWithClaude already
 *                              wrapped the result in a `<runtime> 错误:`
 *                              prefix (real failure context, not just
 *                              an LLM reply discussing error formats).
 *     (b) `matchCount >= 2`  — at least two DISTINCT vendor-envelope
 *                              signals correlate. A single broad pattern
 *                              like `ZodError` or `base_resp` could
 *                              appear in a normal Q&A — the signature
 *                              of a real failure envelope is multiple
 *                              correlated terms (e.g. zod issue + null
 *                              choices + status_code != 0).
 *
 * Trade-off accepted: a rare SDK-throw whose error text contains only
 * one signal (e.g. `claude 错误: ZodError: cannot parse`) slips through
 * un-sanitized. User sees the raw line. Stricter than ideal but
 * eliminates false-positives on technical discussion that quotes
 * multiple error terms in success context.
 *
 * Both `isVendorErrorForUser` (sanitize gate) and `isTransientVendorError`
 * (retry gate) use this same predicate as their base — single source of
 * truth, no drift.
 */
export function isVendorErrorForUser(
  text: string,
  failed: boolean,
): boolean {
  if (!text || typeof text !== "string") return false;
  if (!failed) return false; // success context: never sanitize
  const matchCount = VENDOR_ERROR_PATTERNS.filter((p) => p.test(text)).length;
  return matchCount >= 2; // failure + ≥2 distinct signals
}

/**
 * Vincent UAT 2026-06-29 实测: MiniMax `status_code:1000` / `unknown error`
 * / `choices:null` are TRANSIENT — the very next turn (72s later) returned
 * a valid response without operator intervention. Sanitizing on first hit
 * means a clean retry path goes to waste; the user sees "暂时异常 请重发"
 * for what should have just been a one-second retry.
 *
 * `isTransientVendorError(text, failed)` returns true ONLY when the error
 * is BOTH (a) a vendor-error per `isVendorErrorForUser` AND (b) reasonably
 * likely to succeed on retry. Excludes:
 *   - auth-class errors (401 / 403 / unauthorized / quota / insufficient
 *     credit) — these won't recover on retry; operator must rotate
 *     credentials / top up.
 *   - rate-limit (429, too many requests) — caller might decide to retry
 *     with longer backoff, but the default short backoff isn't enough.
 *
 * 通信龙 65e59373 lock: retry transient 1-2 times with short backoff
 * BEFORE sanitization, so Vincent's image+text replies don't sanitize on
 * a single-shot 1000 when the retry would've worked.
 */
export function isTransientVendorError(
  text: string,
  failed: boolean,
): boolean {
  if (!isVendorErrorForUser(text, failed)) return false;
  // Auth-class errors won't recover on retry — don't waste round-trips.
  if (/\b401\b|\b403\b|unauthorized|forbidden/i.test(text)) return false;
  if (/quota|insufficient[_\s]?(credit|balance|funds|tokens?)/i.test(text)) return false;
  // Explicit rate-limit signal — caller-level backoff needed, not our short retry.
  if (/\b429\b|too[_\s]?many[_\s]?requests|rate[_\s]?limit/i.test(text)) return false;
  // Everything else looks transient (vendor 1000 / unknown error / choices null
  // / SDK zod fail on malformed response / OpenAI-style 5xx envelopes).
  return true;
}

/**
 * Configurable retry profile — exported so callers (cli.ts) and tests can
 * align without hard-coding magic numbers in two places.
 */
export const VENDOR_RETRY_PROFILE = {
  /** Total retry attempts after the initial think() call. 2 = up to 3
   *  total attempts (initial + 2 retries). */
  maxRetries: 2,
  /** Backoff schedule per retry attempt (ms). Length should match
   *  maxRetries; missing entries fall back to last entry. */
  backoffMs: [1500, 3000],
} as const;
