export interface RetireableGrokCopresenceRuntime {
  readonly isRunning: boolean;
  readonly state: { phase: string };
  close(): Promise<void>;
}

/**
 * Finish a terminal co-presence runtime before its owner replaces the cached
 * slot. A runtime doing its ordinary PTY recovery is deliberately retained.
 */
export async function retireStoppedGrokCopresenceRuntime<T extends RetireableGrokCopresenceRuntime>(
  runtime: T | null,
  hooks: {
    retire: (runtime: T) => void;
    warn?: (message: string) => void;
  },
): Promise<boolean> {
  if (!runtime || runtime.isRunning || runtime.state.phase === "recovering") return false;

  try {
    await runtime.close();
  } catch (error) {
    hooks.warn?.(
      `[grok-copresence] stopped runtime teardown reported: ${String((error as Error)?.message || error)}`,
    );
  }
  hooks.retire(runtime);
  return true;
}
