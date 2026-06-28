// Claude-agent-sdk error & result classifiers, extracted from cli.ts so
// the patterns can be unit-tested without spinning up the SDK.
//
// Two classifiers, both pure:
//
//   isRateLimitOrQuotaError(msg)
//     Detects HTTP 429 / 529, rate_limit / quota / overloaded shapes
//     across the Anthropic-compat endpoints anet talks to (Anthropic
//     native, deepseek-v4-pro, MiniMax-M3 / M2.x, intern-s2-preview,
//     小米 MiMo). Each vendor surfaces rate-limit errors slightly
//     differently — anet treats them as a single failure class.
//
//   isEmptyResultSoftFailure({ result, usage })
//     SDK can emit `subtype: "success"` with EMPTY content blocks
//     when the vendor accepts the request but returns no text. M3
//     incident 2026-06-XX surfaced exactly this — the result block
//     fell through `m.result || "任务完成"` and got silently
//     rebranded as "task complete" to the upstream caller. This
//     classifier promotes that to a soft failure so the user / next
//     hop sees the empty-vendor-response truth.
//
// Both classifiers are pure (no I/O, no globals) — drop them into
// cli.ts's existing retry/return chain at the matching call sites.

/**
 * True if `msg` looks like a vendor-side rate-limit / quota / overload
 * signal. Used to short-circuit the 4s+8s retry chain in cli.ts with
 * an explicit operator-actionable message — pre-fix, the same generic
 * "claude-agent-sdk 调用超时" string came back after 15 min of futile
 * retries.
 *
 * Detection strategy: a single regex that matches HTTP status codes
 * (429/529 as word-boundary integers), the standard `rate_limit` /
 * `rate limit` / `rate-limit` token, the `quota exceeded` / `quota
 * exhausted` / `insufficient quota` phrases, the Anthropic-spec
 * `overloaded` / `overloaded_error` token, and the OpenAI-compat
 * `too_many_requests` token. Case-insensitive throughout.
 */
export function isRateLimitOrQuotaError(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /\b(429|529)\b|rate[_\s-]?limit|quota[_\s-]?(exceeded|exhaust)|overloaded(_error)?|too[_\s-]?many[_\s-]?requests|usage[_\s-]?limit|insufficient[_\s-]?quota|capacity[_\s-]?exceeded|token\s*plan.*(上限|exceeded)/i.test(
    msg,
  );
}

/**
 * Per-vendor hint mapping ANTHROPIC_BASE_URL → "where to check quota".
 * Mirrors the auth-error remediationHint shape in cli.ts but pointed at
 * vendor usage dashboards instead of API-key reissue pages.
 */
export function quotaRemediationHint(anthropicBaseUrl: string | null | undefined): string {
  const base = (anthropicBaseUrl || "").toLowerCase();
  if (base.includes("intern-ai.org.cn")) return "→ 检查 chat.intern-ai.org.cn 配额/Token Plan 上限/降并发";
  if (base.includes("minimaxi") || base.includes("minimax")) return "→ 检查 platform.minimaxi.com 配额/Token Plan 上限/降并发";
  if (base.includes("deepseek")) return "→ 检查 platform.deepseek.com 配额/账户余额/降并发";
  if (base.includes("anthropic")) return "→ 检查 console.anthropic.com 配额/usage limit/降并发";
  if (base.includes("xiaomimimo") || base.includes("mimo")) return "→ 检查 platform.xiaomimimo.com 配额/降并发";
  return "→ 检查 vendor 配额/限流 dashboard / 降并发";
}

/**
 * SDK result-message shape the classifier cares about. Mirrors the
 * fields cli.ts already reads — no need to import the full SDK type
 * (which is huge and the SDK ships only as a runtime dep).
 */
export interface ClaudeResultLike {
  result?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    [k: string]: unknown;
  } | null;
}

/**
 * True when a `subtype: "success"` SDK result is actually an empty
 * vendor reply — `result` is null/empty AND/OR `usage.output_tokens`
 * is 0. Either signal alone is enough; both together is the canonical
 * "vendor accepted, generated nothing" shape we've seen across rate-
 * limited vendors. Note `result === "0"` (string "0") is non-empty and
 * NOT a soft failure — only `null` / `undefined` / empty string `""`
 * count as empty.
 *
 * Caller responsibility: only invoke this when SDK already said
 * `subtype === "success"`. Failures (`error` subtype etc.) have their
 * own classification path.
 */
export function isEmptyResultSoftFailure(m: ClaudeResultLike): boolean {
  const emptyContent = m.result === null || m.result === undefined || m.result === "";
  const zeroOut = (m.usage?.output_tokens ?? 1) === 0;
  return emptyContent || zeroOut;
}
