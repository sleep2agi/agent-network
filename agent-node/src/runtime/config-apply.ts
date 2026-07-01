// RFC-024 — node-side config apply runtime.
//
// Called by cli.ts when an SSE `{type:"config_update"}` or
// `{type:"restart"}` doorbell arrives. Pulls the patch from hub via the
// commhub MCP tool, validates locally (defense-in-depth against hub
// validator drift), then routes to one of three paths per
// `apply_mode`:
//   - "hot"          → atomic write file + update in-process mutable
//                      flags obj + ack applied immediately (zero restart)
//   - "restart"      → atomic write file + .prev backup + drain
//                      in-flight think + ack restarting + exit(75)
//   - "restart_only" → no file write, drain + ack restarting + exit(75)
//
// Pure-ish module: pulls in MCP client lazily, exposes the validator
// as a top-level pure helper so unit tests don't need a real hub. The
// exit(75) is gated behind an injected `exit` hook so tests can verify
// the path without terminating the test runner.

import {
  existsSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";

/** Sentinel exit code for "supervisor please restart me with the new
 * config" — borrows BSD EX_TEMPFAIL semantics. The parent supervisor
 * (W1, see launchAgent wrap) keys on this exact code to differentiate
 * restart-intent from a fatal exit. */
export const RESTART_SENTINEL = 75;

/** Defense-in-depth local validation. Same allowlist as hub but
 * intentionally duplicated — if hub validator drifts loose, the node
 * still refuses anything outside this set.
 *
 * NB on teammateMode (dropped from P1 scope per #290 review):
 *   The dashboard schema in RFC-024 §4 originally listed teammateMode
 *   as one of the 6 dashboard-editable flags. Investigation found
 *   teammateMode is ONLY consumed by `claude-code-cli` runtime via
 *   agent-network/bin/cli.ts (passed as --teammate-mode CLI arg at
 *   spawn). The agent-node-driven runtimes (claude-agent-sdk /
 *   codex-sdk / grok-build-acp) that PR B's config-apply runtime
 *   targets do NOT consume it. Including it in the allowlist would
 *   silently ack `applied` for changes that have zero effect — same
 *   class of issue as BLOCKER 2 (budget/timeout schema mismatch).
 *   P2 to add a claude-code-cli config-apply path.
 */
const ALLOWED_FLAGS = new Set<string>([
  "permissionMode",
  "dangerouslySkipPermissions",
  "maxTurns",
  "budget",
  "timeout",
]);

const RESTART_REQUIRED_FLAGS = new Set<string>([
  "permissionMode",
  "dangerouslySkipPermissions",
  "timeout",
]);

export type ApplyMode = "hot" | "restart" | "restart_only";

export interface ConfigPatch {
  model?: string;
  flags?: Record<string, unknown>;
}

export interface ConfigUpdate {
  update_id: string;
  patch: ConfigPatch;
  apply_mode: ApplyMode;
  base_revision: number;
}

/** Validation outcome. `null` = pass; otherwise the rejection envelope. */
export type ValidationResult = { field: string; reason: string } | null;

export function validateLocalPatch(patch: ConfigPatch): ValidationResult {
  if (patch.model !== undefined) {
    if (typeof patch.model !== "string" || patch.model.length === 0 || patch.model.length > 200) {
      return { field: "model", reason: "must be a non-empty string ≤ 200 chars" };
    }
  }
  const flags = patch.flags || {};
  for (const [key, val] of Object.entries(flags)) {
    if (!ALLOWED_FLAGS.has(key)) {
      return { field: `flags.${key}`, reason: "not in local allowlist" };
    }
    switch (key) {
      case "permissionMode":
        if (
          typeof val !== "string" ||
          !["default", "auto", "bypassPermissions", "acceptEdits", "plan"].includes(val)
        ) {
          return { field: "flags.permissionMode", reason: "invalid enum" };
        }
        break;
      case "dangerouslySkipPermissions":
        if (typeof val !== "boolean") return { field: `flags.${key}`, reason: "must be boolean" };
        break;
      case "maxTurns":
        if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 10000) {
          return { field: "flags.maxTurns", reason: "must be int in [0, 10000]" };
        }
        break;
      case "budget":
        if (typeof val !== "number" || val < 0 || val > 1_000_000) {
          return { field: "flags.budget", reason: "must be number in [0, 1_000_000]" };
        }
        break;
      case "timeout":
        if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 3_600_000) {
          return { field: "flags.timeout", reason: "must be int ms in [0, 3_600_000]" };
        }
        break;
    }
  }
  return null;
}

/** Classify whether a patch needs restart vs hot apply. Empty patch
 * → "restart_only" (used by restart_node tool). Mirrors hub helper —
 * see config-apply-validate.ts. */
export function computeApplyMode(patch: ConfigPatch): ApplyMode {
  const hasModel = patch.model !== undefined;
  const flags = patch.flags || {};
  const flagKeys = Object.keys(flags);
  if (!hasModel && flagKeys.length === 0) return "restart_only";
  if (hasModel) return "restart";
  for (const key of flagKeys) {
    if (RESTART_REQUIRED_FLAGS.has(key)) return "restart";
  }
  return "hot";
}

/** Atomic JSON write — temp + rename. Mirrors writeAccessJsonAtomic
 * in agent-network/bin/cli.ts (PR #261 P0-1 catch). Crash-safe; on
 * Ctrl-C / disk-full / concurrent write the target file is never
 * left half-written.
 *
 * Cleans up the tmp file on either write or rename failure so a
 * disk-full event doesn't leak `.tmp.<pid>.<ts>` litter every retry
 * (caught by cross-agent review on PR B).
 */
export function atomicWriteJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    renameSync(tmp, path);
  } catch (e) {
    // Best-effort cleanup; ignore if tmp doesn't exist or unlink fails.
    // unlinkSync imported at module top — strict-ESM compatible (the
    // earlier `require("node:fs")` inline would fail under runtimes
    // without CJS interop).
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch { /* swallow */ }
    throw e;
  }
}

/** Copy the current config to a .prev sidecar so a restart can roll
 * back if the new config wedges the node. Tolerates a missing
 * config (first-write case) — caller handles. */
export function backupConfigPrev(path: string): { backedUp: boolean } {
  if (!existsSync(path)) return { backedUp: false };
  copyFileSync(path, `${path}.prev`);
  return { backedUp: true };
}

/** Boot self-heal — read config.json, on parse / validate fail try
 * the .prev sidecar. Returns the loaded config + a flag describing
 * which path produced it. Throws only if BOTH primary and .prev are
 * unusable (truly bricked — surfaced for caller to log + exit). */
export interface SelfHealOutcome {
  config: any;
  source: "primary" | "prev";
  primaryError?: string;
}
export function loadConfigWithSelfHeal(path: string): SelfHealOutcome {
  let primaryError: string | undefined;
  try {
    const txt = readFileSync(path, "utf-8");
    const parsed = JSON.parse(txt);
    return { config: parsed, source: "primary" };
  } catch (e: any) {
    primaryError = String(e?.message || e);
  }
  // Primary failed — try .prev.
  const prevPath = `${path}.prev`;
  if (!existsSync(prevPath)) {
    throw new Error(`config.json parse failed (${primaryError}) and no .prev backup exists`);
  }
  try {
    const prevTxt = readFileSync(prevPath, "utf-8");
    const prevParsed = JSON.parse(prevTxt);
    // Recovery: copy .prev back to primary so the next boot uses it.
    copyFileSync(prevPath, path);
    return { config: prevParsed, source: "prev", primaryError };
  } catch (e: any) {
    throw new Error(
      `config.json parse failed (${primaryError}); .prev parse also failed (${String(e?.message || e)})`,
    );
  }
}

/** Merge a patch into the existing file config. Returns the new
 * config object — caller writes it. Defensive: clones the input so
 * the live mutable flag obj isn't accidentally shared with the
 * file representation. */
export function mergePatch(existing: any, patch: ConfigPatch): any {
  const next = JSON.parse(JSON.stringify(existing || {}));
  if (patch.model !== undefined) next.model = patch.model;
  if (patch.flags) {
    next.flags = { ...(next.flags || {}), ...patch.flags };
  }
  return next;
}

/** Build the masked config snapshot the node reports via
 * report_status's `config_snapshot` field. Strips secrets — env
 * `_envRef` placeholders stay opaque; nothing from `env` block at all
 * is included. Only model + the 6 dashboard-editable flags + role
 * (daemon discovery, see issue #338 / RFC-026 P2). */
export interface DaemonCapabilities {
  /** RFC-026 §9.3 — list of runtimes this daemon advertises support
   * for (declaration only; D2 spawn fail-fast catches "declared but
   * binary missing" at create-time). */
  runtimes_supported?: string[];
  /** RFC-026 §9.3 — env-var keys this daemon accepts in env_blob
   * (fail-closed default per §9.7). */
  allowed_secret_keys?: string[];
  /** RFC-026 §9 — hub backpressure cap (tools.ts daemon_max_children).
   * Daemon-side enforcement also uses this. Default 20 if unset. */
  max_concurrent_children?: number;
}

export interface MaskedSnapshot {
  model?: string | null;
  flags: Record<string, unknown>;
  config_revision?: number;
  config_update_capable: boolean;
  /** Node role surfaced to hub /api/nodes for daemon discovery (#337).
   * "host_supervisor" = anet daemon (receives create_node dispatches);
   * undefined / other values = regular agent-node. Read from config.json's
   * `role` field, narrow-typed (only string passes). */
  role?: string | null;
  /** Daemon-self-declare bundle. Nested under `daemon_capabilities`
   * because the hub's `create_node` tool already reads
   * `snapshot.daemon_capabilities.allowed_runtimes / .max_concurrent_children`
   * (tools.ts:2010/2075). PR1+PR2 mistakenly put the fields at the
   * top level → hub never saw them → max_concurrent_children stayed
   * the hardcoded 20 default + allowlist enforcement was bypassed.
   * 通信龙 nit ① decision: nest, don't delete. */
  daemon_capabilities?: DaemonCapabilities;
}
export function buildConfigSnapshot(
  fileConfig: any,
  configUpdateCapable: boolean,
  revision: number,
): MaskedSnapshot {
  const out: MaskedSnapshot = {
    model: typeof fileConfig?.model === "string" ? fileConfig.model : null,
    flags: {},
    config_revision: revision,
    config_update_capable: configUpdateCapable,
    role: typeof fileConfig?.role === "string" ? fileConfig.role : null,
  };
  // Self-declare nested under daemon_capabilities — only emit fields
  // when valid (typeof + Array.isArray narrow per
  // per team rule: any typed scalar extracted from untrusted JSON must be typeof-narrowed at the boundary; don't trust user JSON).
  const caps: DaemonCapabilities = {};
  const rt = fileConfig?.runtimes_supported;
  if (Array.isArray(rt) && rt.every((s: unknown) => typeof s === "string")) {
    caps.runtimes_supported = rt;
  }
  const ask = fileConfig?.allowed_secret_keys;
  if (Array.isArray(ask) && ask.every((s: unknown) => typeof s === "string")) {
    caps.allowed_secret_keys = ask;
  }
  const mc = fileConfig?.max_concurrent_children;
  if (typeof mc === "number" && Number.isFinite(mc) && mc > 0) {
    caps.max_concurrent_children = mc;
  }
  if (Object.keys(caps).length > 0) {
    out.daemon_capabilities = caps;
  }
  const f = (fileConfig?.flags || {}) as Record<string, unknown>;
  for (const k of ALLOWED_FLAGS) {
    if (k in f) out.flags[k] = f[k];
  }
  return out;
}
