/**
 * #1917 ① — in-flight heartbeat for long turns.
 *
 * A 16.4-minute grok turn wrote 11 node-log lines while grok's own log wrote
 * 224 of them; the longest observed node-log silence was 4492 s. From the
 * node log alone an operator can tell that a turn *started* and that it
 * *ended*, and nothing in between — so "it looks stuck" and "it is stuck"
 * read identically. This emits one line every `intervalMs` while a turn is
 * open, carrying the elapsed time and the most recent activity the runtime
 * surfaced.
 *
 * The timer is the dangerous part: a heartbeat that outlives its turn is a
 * leak that no gate can see (the job still succeeds). `stop()` is idempotent,
 * is called from a `finally`, and after it no further line is ever emitted.
 */

export interface TurnHeartbeatOptions {
  /** Emitter for the rendered line (node `log()` at the call site). */
  emit: (line: string) => void;
  /** Milliseconds between lines. Clamped to the 30–60 s band from #1917. */
  intervalMs?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable timer, for tests. */
  setIntervalFn?: (fn: () => void, ms: number) => unknown;
  clearIntervalFn?: (handle: unknown) => void;
  /** Label identifying the turn in the log line, e.g. `task 1a2b3c`. */
  label?: string;
}

export interface TurnHeartbeat {
  /** Record runtime activity; the next line reports it as `last=`. */
  note(activity: string): void;
  /** Stop emitting. Idempotent; safe to call from `finally` twice. */
  stop(): void;
  /** Count of lines emitted so far (tests/diagnostics). */
  emitted(): number;
  /** Whether the timer handle has been released. */
  stopped(): boolean;
}

export const HEARTBEAT_MIN_MS = 30_000;
export const HEARTBEAT_MAX_MS = 60_000;
export const HEARTBEAT_DEFAULT_MS = 45_000;

/** Clamp a requested cadence into the band the issue specified. */
export function resolveHeartbeatIntervalMs(requested?: number): number {
  if (!Number.isFinite(requested) || requested === undefined) return HEARTBEAT_DEFAULT_MS;
  return Math.min(HEARTBEAT_MAX_MS, Math.max(HEARTBEAT_MIN_MS, Math.floor(requested)));
}

/** Render `Xm Ys` from milliseconds; minutes are omitted below one minute. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

/**
 * Render one heartbeat line.
 *
 * Shape is fixed by #1917: `in-flight: loop=N, elapsed=Xm Ys, last=<activity>`.
 */
export function formatHeartbeatLine(opts: {
  loop: number;
  elapsedMs: number;
  activity?: string;
  label?: string;
}): string {
  const head = opts.label ? `in-flight ${opts.label}:` : "in-flight:";
  const last = opts.activity && opts.activity.trim() ? opts.activity.trim() : "no runtime activity yet";
  return `${head} loop=${opts.loop}, elapsed=${formatElapsed(opts.elapsedMs)}, last=${last}`;
}

/**
 * Start a heartbeat. Always pair with `stop()` in a `finally`.
 */
export function startTurnHeartbeat(opts: TurnHeartbeatOptions): TurnHeartbeat {
  const now = opts.now ?? Date.now;
  const setIntervalFn = opts.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn = opts.clearIntervalFn ?? ((handle) => clearInterval(handle as never));
  const intervalMs = resolveHeartbeatIntervalMs(opts.intervalMs);
  const startedAt = now();

  let loop = 0;
  let emitted = 0;
  let activity: string | undefined;
  let stopped = false;

  const handle = setIntervalFn(() => {
    if (stopped) return;
    loop += 1;
    emitted += 1;
    opts.emit(
      formatHeartbeatLine({ loop, elapsedMs: now() - startedAt, activity, label: opts.label }),
    );
  }, intervalMs);

  // A heartbeat must never be the reason a process stays alive.
  const maybeUnref = handle as { unref?: () => void } | undefined;
  if (maybeUnref && typeof maybeUnref.unref === "function") maybeUnref.unref();

  return {
    note(next: string) {
      if (typeof next === "string" && next.trim()) activity = next.trim();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(handle);
    },
    emitted() {
      return emitted;
    },
    stopped() {
      return stopped;
    },
  };
}
