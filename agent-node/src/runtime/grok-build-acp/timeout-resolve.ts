// #214 维度 5 A6 — surface where the grok-build-acp `session/prompt`
// idle timeout actually came from. Config accepting a value is not the
// same as the runtime using that value, and operators have hit cases
// where `flags.grokAcpTimeoutMs` looked correct in the node's config.json
// but the runtime was silently falling through to the default because of
// a type mismatch or env override they had forgotten about.
//
// The resolver below mirrors the existing precedence in cli.ts —
// `process.env.GROK_ACP_TIMEOUT_MS` wins, then `flags.<flagKey>`, then
// `defaultMs` — but returns the source label so the startup banner can
// say *exactly* which knob is in effect.

export type ResolvedAcpTimeout = {
  valueMs: number;
  source: "env" | "flags" | "default";
  rawValue?: string;
  /** 实际生效的配置键名（用于启动横幅），例如 `flags.acpIdleTimeoutMs`。 */
  knob?: string;
};

/**
 * ACP 通用空闲超时（grok 与 antigravity 共用）。
 *
 * 优先级：`ACP_IDLE_TIMEOUT_MS` > `flags.acpIdleTimeoutMs`
 *        > `GROK_ACP_TIMEOUT_MS` > `flags.grokAcpTimeoutMs` > default。
 *
 * 后两项是历史键名，grok 节点继续可用；但 antigravity 节点不该再被迫使用
 * 带 grok 前缀的开关（真机报错就让人去改 `flags.grokAcpTimeoutMs`）。
 */
export function resolveAcpIdleTimeout(opts: {
  envValue?: string | null;
  flagValue?: string | number | null;
  legacyEnvValue?: string | null;
  legacyFlagValue?: string | number | null;
  defaultMs: number;
}): ResolvedAcpTimeout {
  const genericEnv = parseNumeric(opts.envValue);
  if (genericEnv !== null) {
    return { valueMs: genericEnv, source: "env", rawValue: String(opts.envValue), knob: "ACP_IDLE_TIMEOUT_MS" };
  }
  const genericFlag = parseNumeric(opts.flagValue);
  if (genericFlag !== null) {
    return { valueMs: genericFlag, source: "flags", rawValue: String(opts.flagValue), knob: "flags.acpIdleTimeoutMs" };
  }
  const legacyEnv = parseNumeric(opts.legacyEnvValue);
  if (legacyEnv !== null) {
    return { valueMs: legacyEnv, source: "env", rawValue: String(opts.legacyEnvValue), knob: "GROK_ACP_TIMEOUT_MS" };
  }
  const legacyFlag = parseNumeric(opts.legacyFlagValue);
  if (legacyFlag !== null) {
    return { valueMs: legacyFlag, source: "flags", rawValue: String(opts.legacyFlagValue), knob: "flags.grokAcpTimeoutMs" };
  }
  return { valueMs: opts.defaultMs, source: "default" };
}

export function resolveGrokAcpTimeout(opts: {
  envValue?: string | null;
  flagValue?: string | number | null;
  defaultMs: number;
}): ResolvedAcpTimeout {
  const env = parseNumeric(opts.envValue);
  if (env !== null) return { valueMs: env, source: "env", rawValue: String(opts.envValue) };

  const flag = parseNumeric(opts.flagValue);
  if (flag !== null) return { valueMs: flag, source: "flags", rawValue: String(opts.flagValue) };

  return { valueMs: opts.defaultMs, source: "default" };
}

// Accepts strings and numbers; rejects empty strings, NaN, and negative
// values (those silently fell through before — the operator may think
// they set a 0/`"0"` to "disable" but the result was the same as not
// setting anything, which is confusing).
function parseNumeric(raw: unknown): number | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  }
  if (typeof raw === "string") {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}
