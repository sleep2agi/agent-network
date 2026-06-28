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
} from "node:fs";

/** Sentinel exit code for "supervisor please restart me with the new
 * config" — borrows BSD EX_TEMPFAIL semantics. The parent supervisor
 * (W1, see launchAgent wrap) keys on this exact code to differentiate
 * restart-intent from a fatal exit. */
export const RESTART_SENTINEL = 75;

/** Defense-in-depth local validation. Same allowlist as hub but
 * intentionally duplicated — if hub validator drifts loose, the node
 * still refuses anything outside this set. */
const ALLOWED_FLAGS = new Set<string>([
  "permissionMode",
  "dangerouslySkipPermissions",
  "teammateMode",
  "maxTurns",
  "budget",
  "timeout",
]);

const RESTART_REQUIRED_FLAGS = new Set<string>([
  "permissionMode",
  "dangerouslySkipPermissions",
  "teammateMode",
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
      case "teammateMode":
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
 * left half-written. */
export function atomicWriteJson(path: string, data: unknown): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, path);
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
 * is included. Only model + the 6 dashboard-editable flags. */
export interface MaskedSnapshot {
  model?: string | null;
  flags: Record<string, unknown>;
  config_revision?: number;
  config_update_capable: boolean;
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
  };
  const f = (fileConfig?.flags || {}) as Record<string, unknown>;
  for (const k of ALLOWED_FLAGS) {
    if (k in f) out.flags[k] = f[k];
  }
  return out;
}
