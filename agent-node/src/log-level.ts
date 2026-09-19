/**
 * #1917 ③ — log level resolution.
 *
 * 🔴 The issue said there is no log-level knob. That is half right and the
 * half that is wrong matters: `--log-level`, `LOG_LEVEL` and `config.logLevel`
 * have always worked. What was missing is (a) an `ANET_`-prefixed name, which
 * is where operators look because every other knob in this product lives
 * there, and (b) any feedback at all when the value is garbage — the old
 * expression ended in `?? 1`, so `LOG_LEVEL=quiet` silently meant `info` and
 * the operator's mental model stayed wrong until something else broke.
 */

export const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
export type LogLevelName = keyof typeof LOG_LEVELS;

export const DEFAULT_LOG_LEVEL: LogLevelName = "info";

export interface LogLevelResolution {
  /** Numeric threshold consumed by the logger. */
  level: number;
  /** Canonical name of the resolved level. */
  name: LogLevelName;
  /** Which input won, for diagnostics. */
  source: "flag" | "ANET_LOG_LEVEL" | "LOG_LEVEL" | "config" | "default";
  /**
   * Set when a caller supplied a value that is not a level name. The caller
   * logs it once, then proceeds at the default — an unreadable knob must not
   * stop a node from starting.
   */
  warning?: string;
}

export interface LogLevelInputs {
  flagValue?: unknown;
  anetEnvValue?: unknown;
  envValue?: unknown;
  configValue?: unknown;
}

function normalize(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/**
 * Resolve the effective log level.
 *
 * Precedence: `--log-level` flag → `ANET_LOG_LEVEL` → `LOG_LEVEL` →
 * `config.logLevel` → `info`. The first input that is *present* decides
 * whether we accept it or report it as invalid; a bad higher-precedence value
 * is not silently overridden by a good lower-precedence one, because that
 * would hide the operator's typo behind someone else's setting.
 */
export function resolveLogLevel(inputs: LogLevelInputs = {}): LogLevelResolution {
  const candidates: Array<{ source: LogLevelResolution["source"]; raw: string; label: string }> = [];
  const flag = normalize(inputs.flagValue);
  if (flag) candidates.push({ source: "flag", raw: flag, label: "--log-level" });
  const anet = normalize(inputs.anetEnvValue);
  if (anet) candidates.push({ source: "ANET_LOG_LEVEL", raw: anet, label: "ANET_LOG_LEVEL" });
  const env = normalize(inputs.envValue);
  if (env) candidates.push({ source: "LOG_LEVEL", raw: env, label: "LOG_LEVEL" });
  const cfg = normalize(inputs.configValue);
  if (cfg) candidates.push({ source: "config", raw: cfg, label: "config.logLevel" });

  const winner = candidates[0];
  if (!winner) {
    return { level: LOG_LEVELS[DEFAULT_LOG_LEVEL], name: DEFAULT_LOG_LEVEL, source: "default" };
  }

  if (winner.raw in LOG_LEVELS) {
    const name = winner.raw as LogLevelName;
    return { level: LOG_LEVELS[name], name, source: winner.source };
  }

  return {
    level: LOG_LEVELS[DEFAULT_LOG_LEVEL],
    name: DEFAULT_LOG_LEVEL,
    source: "default",
    warning:
      `${winner.label}=${JSON.stringify(winner.raw)} is not a log level ` +
      `(expected ${Object.keys(LOG_LEVELS).join(" | ")}); using ${DEFAULT_LOG_LEVEL}`,
  };
}
