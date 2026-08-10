import { renderTaskTrace, safeTaskTraceError, taskTraceEvent, type TaskTraceStatus } from "./task-trace";

export interface ExplicitTaskTraceContext {
  fromAlias: string;
  toAlias: string;
  parentTaskId: string | null;
  networkId: string | null;
  startedAt: number;
  log: (line: string) => void;
}

export function emitExplicitTaskTrace(
  context: ExplicitTaskTraceContext,
  status: TaskTraceStatus,
  taskId: string | null,
  extra: { errorCode?: string; errorMessage?: unknown; event?: string } = {},
): void {
  const value = taskTraceEvent({
    from_alias: context.fromAlias,
    to_alias: context.toAlias,
    task_id: taskId,
    parent_task_id: context.parentTaskId,
    network_id: context.networkId,
    transport: "mcp_http",
    status,
    duration_ms: Date.now() - context.startedAt,
    lifecycle_tracking: "tracked",
    ...(extra.errorCode ? { error_code: extra.errorCode } : {}),
    ...(extra.errorMessage ? { error_message: safeTaskTraceError(extra.errorMessage) } : {}),
  });
  if (extra.event) value.event = extra.event;
  context.log(renderTaskTrace(value));
}

export async function sendExplicitTaskWithTrace(
  input: { alias: string; task: string; priority?: string },
  context: ExplicitTaskTraceContext,
  send: (args: Record<string, unknown>) => Promise<any>,
): Promise<any> {
  emitExplicitTaskTrace(context, "sending", null);
  try {
    const result = await send({
      alias: input.alias,
      task: input.task,
      priority: input.priority || "normal",
      from_session: context.fromAlias,
      parent_task_id: context.parentTaskId || undefined,
    });
    const taskId = result?.task_id || result?.message_id || result?.id || null;
    if (!taskId) {
      emitExplicitTaskTrace(context, "failed", null, { errorCode: "missing_task_id", errorMessage: "CommHub response omitted task_id" });
    } else {
      emitExplicitTaskTrace(context, "delivered", taskId);
    }
    return result;
  } catch (error) {
    emitExplicitTaskTrace(context, "failed", null, { errorCode: "send_failed", errorMessage: error });
    throw error;
  }
}
