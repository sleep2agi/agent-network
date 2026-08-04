import { createSingleFlight } from "../../util/single-flight";

export interface RunningCodexSession {
  readonly isRunning: boolean;
}

/**
 * Owns the one shared Codex app-server bridge used by all inbox handlers.
 *
 * Dashboard rows are deliberately dispatched without awaiting the previous
 * model turn.  That means several handlers can reach lazy initialization at
 * once.  The holder must therefore coalesce the whole open/bootstrap/recover
 * sequence, not just cache its eventual result, or each row gets a different
 * bridge and silently bypasses the bridge's FIFO.
 */
export function createCodexSessionManager<T extends RunningCodexSession>() {
  let current: T | null = null;
  const opening = createSingleFlight<T>();

  return {
    async getOrOpen(factory: () => Promise<T>): Promise<T> {
      if (current?.isRunning) return current;
      return opening.run(async () => {
        if (current?.isRunning) return current;
        current = null;
        const opened = await factory();
        if (!opened.isRunning) {
          throw new Error("codex app-server session stopped while opening");
        }
        current = opened;
        return opened;
      });
    },

    invalidate(session?: T | null): void {
      if (!session || current === session) current = null;
    },

    current(): T | null {
      return current;
    },

    pending(): Promise<T> | null {
      return opening.pending();
    },
  };
}
