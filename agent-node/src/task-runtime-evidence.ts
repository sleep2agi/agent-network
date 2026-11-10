export type TaskRuntimeEvidenceLevel = "submitted" | "consumed";

export interface TaskRuntimeContext {
  threadId: string;
  turnId: string;
}

export function taskActivityPayload(taskId: string, context: TaskRuntimeContext) {
  return {
    task_ids: [taskId], activity_only: true,
    task_contexts: [{ task_id: taskId, thread_id: context.threadId, turn_id: context.turnId }],
  };
}

export interface TaskRuntimeEvidenceReporterOptions {
  taskId: string | null;
  report: (
    level: TaskRuntimeEvidenceLevel,
    taskId: string,
    context?: TaskRuntimeContext,
  ) => Promise<unknown>;
  debug?: (message: string) => void;
  reportActivity?: (taskId: string, context: TaskRuntimeContext) => Promise<unknown>;
  now?: () => number;
}

export interface TaskRuntimeEvidenceReporter {
  /** The exact task body crossed the runtime adapter's submission boundary. */
  submitted(): void;
  /** Exact turn-start or attributable runtime activity was observed. */
  consumed(context?: TaskRuntimeContext): void;
  /** Genuine activity for the already-consumed original turn, bounded to one report per 30 seconds. */
  activity(context: TaskRuntimeContext & { taskId: string }): void;
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
  const now = opts.now ?? Date.now;
  let consumedContext: TaskRuntimeContext | undefined;
  let consumedReport: Promise<unknown> | undefined;
  let lastActivityAttemptAt = 0;
  let activityInFlight = false;

  const fire = (level: TaskRuntimeEvidenceLevel, context?: TaskRuntimeContext) => {
    if (!opts.taskId || attempted.has(level)) return;
    attempted.add(level);
    if (level === "consumed") {
      consumedContext = context;
      lastActivityAttemptAt = now();
    }
    const pending = opts.report(level, opts.taskId, context).catch((cause: unknown) => {
      // The tools are additive. Old Hubs and transient reporting failures
      // must not break the model turn; leaving a false-negative NULL is safer
      // than inventing a timestamp or retrying the model task.
      opts.debug?.(
        `[runtime-evidence] ${level} report failed task=${opts.taskId!.slice(0, 8)}: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
    if (level === "consumed") consumedReport = pending;
  };

  return {
    submitted: () => fire("submitted"),
    consumed: (context) => fire("consumed", context),
    activity: (context) => {
      if (!opts.taskId || !opts.reportActivity || !consumedContext || activityInFlight) return;
      if (context.taskId !== opts.taskId) return;
      if (context.threadId !== consumedContext.threadId || context.turnId !== consumedContext.turnId) return;
      const at = now();
      if (at - lastActivityAttemptAt < 30_000) return;
      lastActivityAttemptAt = at;
      activityInFlight = true;
      void Promise.resolve(consumedReport)
        .then(() => opts.reportActivity!(opts.taskId!, context))
        .catch(() => opts.debug?.(`[runtime-evidence] activity report failed task=${opts.taskId!.slice(0, 8)}`))
        .finally(() => { activityInFlight = false; });
    },
  };
}
