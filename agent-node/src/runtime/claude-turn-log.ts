// #557 — three things the claude-agent-sdk runtime said about a turn that
// were not true on SDK 0.3.289 (real-model canary, 2026-10-05).
//
//   ① Banner said `model: claude-sonnet-4-6 (default)` with no model
//      configured, while the CLI actually ran the ACCOUNT default
//      (claude-opus-5-5 in the canary). The node has no way to know that
//      name at boot; the SDK's `system/init` message does, so we report it
//      from there — once per session — instead of inventing one.
//   ② A turn that left a background task running makes the NEXT query()
//      yield an extra EMPTY result message before the real one. The final
//      result was right, but the empty one was handled as it arrived, so
//      the log said `执行出错: … 返回空响应` for a turn that succeeded.
//      Only the LAST result of a query decides whether the turn was empty.
//   ③ `total_cost_usd` is the cumulative SESSION total (also across
//      resume), so `$X` on the per-turn line kept growing. Log the delta
//      from the previous total seen for that session, and the total.
//
// Logging only — nothing here feeds billing.

/** ① The `[claude] model in use: X` line, or null when there is nothing new
 *  to say (no model in the init message, or already said for this session). */
export function modelInUseNotice(
  init: { session_id?: string; model?: unknown },
  lastLoggedSessionId: string | undefined,
): string | null {
  const model = typeof init.model === "string" ? init.model.trim() : "";
  if (!model) return null;
  if (init.session_id && init.session_id === lastLoggedSessionId) return null;
  return `[claude] model in use: ${model}`;
}

/**
 * ② Which result of a query is the turn's verdict.
 *
 * Feed every `result` message in arrival order (`empty` = the node's
 * classifier rejected a vendor-claimed success as empty). `pendingEmpty()`
 * after the stream ends is the empty result to act on — non-null only when
 * the LAST result was empty. Earlier empties that a later result superseded
 * are reported by `push` so the caller can note them at debug level.
 */
export function createClaudeResultTracker<T>() {
  let pending: T | null = null;
  return {
    /** Returns the earlier empty result this one supersedes, if any. */
    push(item: T, empty: boolean): T | null {
      const superseded = pending;
      pending = empty ? item : null;
      return superseded;
    },
    pendingEmpty(): T | null {
      return pending;
    },
  };
}

/**
 * ③ Per-turn cost from a cumulative session total.
 *
 * @param total    `total_cost_usd` from this result message (cumulative)
 * @param previous last total seen for the same session, if known
 * @param resumed  whether this query resumed an existing session — when it
 *                 did and `previous` is unknown, the per-turn share cannot be
 *                 derived, so it is printed as `?` rather than guessed.
 */
export function formatClaudeTurnCost(
  total: number | undefined,
  previous: number | undefined,
  resumed: boolean,
): string {
  if (typeof total !== "number" || !Number.isFinite(total)) return "$?";
  let delta: number | undefined;
  if (typeof previous === "number" && Number.isFinite(previous) && total >= previous) delta = total - previous;
  else if (!resumed || (typeof previous === "number" && total < previous)) delta = total;
  const turn = delta === undefined ? "?" : delta.toFixed(4);
  return `$${turn} (session $${total.toFixed(4)})`;
}
