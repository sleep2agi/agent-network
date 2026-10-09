/**
 * SIGTERM delivery is not process exit. Retry the existing identity/live-process
 * guarded cleanup while an attached TUI drains; never force deletion or signal
 * additional processes. The caller retains the root on timeout/unknown state.
 */
export async function cleanupAfterExit(
  cleanup: () => boolean,
  wait: (ms: number) => Promise<void> = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<boolean> {
  const deadline = performance.now() + 5_000;
  for (let attempt = 0; ; attempt++) {
    if (cleanup()) return true;
    const remaining = deadline - performance.now();
    if (attempt >= 50 || remaining <= 0) return false;
    await wait(Math.min(100, remaining));
  }
}
