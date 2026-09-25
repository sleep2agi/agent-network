import { resolveTimeoutMs, type TimeoutResolveResult } from "../util/timeout";

/**
 * Default opencode task deadline. Agentic coding tasks routinely run a
 * clone + build + test cycle that outlasts 5 minutes; the old hard-coded
 * 300s made the copresence bridge report a failure while the turn kept
 * running in the TUI. 30 min covers a cold docker build plus a test run and
 * still bounds a wedged turn; `0` disables it.
 */
export const OPENCODE_DEFAULT_TASK_TIMEOUT_MS = 30 * 60_000;

export interface OpencodeTimeoutResolution extends TimeoutResolveResult {
  /** Which knob won, for the startup log line. */
  sourceLabel: string;
}

function flagNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

/**
 * Task deadline for the opencode runtime (copresence: wall-clock budget per
 * network task; headless ACP: idle budget between protocol frames).
 *
 * Precedence mirrors claude/codex: env `OPENCODE_TIMEOUT_MS` > RFC-024
 * canonical `flags.timeout` (the key the Dashboard edits, so a Dashboard
 * change is never shadowed) > runtime-specific `flags.opencodeTimeoutMs` >
 * default 30 min. `0` disables the deadline; negative / non-numeric values
 * fall through to the next source.
 */
export function resolveOpencodeTimeout(input: {
  env?: string | undefined;
  flags?: { timeout?: unknown; opencodeTimeoutMs?: unknown } | undefined;
}): OpencodeTimeoutResolution {
  const canonical = flagNumber(input.flags?.timeout);
  const specific = flagNumber(input.flags?.opencodeTimeoutMs);
  const canonicalUsable = canonical !== undefined && Number.isFinite(canonical) && canonical >= 0;
  const result = resolveTimeoutMs({
    envValue: input.env,
    flagValue: canonicalUsable ? canonical : specific,
    defaultMs: OPENCODE_DEFAULT_TASK_TIMEOUT_MS,
  });
  const sourceLabel = result.source === "env"
    ? "env OPENCODE_TIMEOUT_MS"
    : result.source === "flag"
      ? (canonicalUsable ? "flags.timeout" : "flags.opencodeTimeoutMs")
      : "default";
  return { ...result, sourceLabel };
}

export function describeOpencodeTimeout(r: OpencodeTimeoutResolution): string {
  return r.valueMs > 0
    ? `${r.valueMs}ms (${Math.round(r.valueMs / 60_000 * 10) / 10}min) source=${r.sourceLabel}`
    : `disabled (0) source=${r.sourceLabel}`;
}
