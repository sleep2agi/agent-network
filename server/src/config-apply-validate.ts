// Pure validators / classifiers for RFC-024 node-config-apply. Extracted
// from server/src/tools.ts so the contract (allowlist, security-sensitive
// flag set, range/enum rules, apply-mode classification) is unit-testable
// without spinning up an MCP server. The corresponding tool handlers in
// tools.ts wrap these with auth checks (SEC-1 network scope, ntok_/utok_
// caller identity, role gates).

/**
 * Fields the dashboard may change. Anything not in this list is rejected
 * by hub-side validation regardless of role — the UI cannot smuggle
 * extra keys past this gate.
 */
export const ALLOWED_FLAGS = new Set<string>([
  "permissionMode",
  "dangerouslySkipPermissions",
  "teammateMode",
  "maxTurns",
  "budget",
  "timeout",
]);

/**
 * Security-sensitive flags — remote changes are privilege-elevation
 * operations. Final policy (decided 2026-06-28 by 通信龙 per Vincent
 * autonomy grant): **caller role must equal `admin` to flip these
 * flags remotely.** Non-admin requests are rejected with
 * `insufficient_role_for_security_flag`. Cross-network requests are
 * also blocked but via SEC-1 (network scope), not this gate.
 *
 * Dashboard is expected to grey out these inputs for non-admin
 * sessions, but hub does NOT trust the dashboard's UI gate — every
 * tool call is re-checked here. `curl` direct to `/mcp` is a real
 * attack vector.
 */
export const SECURITY_SENSITIVE_FLAGS = new Set<string>([
  "permissionMode",
  "dangerouslySkipPermissions",
  "teammateMode",
]);

/**
 * Flags that require a node process restart (not in-process hot reload).
 * Used by computeApplyMode + the per-tool tier classifier. `timeout`
 * sits here today because CLAUDE_TIMEOUT_MS is a module-level const at
 * boot; P2 will move it to per-think read which would let it become hot.
 */
export const RESTART_REQUIRED_FLAGS = new Set<string>([
  "permissionMode",
  "dangerouslySkipPermissions",
  "teammateMode",
  "timeout",
]);

/**
 * Role-gate for the patch's flag set. SEC-2 enforcement lives here.
 *
 * Returns null on pass, or `{ field, reason }` on reject. The reject
 * payload shape matches the tool handler's error envelope so the
 * caller can forward it without re-shaping.
 *
 * Policy (final, 2026-06-28):
 *   - security-sensitive flags → caller role MUST be admin-or-above
 *     (admin OR owner; owner > admin in the anet RBAC, per auth.ts
 *     network_members hierarchy — viewer < member < admin < owner)
 *   - harmless flags → handled by upstream `canWrite` (role !== viewer);
 *     this helper passes them through (no per-flag gate beyond
 *     allowlist/range validation)
 *
 * Caller must pass the role string resolved from the user's
 * network_members row (not the token's bearer-level role). Owners
 * are NOT included via "admin ⊇ owner" inheritance — they're a
 * distinct higher tier; the check is explicit OR so any future role
 * (e.g. "super_admin") needs an explicit allowlist update.
 */
const SECURITY_ADMIN_ROLES = new Set<string>(["admin", "owner"]);

export function isAllowedToChangeFlag(
  role: string | null,
  patchFlags: Record<string, unknown>,
): { field: string; reason: string } | null {
  for (const key of Object.keys(patchFlags)) {
    if (SECURITY_SENSITIVE_FLAGS.has(key)) {
      if (!role || !SECURITY_ADMIN_ROLES.has(role)) {
        return {
          field: `flags.${key}`,
          reason: "remote change of security-sensitive flags requires admin or owner role on this network",
        };
      }
    }
  }
  return null;
}

/**
 * Classify the patch's required apply mode. Empty patch (model + flags
 * both empty) → "restart_only" (used by restart_node tool). Any
 * restart-required field present → "restart". Otherwise → "hot".
 */
export function computeApplyMode(
  model: string | undefined,
  flags: Record<string, unknown>,
): "hot" | "restart" | "restart_only" {
  const fieldCount = (model !== undefined ? 1 : 0) + Object.keys(flags).length;
  if (fieldCount === 0) return "restart_only";
  if (model !== undefined) return "restart";
  for (const key of Object.keys(flags)) {
    if (RESTART_REQUIRED_FLAGS.has(key)) return "restart";
  }
  return "hot";
}

/**
 * Validate the patch shape — allowlist + per-field range / enum. Returns
 * null on pass, or `{ field, reason }` on reject. Caller wraps in error
 * envelope.
 */
export function validatePatch(
  model: string | undefined,
  flags: Record<string, unknown>,
): { field: string; reason: string } | null {
  if (model !== undefined) {
    if (typeof model !== "string" || model.length === 0 || model.length > 200) {
      return { field: "model", reason: "must be a non-empty string ≤ 200 chars" };
    }
  }
  for (const [key, val] of Object.entries(flags)) {
    if (!ALLOWED_FLAGS.has(key)) {
      return { field: `flags.${key}`, reason: "not in allowlist" };
    }
    switch (key) {
      case "permissionMode":
        if (
          typeof val !== "string" ||
          !["default", "auto", "bypassPermissions", "acceptEdits", "plan"].includes(val)
        ) {
          return {
            field: "flags.permissionMode",
            reason: "must be one of default/auto/bypassPermissions/acceptEdits/plan",
          };
        }
        break;
      case "dangerouslySkipPermissions":
      case "teammateMode":
        if (typeof val !== "boolean") {
          return { field: `flags.${key}`, reason: "must be boolean" };
        }
        break;
      case "maxTurns":
        if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 10000) {
          return { field: "flags.maxTurns", reason: "must be an integer in [0, 10000]" };
        }
        break;
      case "budget":
        if (typeof val !== "number" || val < 0 || val > 1000000) {
          return { field: "flags.budget", reason: "must be a number in [0, 1_000_000]" };
        }
        break;
      case "timeout":
        if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 3_600_000) {
          return { field: "flags.timeout", reason: "must be an integer ms in [0, 3_600_000]" };
        }
        break;
    }
  }
  return null;
}
