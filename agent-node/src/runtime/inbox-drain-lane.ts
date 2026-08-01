export interface InboxDrainLane {
  schedule(run: () => Promise<void>): void;
  idle(): Promise<void>;
}

export interface InboxDrainRetryOptions {
  initialDelayMs: number;
  maxDelayMs: number;
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
      tail = tail.then(() => execute(run));
    },
    idle() {
      return tail;
    },
  };
}
