// #230 — explicit-delegation precheck helper.
//
// Pure module so the alias-equality + self-exclusion logic can be
// exercised without spinning up the cli.ts process. The earlier
// inline check in `tryHandleExplicitDelegation` did a
// `JSON.stringify(get_all_status).includes(parsed.alias)` substring
// search. That substring scan includes every session's `task` field —
// including the calling node's own `task`, which it has just set to
// the inbound task body via `reportStatus("working", task.slice(0, 200))`
// two lines earlier. If the parsed alias string happens to be a
// substring of the original task text (the natural case for a
// description-rather-than-imperative trigger like
// `"...刚才发给 <某人> 的 <某物>..."`), the node's own row reflects
// the parsed alias back at the precheck, the check wrongly passes,
// the real `send_task` fires against a garbage alias, and the server
// (correctly) rejects with `alias_not_found`.
//
// Fix: exact alias equality on the `sessions` array, plus an explicit
// self-exclusion so the calling node's own row can never satisfy the
// precheck — even if a future code path lets self-delegation become
// meaningful, that's a feature-level decision that should not be
// silently rubber-stamped by the precheck.

export type DelegationCheckResult =
  | { exists: true; source: "session" }
  | { exists: false; reason: "not_in_sessions" | "self_only" | "no_sessions_field" | "empty_sessions" };

export type SessionLike = {
  alias?: string;
};

/**
 * Check whether `targetAlias` is registered as an active session that
 * is NOT the calling node itself. Pure function — no I/O, no globals.
 *
 * `sessions` is whatever shape the caller pulled out of the commhub
 * `get_all_status` payload. We accept `undefined` so the caller can
 * pass `status?.sessions` directly without an extra null-check.
 *
 * The result is a typed object rather than a plain boolean so the
 * caller can distinguish "you asked for self" from "the alias really
 * is not online" — useful for log lines and operator hints when the
 * fall-through-to-LLM behaviour kicks in.
 */
export function delegationTargetExists(
  sessions: SessionLike[] | undefined | null,
  targetAlias: string,
  selfAlias: string,
): DelegationCheckResult {
  if (!Array.isArray(sessions)) {
    return { exists: false, reason: "no_sessions_field" };
  }
  if (sessions.length === 0) {
    return { exists: false, reason: "empty_sessions" };
  }
  // Normalise — defend against zod-stripped rows that might come back
  // without an alias field, and trim whitespace so accidental
  // copy-paste padding in the parsed alias doesn't mask a real hit.
  const target = (targetAlias ?? "").trim();
  const me = (selfAlias ?? "").trim();
  if (!target) return { exists: false, reason: "not_in_sessions" };

  let sawSelfMatch = false;
  for (const s of sessions) {
    const a = typeof s?.alias === "string" ? s.alias.trim() : "";
    if (!a) continue;
    if (a === target) {
      if (a === me) {
        sawSelfMatch = true;
        continue;
      }
      return { exists: true, source: "session" };
    }
  }
  return { exists: false, reason: sawSelfMatch ? "self_only" : "not_in_sessions" };
}
