import { renderTaskTrace, safeTaskTraceError, taskTraceEvent } from "./task-trace";

export async function sendChannelTaskWithTrace(input: {
  alias: string;
  task: string;
  priority?: string;
  fromAlias: string;
  networkId?: string | null;
}, deps: {
  send: (args: Record<string, unknown>) => Promise<any>;
  log: (line: string) => void;
}): Promise<any> {
  const startedAt = Date.now();
  const emit = (status: "sending" | "delivered" | "failed", taskId: string | null, failure?: unknown) => {
    deps.log(renderTaskTrace(taskTraceEvent({
      from_alias: input.fromAlias,
      to_alias: input.alias,
      task_id: taskId,
      parent_task_id: null,
      network_id: input.networkId || null,
      transport: "channel_mcp_proxy",
      status,
      duration_ms: Date.now() - startedAt,
      lifecycle_tracking: "not_tracked",
      ...(failure ? { error_code: "proxy_error", error_message: safeTaskTraceError(failure) } : {}),
    })));
  };
  emit("sending", null);
  try {
    const result = await deps.send({
      alias: input.alias,
      task: input.task,
      priority: input.priority || "normal",
      from_session: input.fromAlias,
    });
    const taskId = result?.task_id || result?.message_id || result?.id || null;
    if (result?.ok === false || result?.error) emit("failed", taskId, result?.error || "commhub rejected task");
    else emit("delivered", taskId);
    return result;
  } catch (error) {
    emit("failed", null, error);
    throw error;
  }
}
