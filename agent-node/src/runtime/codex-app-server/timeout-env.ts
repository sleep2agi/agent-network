// Shared parser for the codex-app-server `ANET_*_TIMEOUT_MS` overrides
// (queue admission deadline, startup thread/resume deadline).

/** setTimeout overflows above 2^31-1 ms and would fire immediately. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * Whole milliseconds from an env value. Unset/empty -> `defaultMs`. Anything
 * that is not a positive integer within the timer range is ignored with one
 * warning per distinct value (tracked in `warned`), so a typo never silently
 * shortens or disables a deadline and a restart loop does not spam logs.
 */
export function resolveTimeoutEnvMs(
  name: string,
  raw: string | undefined,
  defaultMs: number,
  warned: Set<string>,
  warn: (m: string) => void = () => {},
): number {
  const value = raw?.trim();
  if (!value) return defaultMs;
  const ms = /^\d+$/.test(value) ? Number(value) : NaN;
  if (Number.isSafeInteger(ms) && ms > 0 && ms <= MAX_TIMER_MS) return ms;
  if (!warned.has(value)) {
    warned.add(value);
    warn(`[codex-app-server] ignoring ${name}=${JSON.stringify(value)} (expected whole milliseconds, 1..${MAX_TIMER_MS}); using default ${defaultMs}ms`);
  }
  return defaultMs;
}
