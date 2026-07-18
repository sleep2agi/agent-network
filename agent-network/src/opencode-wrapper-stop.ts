export type ExactProcessState = "same" | "exited-or-reused" | "unknown";

export interface TermOnlyExactProcessStopOptions {
  pid: number;
  /** Revalidate the caller's exact PID/start-time/argv receipt. */
  readState: () => ExactProcessState;
  timeoutMs?: number;
  pollMs?: number;
}

export type GracefulExactProcessSignal = "SIGTERM" | "SIGINT";

/**
 * Signal an exact process with a graceful signal only.
 *
 * Bound OpenCode's agent-node wrapper owns a detached ACP process group. If
 * the wrapper cannot run its async SIGTERM/SIGINT handler (for example it is
 * SIGSTOP'd or its event loop is wedged), SIGKILLing only the wrapper would
 * orphan that group. Therefore a timeout is a hard failure: leave the
 * wrapper and its descendants intact for inspection/retry, and never claim a
 * successful stop.
 */
export async function signalExactProcessGracefully(
  options: TermOnlyExactProcessStopOptions,
  signal: GracefulExactProcessSignal,
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  const pollMs = options.pollMs ?? 250;
  const initial = options.readState();
  if (initial === "exited-or-reused") return true;
  if (initial === "unknown") return false;

  try {
    process.kill(options.pid, signal);
  } catch {
    const afterError = options.readState();
    return afterError === "exited-or-reused";
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = options.readState();
    if (state === "exited-or-reused") return true;
    if (state === "unknown") return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return options.readState() === "exited-or-reused";
}

export function stopExactProcessTermOnly(
  options: TermOnlyExactProcessStopOptions,
): Promise<boolean> {
  return signalExactProcessGracefully(options, "SIGTERM");
}
