export type TaskRuntimeEvidenceLevel = "submitted" | "consumed";

export interface TaskRuntimeEvidenceReporterOptions {
  taskId: string | null;
  report: (level: TaskRuntimeEvidenceLevel, taskId: string) => Promise<unknown>;
  debug?: (message: string) => void;
}

export interface TaskRuntimeEvidenceReporter {
  /** The exact task body crossed the runtime adapter's submission boundary. */
  submitted(): void;
  /** Exact turn-start or attributable runtime activity was observed. */
  consumed(): void;
}

export function logicalTaskIdFromInbox(message: {
  id: unknown;
  task_id?: unknown;
  type?: unknown;
}): string {
  if (
    (message.type ?? "task") === "task"
    && typeof message.task_id === "string"
    && message.task_id.length > 0
  ) {
    return message.task_id;
  }
  return String(message.id);
}

/**
 * Build non-blocking, write-once callbacks for one logical Hub task.
 *
 * Merely creating this reporter, acknowledging an inbox row, or entering
 * processTask reports nothing. Runtime adapters own the two boundaries. A
 * consumed report also implies submission at the Hub, so it is safe for a
 * runtime with no distinct, trustworthy submission acknowledgement to call
 * only consumed().
 */
export function createTaskRuntimeEvidenceReporter(
  opts: TaskRuntimeEvidenceReporterOptions,
): TaskRuntimeEvidenceReporter {
  const attempted = new Set<TaskRuntimeEvidenceLevel>();

  const fire = (level: TaskRuntimeEvidenceLevel) => {
    if (!opts.taskId || attempted.has(level)) return;
    attempted.add(level);
    void opts.report(level, opts.taskId).catch((cause: unknown) => {
      // The tools are additive. Old Hubs and transient reporting failures
      // must not break the model turn; leaving a false-negative NULL is safer
      // than inventing a timestamp or retrying the model task.
      opts.debug?.(
        `[runtime-evidence] ${level} report failed task=${opts.taskId!.slice(0, 8)}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  };

  return {
    submitted: () => fire("submitted"),
    consumed: () => fire("consumed"),
  };
}
