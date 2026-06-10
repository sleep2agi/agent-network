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
};

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
