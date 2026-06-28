// Unified timeout primitive for runtime turns + telegram long-poll + think()
// queue. Single shape consumed by claude / codex / grok / telegram so the
// timeout semantics (and the abort-signal contract that propagates into
// fetch / AbortController-aware code) are identical across every call site.
//
// Pre-redirect: each runtime carried its own deadline shape — claude an
// inline AbortController + setTimeout pair, codex no wall-clock deadline at
// all (zero guard against a wedged turn), grok-build-acp a single 300s
// `timeoutMs` reused for BOTH handshake (initialize / authenticate /
// session/new) and the long-running session/prompt (the latter rightly
// stays on its idle-timeout path; the former should fail fast at ~45s).
// Telegram getUpdates relied on the server-side `timeout=30` and was
// unprotected against a wedged TCP socket.
//
// This util gives each call site:
//   - a hard wall-clock deadline + a TimeoutError carrying the label
//   - an AbortSignal it can plug into fetch() / AbortController-aware libs
//   - the zero-deadline sentinel (`timeoutMs <= 0` disables the timer)
//
// Plus `resolveTimeoutMs(envValue, flagValue, defaultMs)` for the
// "env > flag > default" precedence already in use in
// resolveGrokAcpTimeout, generalised so future runtime knobs follow the
// same precedence without each runtime re-implementing it.

/**
 * Error thrown when {@link withTimeout} hits its deadline. Carries the
 * label + ms so log/handler code can surface the failing call site
 * without re-stringifying the message.
 */
export class TimeoutError extends Error {
  readonly label?: string;
  readonly timeoutMs: number;
  constructor(timeoutMs: number, label?: string) {
    super(`${label ? `[${label}] ` : ""}timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Race `fn(signal)` against a wall-clock timer. The factory receives an
 * AbortSignal that fires when the timeout elapses so the caller can
 * cancel in-flight work (fetch / AbortController-aware SDKs).
 *
 * Resolves with the factory's value if it settles first.
 * Rejects with {@link TimeoutError} if the timer fires first.
 *
 * If `timeoutMs <= 0`, the timeout is disabled (`fn` runs with a
 * never-aborted signal). This preserves the pre-existing
 * `CLAUDE_TIMEOUT_MS=0 → no deadline` sentinel.
 *
 * If a pre-existing AbortSignal is supplied via `opts.externalSignal`,
 * abortion from that signal is propagated into the factory's signal
 * (allowing callers to participate in caller-supplied cancellation).
 */
export interface WithTimeoutOpts {
  externalSignal?: AbortSignal;
}

export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  label?: string,
  opts?: WithTimeoutOpts,
): Promise<T> {
  const ac = new AbortController();
  let onExternalAbort: (() => void) | undefined;
  if (opts?.externalSignal) {
    if (opts.externalSignal.aborted) ac.abort();
    else {
      onExternalAbort = () => ac.abort();
      opts.externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }
  }

  if (timeoutMs <= 0) {
    try {
      return await fn(ac.signal);
    } finally {
      if (onExternalAbort && opts?.externalSignal) {
        opts.externalSignal.removeEventListener("abort", onExternalAbort);
      }
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new TimeoutError(timeoutMs, label));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(ac.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onExternalAbort && opts?.externalSignal) {
      opts.externalSignal.removeEventListener("abort", onExternalAbort);
    }
  }
}

/**
 * Resolve a timeout knob from (env > flag > default) with bounds
 * clamping. Mirrors and generalises `resolveGrokAcpTimeout`.
 *
 * - `envValue`: raw string from `process.env.X` (parsed as integer ms).
 *   Non-numeric / negative / empty values fall through to flag.
 * - `flagValue`: number from `config.json.flags.X`. Non-finite / negative
 *   values fall through to default.
 * - `defaultMs`: required fallback.
 * - `minMs` / `maxMs`: optional bounds (clamping reported via `clamped`).
 *
 * Returns the resolved value plus the source label (useful for boot
 * logging) and a `clamped` flag (useful for "config out of bounds"
 * warnings).
 */
export interface TimeoutResolveOpts {
  envValue?: string | undefined | null;
  flagValue?: number | undefined | null;
  defaultMs: number;
  minMs?: number;
  maxMs?: number;
}

export interface TimeoutResolveResult {
  valueMs: number;
  source: "env" | "flag" | "default";
  clamped: boolean;
}

export function resolveTimeoutMs(opts: TimeoutResolveOpts): TimeoutResolveResult {
  const minMs = opts.minMs ?? 0;
  const maxMs = opts.maxMs ?? Number.MAX_SAFE_INTEGER;
  const clamp = (n: number): { value: number; clamped: boolean } => {
    if (n < minMs) return { value: minMs, clamped: true };
    if (n > maxMs) return { value: maxMs, clamped: true };
    return { value: n, clamped: false };
  };
  if (opts.envValue !== undefined && opts.envValue !== null && opts.envValue !== "") {
    const n = Number(opts.envValue);
    if (Number.isFinite(n) && n >= 0) {
      const c = clamp(n);
      return { valueMs: c.value, source: "env", clamped: c.clamped };
    }
  }
  if (
    typeof opts.flagValue === "number" &&
    Number.isFinite(opts.flagValue) &&
    opts.flagValue >= 0
  ) {
    const c = clamp(opts.flagValue);
    return { valueMs: c.value, source: "flag", clamped: c.clamped };
  }
  const c = clamp(opts.defaultMs);
  return { valueMs: c.value, source: "default", clamped: c.clamped };
}
