/**
 * `ack_inbox` tolerance.
 *
 * The Hub rejects an ack with `app-level rejection: message not found or
 * already acknowledged` once the row is no longer pending. That is the state
 * we were trying to reach, not a failure: another consumer got there first —
 * typically the model itself calling the Hub's `ack_inbox` MCP tool inside
 * its turn, or a second drain pass that lost the response of a successful
 * ack.
 *
 * Treating it as a transport error is expensive: `drainInboxBatch()` throws
 * on the first error, the lane retries the whole batch forever, and every
 * later message shares that retry loop. On 2026-11-23 a node stayed silent
 * for eight hours after one such rejection.
 */
export function isBenignAckRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /already acknowledged/i.test(message) || /message not found/i.test(message);
}