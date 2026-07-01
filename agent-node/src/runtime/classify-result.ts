// Cross-runtime result classifier. Folds the #267 claude
// `isRateLimitOrQuotaError` regex plus the in=0 & out=0 & cost=0
// silent-reject shape AND a strict empty-result check into one
// decision surface that claude / codex / grok all consume.
//
// Why centralise: the "vendor accepted a request, reports success,
// returns nothing" shape is not specific to the claude runtime. Codex
// turns and Grok ACP prompts can produce the same shape (silent
// rate-limit, vendor outage, billing cutoff). Each runtime
// re-implementing the heuristic produces drift; one util keeps the
// detection rules in lockstep AND keeps the call sites under 5 lines
// each so the read-review cost stays low.
//
// Detection strategy is deliberately strict to avoid false positives:
// codex's `usage.output_tokens` value is not reliably reported across
// model providers, so an `output_tokens === 0` signal ALONE is not
// enough to flag a soft failure. Two signals must agree:
//   - result is empty (null / undefined / "") — flag (regardless of usage)
//   - in=0 AND out=0 AND cost=0 — flag (three-zero silent reject)
// A non-empty result with `output_tokens === 0` is treated as success
// (the previous OR-rule false-positived on codex turns).
//
// Pure helper. Re-exports the building blocks so direct
// `isRateLimitOrQuotaError` users (the auth-error fast-fail in cli.ts)
// don't have to bounce through this module's surface.

import {
  isRateLimitOrQuotaError,
  quotaRemediationHint,
  extractQuotaCode,
  extractVendorQuotaPhrase,
} from "./claude-error-classify";

export type ClassificationKind =
  | "success"
  | "soft-fail-empty"  // vendor accepted, returned nothing / 0 tokens
  | "soft-fail-quota"  // rate limit / quota / overload (operator action)
  | "error";           // hard failure (network / 5xx / parser)

/**
 * Shape every runtime produces after a turn. Each field is optional —
 * the classifier degrades gracefully when a runtime doesn't report a
 * given dimension (e.g. codex sometimes lacks `totalCostUsd`).
 */
export interface RuntimeResultLike {
  /** Final text reply. Empty string / null / undefined all count as empty. */
  result?: string | null;
  /** SDK usage block. `output_tokens === 0` is the silent-reject signal. */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    [k: string]: unknown;
  } | null;
  /** Anthropic-style cost field. `=== 0` co-confirms silent reject. */
  totalCostUsd?: number | null;
  /** Set when the runtime caught an exception during the turn. */
  errorMessage?: string | null;
}

export interface ClassificationResult {
  kind: ClassificationKind;
  /** Short machine-readable reason; safe to log. */
  reason?: string;
  /** Vendor-specific remediation hint (URL / action) when applicable. */
  hint?: string;
}

/**
 * Decide whether a runtime turn was a real success, a soft failure
 * (quota / empty result), or a hard error.
 *
 * Precedence (most specific first):
 *   1. errorMessage matching quota/rate-limit → soft-fail-quota
 *   2. errorMessage otherwise present         → error
 *   3. in=0 & out=0 & cost=0 (all three)      → soft-fail-empty
 *      (the "vendor silently dropped the request" shape)
 *   4. result strictly empty (null / undefined / "") → soft-fail-empty
 *   5. otherwise                              → success
 *
 * Note on rule 4: `output_tokens === 0` ALONE is intentionally NOT a
 * flag-trigger when the result text is non-empty. Codex providers vary
 * widely in usage reporting fidelity (some report zero output even when
 * a real reply was returned), so the previous "result-text OR
 * output_tokens === 0" rule false-positived on healthy codex turns.
 * Empty result remains a hard flag regardless of usage.
 *
 * @param m   the runtime turn outcome
 * @param opts.baseUrl  vendor base URL used to route the remediation
 *   hint (e.g. `process.env.ANTHROPIC_BASE_URL` for claude;
 *   `OPENAI_BASE_URL` for codex; `XAI_BASE_URL` for grok).
 */
export function classifyRuntimeResult(
  m: RuntimeResultLike,
  opts?: { baseUrl?: string | null },
): ClassificationResult {
  const baseUrl = opts?.baseUrl;
  if (m.errorMessage) {
    if (isRateLimitOrQuotaError(m.errorMessage)) {
      return {
        kind: "soft-fail-quota",
        reason: m.errorMessage,
        hint: quotaRemediationHint(baseUrl),
      };
    }
    return { kind: "error", reason: m.errorMessage };
  }

  // Three-zero silent reject — `in=0 AND out=0 AND cost=0`. The 2026-
  // 06-26 M3 episode surfaced this exact triple as an upstream 429
  // that the SDK silently retried into; runtime treated the turn as
  // successful because no error was thrown. Requiring ALL three signals
  // to agree avoids false-positiving runtimes that simply don't report
  // cost (codex turn.completed sometimes omits it).
  const usage = m.usage ?? {};
  const inTokens = usage.input_tokens ?? null;
  const outTokens = usage.output_tokens ?? null;
  const cost = m.totalCostUsd ?? null;
  if (inTokens === 0 && outTokens === 0 && cost === 0) {
    return {
      kind: "soft-fail-empty",
      reason: "vendor returned in=0 out=0 cost=0 — upstream silent reject (suspect 429/quota/auth without explicit error)",
      hint: quotaRemediationHint(baseUrl),
    };
  }

  // Strict empty-result check. Only the literal absence of text counts:
  // null / undefined / empty string. A `result === "0"` single-char
  // reply is success. A non-empty result paired with a suspicious
  // `output_tokens === 0` is also success (per usage-reliability
  // caveat in the module header).
  const resultEmpty = m.result === null || m.result === undefined || m.result === "";
  if (resultEmpty) {
    return {
      kind: "soft-fail-empty",
      reason: "empty vendor result despite success signal",
      hint: quotaRemediationHint(baseUrl),
    };
  }

  return { kind: "success" };
}

/**
 * Convenience: format a user-surfaced error string for a non-success
 * classification. Centralised so the message shape stays consistent
 * across runtimes (the upstream caller / IM bridge / dashboard parse
 * the prefix `执行出错:` to flag failure rows).
 *
 * §20 (2026-07-01 Vincent case): promote vendor-native quota codes
 * and phrases into the user-facing text. Historically the message
 * read `执行出错: ... 限流/配额耗尽 (<truncated raw>) — → 检查
 * platform.X.com 配额`, which buried the actual vendor wording under
 * `(...80 chars)`. Users reported it as a generic bot bug rather than
 * a billing signal. New shape passes the vendor's own Chinese phrase
 * (`已达到 Token Plan 用量上限`) through verbatim + tags the specific
 * code (e.g. MiniMax 2056) when known.
 *
 * For `soft-fail-empty` we ALSO hint at the outbound-mask log — if the
 * request contained a credential literal the vendor may have silently
 * filtered it into `out>0 result=""`. The mask log is greppable, so
 * operators can correlate. Independent of any single vendor quirk.
 */
export function formatClassificationError(
  c: ClassificationResult,
  context: { runtime: string; usage?: RuntimeResultLike["usage"] },
): string {
  const inT = context.usage?.input_tokens ?? 0;
  const outT = context.usage?.output_tokens ?? 0;
  switch (c.kind) {
    case "soft-fail-quota": {
      // §20 — friendly Chinese prefix + vendor phrase pass-through +
      // known code tag. If no vendor phrase is extractable, fall back
      // to the truncated raw reason.
      const raw = c.reason || "";
      const phrase = extractVendorQuotaPhrase(raw);
      const code = extractQuotaCode(raw);
      const codeTag = code ? ` [${code}]` : "";
      const body =
        phrase ??
        raw.slice(0, 200); // fall back to raw when no known phrase
      return `执行出错: [额度用尽]${codeTag} ${context.runtime}: ${body}${c.hint ? ` — ${c.hint}` : ""}`;
    }
    case "soft-fail-empty":
      // §20 — soft-fail-empty is subtler: the vendor said "success"
      // but returned nothing. Common causes (in order):
      //   1. Content filter fired on a credential literal in the
      //      request (Vincent PAT case — content filter drops
      //      response but marks 200 OK).
      //   2. Silent throttle at the vendor's format-conversion layer
      //      (MiniMax /anthropic gateway occasionally does this).
      //   3. Model produced only reasoning/thinking blocks with no
      //      text content (reasoning-heavy prompt + inadequate
      //      max_tokens).
      // We surface all three as hints so operators can triage without
      // guessing.
      return (
        `执行出错: ${context.runtime} 返回空响应 (in=${inT} out=${outT}). ` +
        `可能原因: (a) vendor 内容过滤 (请求含 credential 字面, 见 [outbound-mask] 日志) ` +
        `(b) 静默限流/配额撞顶 (查 vendor dashboard 用量) ` +
        `(c) 模型仅生成 reasoning/thinking 无 text (加大 max_tokens 或换 prompt). ` +
        `${c.hint || ""}`.trim()
      );
    case "error":
      return `执行出错: ${context.runtime} — ${(c.reason || "未知错误").slice(0, 200)}`;
    case "success":
      // Caller should only invoke this on non-success; defensive default.
      return "";
  }
}

// Re-export building blocks so callers that just want the regex (e.g.
// the catch-block fast-fail in cli.ts) don't have to depend on this
// wider surface.
export {
  isRateLimitOrQuotaError,
  quotaRemediationHint,
};
