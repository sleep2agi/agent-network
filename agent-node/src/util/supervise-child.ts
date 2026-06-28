// Shared supervisor loop for long-running children that may die and need to
// be respawned (a forked worker, an SSE stream reader, a websocket
// connection, …). Both `connectFeishu` (forked worker) and `connectSSE`
// (fetch stream reader) re-implemented the same while-loop + exponential-
// backoff + jitter + stable-uptime-reset pattern with subtle differences;
// this helper consolidates the pattern so adding the next channel-class
// supervisor (wechat / discord / a second hub stream) is a few lines of
// glue, not another copy-paste of the supervisor body.
//
// Contract
// ========
//   superviseChild({label, runOnce, shutdownGate, ...})
//
// `runOnce(ctrl)` runs ONE iteration of the supervised child:
//   - for connectFeishu: spawn a worker subprocess + await its exit
//   - for connectSSE: open a fetch stream + drain it until EOF
// The supervisor calls `runOnce` again after each iteration ends, with
// jittered exponential backoff between iterations.
//
// The controller passed to runOnce exposes `markStable()`. Callers invoke
// this when the iteration has crossed the threshold that counts as
// "actually working" — for connectFeishu it's the worker surviving for
// `stableResetMs`; for connectSSE it's receiving the "connected" event
// (NOT just fetch returning 200, because a hub that 200s then drops the
// stream immediately is not "stable"). markStable resets the backoff to
// `baseDelayMs` AND zeroes the cumulative-downtime counter.
//
// Exceptions thrown by `runOnce` are caught and logged via `opts.onError`;
// they do NOT terminate the supervisor — the next iteration is scheduled
// per backoff. This mirrors the pre-fix connectSSE behaviour (a `catch
// (err)` inside the body that just warned and continued the outer while).
// To intentionally stop the supervisor, set the shutdown gate to true.
//
// Shutdown
// ========
// `shutdownGate()` is consulted (1) before every new iteration and
// (2) after every iteration ends. If true, the supervisor returns
// without scheduling another iteration. The helper does NOT signal /
// kill the child itself — that responsibility stays with the caller's
// top-level shutdown hook (which knows whether it's holding a child
// process handle, a fetch reader, etc.). This keeps the helper free
// of child_process / fetch-specific surface.

/**
 * Per-iteration controller passed into `runOnce`. Today exposes only
 * `markStable`; a future stop-the-current-iteration affordance would
 * be a sibling field on this interface.
 */
export interface SupervisedIterationController {
  /**
   * Signal that this iteration crossed the "actually working" threshold.
   * Resets the backoff to `baseDelayMs` and zeroes the cumulative
   * downtime counter. Safe to call multiple times per iteration — only
   * the first call has effect within a single iteration.
   */
  markStable(): void;
}

export interface SuperviseChildOpts {
  /** Short label for log / error messages. e.g. "feishu" / "sse". */
  label: string;
  /** Returns true when the supervisor should stop without rescheduling. */
  shutdownGate: () => boolean;
  /**
   * One iteration of the supervised child. Resolves when the iteration
   * ends (child exits / stream closes); throws to log + reschedule.
   * Receives a controller for the iteration to call `markStable` on
   * once the work crosses its "really working" threshold.
   */
  runOnce: (ctrl: SupervisedIterationController) => Promise<void>;
  /** Initial backoff delay in ms. Default 1_000. */
  baseDelayMs?: number;
  /** Maximum backoff after exponential growth. Default 30_000. */
  maxDelayMs?: number;
  /**
   * Jitter ratio (±N×delay). Default 0.25 (±25%). Set 0 to disable.
   * The waited time per backoff is `max(100, delay + delay * jitter *
   * (Math.random() * 2 - 1))`.
   */
  jitterRatio?: number;
  /**
   * If cumulative downtime (consecutive iterations that did NOT call
   * markStable, plus their inter-iteration sleeps) exceeds this, the
   * supervisor invokes `onAbandon` and returns. Default `Infinity`
   * (never abandon). Set to a finite value (e.g. 3_600_000 = 1 h) to
   * give up after a long unsuccessful run.
   */
  abandonAfterMs?: number;
  /** Called once if the supervisor abandons. */
  onAbandon?: () => void;
  /** Called with the runOnce error before scheduling the next iteration. */
  onError?: (err: unknown) => void;
  /** Called before sleeping with the resolved backoff (and the jittered wait). */
  onRetryWait?: (waitMs: number, backoffMs: number) => void;
  /**
   * Sleep primitive — overridden by tests to skip real timers. Default
   * uses `setTimeout`. Must respect `ms <= 0` as "no wait".
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Random source — overridden by tests for deterministic jitter.
   * Default `Math.random`.
   */
  random?: () => number;
  /** Current-time source — overridden by tests. Default `Date.now`. */
  now?: () => number;
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

/**
 * Run the supervisor loop. Resolves when the shutdown gate triggers or
 * the abandon threshold fires; never throws (runOnce errors are routed
 * to `onError`).
 */
export async function superviseChild(opts: SuperviseChildOpts): Promise<void> {
  const baseDelayMs = opts.baseDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const jitterRatio = opts.jitterRatio ?? 0.25;
  const abandonAfterMs = opts.abandonAfterMs ?? Number.POSITIVE_INFINITY;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  const now = opts.now ?? Date.now;

  let delay = baseDelayMs;
  let downSince: number | null = null;

  while (!opts.shutdownGate()) {
    let stable = false;
    const ctrl: SupervisedIterationController = {
      markStable() {
        if (stable) return;
        stable = true;
        delay = baseDelayMs;
        downSince = null;
      },
    };

    try {
      await opts.runOnce(ctrl);
    } catch (err) {
      opts.onError?.(err);
    }

    if (opts.shutdownGate()) break;

    if (!stable) {
      if (downSince === null) downSince = now();
      if (now() - downSince > abandonAfterMs) {
        opts.onAbandon?.();
        return;
      }
    }

    // Jittered sleep, then double the backoff (capped). The min 100 ms
    // floor matches the pre-helper connectFeishu behaviour and avoids
    // a hot-loop edge case if a caller sets baseDelayMs very small.
    const jitterDelta = jitterRatio > 0 ? delay * jitterRatio * (random() * 2 - 1) : 0;
    const waitMs = Math.max(100, Math.round(delay + jitterDelta));
    opts.onRetryWait?.(waitMs, delay);
    await sleep(waitMs);
    delay = Math.min(delay * 2, maxDelayMs);
  }
}
