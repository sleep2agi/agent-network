export interface InboxDrainLane {
  schedule(run: () => Promise<void>): void;
  idle(): Promise<void>;
}

/**
 * Serialize work inside one inbox lane without blocking callers such as the
 * SSE reader. Separate lanes can continue independently: a long-running task
 * turn must not prevent a human-visible informational message from draining.
 */
export function createInboxDrainLane(onError: (error: unknown) => void): InboxDrainLane {
  let tail = Promise.resolve();

  return {
    schedule(run) {
      tail = tail.then(run).catch((error) => {
        onError(error);
      });
    },
    idle() {
      return tail;
    },
  };
}
