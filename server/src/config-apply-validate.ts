// Pure validators / classifiers for RFC-024 node-config-apply. Extracted
// from server/src/tools.ts so the contract (allowlist, security-sensitive
// flag set, range/enum rules, apply-mode classification) is unit-testable
// without spinning up an MCP server. The corresponding tool handlers in
// tools.ts wrap these with auth checks (SEC-1 network scope, ntok_/utok_
// caller identity, role gates).

import { isValidTimeoutMs, TIMEOUT_MS_REASON } from "./create-node-validate.js";
import {
  REASONING_EFFORT_VALUES,
  validateCodexConfigFlag,
  type ModelReasoningEffort,
} from "./codex-config-flags.js";

export { REASONING_EFFORT_VALUES, type ModelReasoningEffort } from "./codex-config-flags.js";

/**
 * Fields the dashboard may change. Anything not in this list is rejected
 * by hub-side validation regardless of role — the UI cannot smuggle
 * extra keys past this gate.
 */
export const ALLOWED_FLAGS = new Set<string>([
  "permissionMode",
  "dangerouslySkipPermissions",
  "maxTurns",
  "budget",
  "timeout",
  // Codex (#815 / client): posture + co-presence grant + thinking level
  "approvalPolicy",
  "sandboxMode",
  "skipGitRepoCheck",
  "copresenceFullAccess",
  "modelReasoningEffort",
]);
// NB on teammateMode (dropped from P1 scope per #290 cross-agent
// review): teammateMode is consumed ONLY by the claude-code-cli
// spawn path in agent-network/bin/cli.ts (passed as --teammate-mode
// CLI arg). The agent-node-driven runtimes (claude-agent-sdk /
// codex-sdk / grok-build-acp) that the config-apply pipeline targets
// do NOT consume it. Including it in the allowlist would silently
// ack `applied` for changes that have zero effect — same class as
// the BLOCKER 2 schema-mismatch issue. P2: add a claude-code-cli
// config-apply path that respawns the CLI process.

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
  "approvalPolicy",
  "sandboxMode",
  "copresenceFullAccess",
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
  "timeout",
  "approvalPolicy",
  "sandboxMode",
  "skipGitRepoCheck",
  "copresenceFullAccess",
  "modelReasoningEffort",
]);

/**
 * Channels the dashboard may enable/disable on a node via
 * update_node_config. Intentionally narrow — the panel only exposes
 * enable/disable, per-channel secrets stay in the node's local
 * config.json (see #260 wire discipline).
 *
 * The list mirrors agent-node's actual runtime capability. See
 * agent-node/src/cli.ts:671-676 — CHANNELS are parsed into per-type
 * worker inits (initTelegramChannel + initFeishuChannel), and any
 * other channel type triggers `process.exit(1)` at boot. So the
 * hub-side allow-list here is telegram + feishu ONLY. `commhub` is
 * the RPC transport that every node speaks unconditionally; treating
 * it as a per-node channel would be a UX lie (toggle looks off but
 * commhub is always on).
 *
 * Dashboard PR #31 currently includes `commhub` in its own
 * EDITABLE_CHANNELS whitelist — that follow-up narrowing is filed for
 * the next dashboard rally, and until then hub silently drops any
 * `commhub` entry via narrowChannelsPatch.
 *
 * Not part of SECURITY_SENSITIVE_FLAGS (通信龙 P5 派工): flipping a
 * channel on/off is a lifecycle-tier operation like `restart_node`, not
 * a privilege elevation. Cross-tenant reach is already gated by SEC-1.
 */
export const EDITABLE_CHANNELS = new Set<string>([
  "telegram",
  "feishu",
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
 * Runtime families the hub treats as "OpenCode". `nodes.runtime` is
 * written from report_status and carries the legacy `-sdk` bucket
 * (`opencode-sdk`) for older CLI builds, while newer callers pass the
 * config-level spelling (`opencode-cli` / `opencode`). All three mean
 * the same agent-node runtime, so the hot-model-switch gate below must
 * accept every spelling — otherwise the same node flips between hot
 * and restart depending on which build reported last.
 */
const OPENCODE_RUNTIME_LABELS = new Set<string>(["opencode-sdk", "opencode-cli", "opencode"]);

/**
 * Read the OpenCode knobs the hub persists in `nodes.config_snapshot`.
 * Both are reported by agent-node (see buildConfigSnapshot in
 * agent-node/src/runtime/config-apply.ts) and are the only two fields
 * the apply-mode decision needs.
 *
 * Snapshot is stored as text but older rows hold objects; a parse
 * failure means "this cell is empty" (never an exception) — same
 * fail-shape as the api-nodes projection.
 */
export function readOpencodeSnapshotFlags(configSnapshot: unknown): {
  opencodeGeneration: "v1" | "v2" | null;
  opencodeMode: string | null;
} {
  let parsed: any = null;
  try {
    parsed = typeof configSnapshot === "string"
      ? (configSnapshot ? JSON.parse(configSnapshot) : null)
      : configSnapshot;
  } catch {
    parsed = null;
  }
  const flags = parsed?.flags;
  const generation = flags?.opencodeGeneration;
  const mode = flags?.opencodeMode;
  return {
    opencodeGeneration: generation === "v1" || generation === "v2" ? generation : null,
    opencodeMode: typeof mode === "string" && mode.length <= 32 ? mode : null,
  };
}

/**
 * True when the node can swap the live model without a process restart.
 *
 * Mirrors `computeApplyMode` in agent-node/src/runtime/config-apply.ts
 * (#3146). The node has been able to do this since OpenCode V2
 * co-presence shipped, but the hub classified every `model` patch as
 * `restart`, so the client showed "restarting" and waited for a
 * restart that the node deliberately never performed. Hub and node now
 * agree on the same three conditions:
 *
 *   runtime ∈ OpenCode   ·   opencodeGeneration === "v2"   ·   mode === "copresence"
 *
 * `copresence` is required because the hot switch drives the running
 * TUI session (`opencodeCopresenceSession.setSelectedModel`); a
 * headless V2 node has no such session and must restart. Only a
 * model-ONLY patch qualifies — adding flags or channels drags in
 * restart-tier fields, and the node would restart anyway.
 */
export function isHotModelSwitchSupported(
  model: string | undefined,
  flags: Record<string, unknown>,
  channels: string[] | undefined,
  runtime: string | null | undefined,
  opencodeGeneration: "v1" | "v2" | null,
  opencodeMode: string | null,
): boolean {
  if (model === undefined) return false;
  if (Object.keys(flags).length !== 0) return false;
  if (channels !== undefined) return false;
  if (!runtime || !OPENCODE_RUNTIME_LABELS.has(runtime)) return false;
  if (opencodeGeneration !== "v2") return false;
  return opencodeMode === "copresence";
}

/**
 * Classify the patch's required apply mode. Empty patch (model + flags
 * both empty, no channels) → "restart_only" (used by restart_node tool).
 * Any restart-required field present, OR a channels change → "restart"
 * (channels is restart-tier by design: the node reads its channel set
 * once at boot in agent-node/src/cli.ts and forks per-channel workers
 * from it, so a channel enable/disable takes effect on process restart
 * only — see #260 P5 wire discipline). Otherwise → "hot".
 *
 * `opts` carries the target node's runtime identity. Callers that omit
 * it get the pre-#3146 behaviour (model ⇒ restart), which is the safe
 * answer for any node we know nothing about.
 */
export function computeApplyMode(
  model: string | undefined,
  flags: Record<string, unknown>,
  channels?: string[] | undefined,
  opts?: {
    runtime?: string | null;
    opencodeGeneration?: "v1" | "v2" | null;
    opencodeMode?: string | null;
  },
): "hot" | "restart" | "restart_only" {
  const fieldCount = (model !== undefined ? 1 : 0) + Object.keys(flags).length + (channels !== undefined ? 1 : 0);
  if (fieldCount === 0) return "restart_only";
  if (model !== undefined) {
    if (isHotModelSwitchSupported(
      model,
      flags,
      channels,
      opts?.runtime,
      opts?.opencodeGeneration ?? null,
      opts?.opencodeMode ?? null,
    )) return "hot";
    return "restart";
  }
  if (channels !== undefined) return "restart";
  for (const key of Object.keys(flags)) {
    if (RESTART_REQUIRED_FLAGS.has(key)) return "restart";
  }
  return "hot";
}

/**
 * Narrow + allow-list `channels` from untrusted patch JSON. Returns the
 * final channel key list (case-folded, deduped, in EDITABLE_CHANNELS
 * order-preserving), OR null if the input isn't an array. Non-strings,
 * unknown keys, empty strings, and duplicates are silently dropped —
 * same fail-shape as the dashboard route's whitelist so the two sides
 * behave identically end-to-end. Callers pass `undefined` through when
 * the patch didn't include a channels key at all (a distinct case from
 * `channels: []` which means "disable all editable channels").
 */
export function narrowChannelsPatch(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const allow = EDITABLE_CHANNELS;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const key = v.trim().toLowerCase();
    if (!allow.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Validate the patch shape — allowlist + per-field range / enum. Returns
 * null on pass, or `{ field, reason }` on reject. Caller wraps in error
 * envelope.
 */
export function validatePatch(
  model: string | undefined,
  flags: Record<string, unknown>,
  channels?: string[] | undefined,
  nodeRuntime?: string | null,
): { field: string; reason: string } | null {
  if (model !== undefined) {
    if (typeof model !== "string" || model.length === 0 || model.length > 200) {
      return { field: "model", reason: "must be a non-empty string ≤ 200 chars" };
    }
  }
  if (channels !== undefined) {
    // Zod already enforced string[], and narrowChannelsPatch dropped
    // unknown keys before this point — but re-verify defensively so a
    // future caller that skips narrowChannelsPatch can't smuggle
    // unknown keys through validatePatch alone.
    if (!Array.isArray(channels)) {
      return { field: "channels", reason: "must be an array of strings" };
    }
    for (const c of channels) {
      if (typeof c !== "string") {
        return { field: "channels", reason: "must contain only strings" };
      }
      if (!EDITABLE_CHANNELS.has(c)) {
        return { field: `channels.${c}`, reason: "not in editable channels allowlist" };
      }
    }
  }
  for (const [key, val] of Object.entries(flags)) {
    if (!ALLOWED_FLAGS.has(key)) {
      return { field: `flags.${key}`, reason: "not in allowlist" };
    }
    const codexFail = validateCodexConfigFlag(key, val, nodeRuntime ?? null);
    if (codexFail) return codexFail;
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
        // #605 —— 与 create_node 同一把尺子(create-node-validate.ts isValidTimeoutMs):
        // 毫秒,0 或 1000..3_600_000;1..999 是「按秒填了」的形状,拒绝而不是给一个亚秒超时。
        if (!isValidTimeoutMs(val)) {
          return { field: "flags.timeout", reason: TIMEOUT_MS_REASON };
        }
        break;
    }
  }
  return null;
}
