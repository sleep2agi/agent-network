/**
 * Board #656 — temporary model capacity is retried, not failed on the first hit.
 *
 * Schedule is fixed: 30s, then 60s, then 120s, at most 3 retries (4 attempts).
 * The same model and the same config are submitted again. Auth failures and
 * quota exhaustion are not in this class.
 *
 * Cooperation with board #651 (OpenCode reply-deadline abort):
 *   A capacity wait is not a reply deadline and not model-idle time. Callers
 *   pause or push their own deadline forward by the backoff BEFORE sleeping,
 *   and they sleep outside AbortSignal.timeout / the response-idle timer.
 *   The wait therefore cannot be classified as "the turn timed out" and cannot
 *   POST /session/:id/abort. A real timeout still aborts exactly as #651
 *   specifies; this module does not touch that decision.
 */

export const CAPACITY_RETRY_LIMIT = 3;
export const CAPACITY_RETRY_BACKOFF_MS = [30_000, 60_000, 120_000] as const;
export const CAPACITY_RETRY_EXHAUSTED_TEXT = "模型满载，已自动重试 3 次";

export function capacityRetryProgress(attempt: number): string {
  return `模型满载，第 ${attempt} 次重试中`;
}

export function defaultCapacityRetrySleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const PERMANENT_RE =
  /insufficient[_\s-]?quota|quota[_\s-]?(?:exceeded|exhausted|exhaust)|usage[_\s-]?limit|out of (?:credits|quota)|billing|payment required|\b401\b|\b403\b|unauthorized|forbidden|invalid[_\s-]?(?:api[_\s-]?)?key|authentication_error/i;

/** Seconds / milliseconds must not look like an HTTP status. */
function hasTemporary5xx(text: string): boolean {
  if (/\b(?:internal server error|bad gateway|service unavailable|gateway timeout)\b/i.test(text)) {
    return true;
  }
  return /(?:^|[^0-9])5\d\d(?![0-9])/i.test(text)
    && !/(?:^|[^0-9])5\d\d(?:\s*(?:ms|s))\b/i.test(text);
}

/**
 * True only for a temporary capacity / overload / rate-limit / 5xx failure.
 * Permanent auth and quota exhaustion return false even if they also say 429.
 */
export function isRetryableCapacityError(text: string): boolean {
  if (!text) return false;
  if (PERMANENT_RE.test(text)) return false;
  return /\bat capacity\b/i.test(text)
    || /\boverloaded(?:_error)?\b/i.test(text)
    || /\b429\b/.test(text)
    || /rate[_\s-]?limit/i.test(text)
    || /too[_\s-]?many[_\s-]?requests/i.test(text)
    || hasTemporary5xx(text);
}

export type CapacityRetryDecision =
  | { action: "retry"; attempt: number; waitMs: number; progress: string }
  | { action: "exhaust" }
  | { action: "give_up" };

/** `retriesSoFar` is how many capacity backoffs have already been started. */
export function capacityRetryDecision(retriesSoFar: number, text: string): CapacityRetryDecision {
  if (!isRetryableCapacityError(text)) return { action: "give_up" };
  if (retriesSoFar >= CAPACITY_RETRY_LIMIT) return { action: "exhaust" };
  const attempt = retriesSoFar + 1;
  const waitMs = CAPACITY_RETRY_BACKOFF_MS[retriesSoFar] ?? CAPACITY_RETRY_BACKOFF_MS[CAPACITY_RETRY_BACKOFF_MS.length - 1];
  return { action: "retry", attempt, waitMs, progress: capacityRetryProgress(attempt) };
}

export async function pauseForCapacityRetry(
  decision: Extract<CapacityRetryDecision, { action: "retry" }>,
  hooks?: {
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (attempt: number) => void | Promise<void>;
  },
): Promise<void> {
  try {
    await hooks?.onRetry?.(decision.attempt);
  } catch {
    // Progress is best-effort. The retry itself still happens.
  }
  await (hooks?.sleep ?? defaultCapacityRetrySleep)(decision.waitMs);
}
