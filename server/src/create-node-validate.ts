// RFC-026 v4 §4.2.2 (F2 structured) + §4.4.7 (C1+B1 env_refs) + §4.2.6
// (B2 fork wrapper) — pure validators + arg builder. No DB access. Used
// by hub create_node MCP tool (RPC entry) AND by daemon get_create_request
// (re-check, defense in depth).
//
// All validation errors throw ValidationError with a stable `code` field
// that the MCP tool surface maps to a JSON {ok:false, error: <code>}
// payload (RFC §4.6).

import { isReservedEnvKey } from "./shared/reserved-env.js";

export class ValidationError extends Error {
  constructor(public code: string, public detail?: Record<string, unknown>) {
    super(`${code}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
    this.name = "ValidationError";
  }
}

// §4.2.2 — structural enums.
export const RUNTIMES = ["claude-agent-sdk", "codex-sdk", "grok-build-acp"] as const;
export type Runtime = typeof RUNTIMES[number];

export const FLAG_KEYS = ["permissionMode", "dangerouslySkipPermissions", "maxTurns", "budget", "timeout"] as const;
export type FlagKey = typeof FLAG_KEYS[number];

export const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;

// §4.4.7 — env_refs limits.
export const MAX_ENV_KEYS_PER_NODE = 32;
export const MAX_ENV_VALUE_BYTES = 16 * 1024;
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

// §4.2.2 name + model.
const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const MODEL_RE = /^[a-zA-Z0-9._:\-]+$/;

export function validateName(s: unknown): asserts s is string {
  if (typeof s !== "string" || !NAME_RE.test(s)) {
    throw new ValidationError("node_name_invalid", { value: typeof s === "string" ? s.slice(0, 80) : typeof s });
  }
}

export function validateRuntime(s: unknown): asserts s is Runtime {
  if (typeof s !== "string" || !(RUNTIMES as readonly string[]).includes(s)) {
    throw new ValidationError("runtime_invalid", { value: typeof s === "string" ? s.slice(0, 80) : typeof s });
  }
}

export function validateModel(s: unknown): asserts s is string {
  if (typeof s !== "string" || s.length === 0 || s.length > 100 || !MODEL_RE.test(s)) {
    throw new ValidationError("model_invalid", { value: typeof s === "string" ? s.slice(0, 80) : typeof s });
  }
}

export function validateFlagValue(k: string, v: unknown): void {
  switch (k) {
    case "permissionMode":
      if (typeof v !== "string" || !(PERMISSION_MODES as readonly string[]).includes(v)) {
        throw new ValidationError("flag_value_invalid", { field: k, reason: "must be one of default/acceptEdits/plan/bypassPermissions" });
      }
      return;
    case "dangerouslySkipPermissions":
      if (typeof v !== "boolean") throw new ValidationError("flag_value_invalid", { field: k, reason: "must be boolean" });
      return;
    case "maxTurns":
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 9999) {
        throw new ValidationError("flag_value_invalid", { field: k, reason: "must be integer 1..9999" });
      }
      return;
    case "budget":
      if (typeof v !== "number" || !Number.isFinite(v) || (v as number) < 0 || (v as number) > 1000) {
        throw new ValidationError("flag_value_invalid", { field: k, reason: "must be number 0..1000 (decimals OK)" });
      }
      return;
    case "timeout":
      if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 86400) {
        throw new ValidationError("flag_value_invalid", { field: k, reason: "must be integer 1..86400" });
      }
      return;
    default:
      throw new ValidationError("flag_key_unknown", { field: k });
  }
}

// §4.4.7 — env_refs 7-step gate. networkSecretsGet is injected so
// callers can supply either a real DB lookup (hub) or a fixture (tests).
// The 6th step also reports the resolved value size; we return the
// resolved-but-not-yet-used map keyed by env-key so the caller can build
// env_blob without re-querying.
export interface EnvRefsContext {
  callerNetworkId: string;
  daemonAllowList: ReadonlySet<string>;
  networkSecretsGet: (networkId: string, key: string) => string | undefined;
}
export function validateEnvRefs(
  refs: unknown,
  ctx: EnvRefsContext,
): Record<string, string> {
  if (!Array.isArray(refs)) {
    if (refs === undefined || refs === null) return {};
    throw new ValidationError("env_refs_invalid", { reason: "must be array" });
  }
  // ① regex
  for (const k of refs) {
    if (typeof k !== "string" || !ENV_KEY_RE.test(k)) {
      throw new ValidationError("env_key_invalid", { key: typeof k === "string" ? k.slice(0, 64) : typeof k });
    }
  }
  // ② reserved denylist (v4 B1)
  for (const k of refs) {
    if (isReservedEnvKey(k)) {
      throw new ValidationError("env_key_reserved", { key: k });
    }
  }
  // ③ duplicate detection (must come before ④ count gate to give a
  //    truthful error code rather than "too many" for dup-spam).
  const seen = new Set<string>();
  for (const k of refs as string[]) {
    if (seen.has(k)) throw new ValidationError("env_key_duplicate", { key: k });
    seen.add(k);
  }
  // ④ count cap
  if (seen.size > MAX_ENV_KEYS_PER_NODE) {
    throw new ValidationError("env_key_too_many", { count: seen.size, max: MAX_ENV_KEYS_PER_NODE });
  }
  const out: Record<string, string> = {};
  // ⑤ vault presence + ⑥ value size cap
  for (const k of seen) {
    const v = ctx.networkSecretsGet(ctx.callerNetworkId, k);
    if (v === undefined) throw new ValidationError("secret_not_in_vault", { key: k });
    if (Buffer.byteLength(v, "utf8") > MAX_ENV_VALUE_BYTES) {
      throw new ValidationError("secret_too_large", { key: k, max: MAX_ENV_VALUE_BYTES });
    }
    out[k] = v;
  }
  // ⑦ daemon allowlist (per-host whitelist of which secrets this
  //    machine is allowed to receive; declared in daemon config by the
  //    host operator)
  for (const k of seen) {
    if (!ctx.daemonAllowList.has(k)) {
      throw new ValidationError("secret_not_in_daemon_allowlist", { key: k });
    }
  }
  return out;
}

// §4.4.7 — safe serializer for .env.local. Dotenv-quoted with escape
// for backslash / double-quote / newline / carriage-return so that a
// value containing `\n"evil=KEY2"` cannot pollute the next line.
export function serializeEnvLocal(env: Record<string, string>): string {
  return Object.entries(env).map(([k, v]) => {
    const esc = String(v)
      .replace(/\\/g, "\\\\")   // 1) backslashes first (or later escapes get un-escaped)
      .replace(/"/g, '\\"')     // 2) double-quotes
      .replace(/\n/g, "\\n")    // 3) newline → literal \n
      .replace(/\r/g, "\\r");   // 4) carriage return → literal \r
    return `${k}="${esc}"`;
  }).join("\n") + "\n";
}

// §4.2.5 — channels fail-closed in P1.
export function validateChannelsP1(channels: unknown): void {
  if (channels === undefined || channels === null) return;
  if (!Array.isArray(channels)) {
    throw new ValidationError("channels_not_supported_in_p1", { reason: "expected array or omitted" });
  }
  if (channels.length > 0) {
    throw new ValidationError("channels_not_supported_in_p1", { received: channels.length, p3_tracker: "RFC-026 §5 P3" });
  }
}

// §4.2.2 — fully validated NodeSpec, ready to feed into buildAnetArgs.
export interface NodeSpec {
  name: string;
  runtime: Runtime;
  model: string;
  flags?: Record<string, unknown>;
  channels?: unknown;
}

// kebab-case helper for flag names. permissionMode → permission-mode.
function kebab(k: string): string {
  return k.replace(/([A-Z])/g, "-$1").toLowerCase();
}

// §4.2.2 — build the argv that gets fed verbatim to execFile (no
// shell, no string concat). Each value has already passed type/enum
// validation, so String() coercion is safe.
export function buildAnetArgs(spec: NodeSpec): string[] {
  validateName(spec.name);
  validateRuntime(spec.runtime);
  validateModel(spec.model);
  validateChannelsP1(spec.channels);

  const args: string[] = ["node", "create", spec.name, "--runtime", spec.runtime, "--model", spec.model];
  if (spec.flags && typeof spec.flags === "object") {
    for (const [k, v] of Object.entries(spec.flags)) {
      if (!(FLAG_KEYS as readonly string[]).includes(k)) {
        throw new ValidationError("flag_key_unknown", { field: k });
      }
      validateFlagValue(k, v);
      args.push(`--${kebab(k)}`, String(v));
    }
  }
  return args;
}
