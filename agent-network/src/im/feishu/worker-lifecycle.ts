interface WorkerProcessBoundary {
  stderr: { write(message: string): unknown };
  exit(code: number): unknown;
}

/**
 * A terminal WS error means this worker no longer owns a live ingress path.
 * Exit non-zero so the parent/supervisor cannot continue advertising it as
 * healthy. Kept separate from worker.ts so the real exit contract is testable.
 */
export function exitFeishuWorker(
  error: Error,
  boundary: WorkerProcessBoundary = process,
): void {
  boundary.stderr.write(
    `[feishu:worker] connection failed after ready: ${error.message}\n`,
  );
  boundary.exit(1);
}
