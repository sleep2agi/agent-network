export interface InboxDrainLane {
  schedule(run: () => Promise<void>): void;
  idle(): Promise<void>;
}

export interface InboxDrainRetryOptions {
  initialDelayMs: number;
  maxDelayMs: number;
}

/**
 * Attempt every item in one inbox snapshot before surfacing the first error.
 *
 * An informational inbox item can fail after its user-visible side effect
 * (for example, the toast succeeded but ack_inbox lost its response). If the
 * batch aborted immediately, that one row would head-of-line block every
 * later message until its retry succeeded. The lane still retries the batch,
 * but later items get one attempt during the current pass.
 */
export async function drainInboxBatch<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
): Promise<void> {
  let failed = false;
  let firstError: unknown;
  for (const item of items) {
    try {
      await run(item);
    } catch (error) {
      if (!failed) firstError = error;
      failed = true;
    }
  }
  if (failed) throw firstError;
}

/**
 * Serialize work inside one inbox lane without blocking callers such as the
 * SSE reader. Separate lanes can continue independently: a long-running task
 * turn must not prevent a human-visible informational message from draining.
 */
export function createInboxDrainLane(
  onError: (error: unknown) => void,
  retry?: InboxDrainRetryOptions,
): InboxDrainLane {
  let tail = Promise.resolve();
  const scheduled = new Map<() => Promise<void>, { dirty: boolean }>();

  const execute = async (run: () => Promise<void>) => {
    let delayMs = retry?.initialDelayMs ?? 0;
    while (true) {
      try {
        await run();
        return;
      } catch (error) {
        onError(error);
        if (!retry) return;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delayMs);
          timer.unref?.();
        });
        delayMs = Math.min(delayMs * 2, retry.maxDelayMs);
      }
    }
  };

  return {
    schedule(run) {
      const existing = scheduled.get(run);
      if (existing) {
        // The active execution re-reads the inbox on every retry. Remember
        // that another SSE/startup wake arrived, but do not append an
        // unbounded chain of identical closures behind a persistent failure.
        existing.dirty = true;
        return;
      }
      const state = { dirty: false };
      scheduled.set(run, state);
      const drain = async () => {
        try {
          do {
            state.dirty = false;
            await execute(run);
          } while (state.dirty);
        } finally {
          scheduled.delete(run);
        }
      };
      // A defensive rejection branch keeps one unexpected callback failure
      // from poisoning every later drain in this lane.
      tail = tail.then(drain, drain);
    },
    idle() {
      return tail;
    },
  };
}
