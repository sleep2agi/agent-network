import { renderTaskTrace, safeTaskTraceError, taskTraceEvent, type TaskTraceStatus } from "./task-trace";

export interface ExplicitTaskTraceContext {
  fromAlias: string;
  toAlias: string;
  parentTaskId: string | null;
  networkId: string | null;
  startedAt: number;
  log: (line: string) => void;
}

export type ExplicitTaskTraceExtra = { errorCode?: string; errorMessage?: unknown; event?: string };

export interface ExplicitTaskLifecycleEmission {
  status: TaskTraceStatus;
  taskId: string | null;
  extra?: ExplicitTaskTraceExtra;
}

export type ExplicitTaskLifecycleOutcome =
  | { kind: "terminal"; status: "replied" | "failed" | "cancelled"; latest: any; row: any }
  | { kind: "expired"; latest: any };

export interface ExplicitTaskLifecycleDependencies {
  getTask: (taskId: string) => Promise<any>;
  emit: (status: TaskTraceStatus, taskId: string | null, extra?: ExplicitTaskTraceExtra) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  stale30Ms?: number;
  stale60Ms?: number;
}

function taskIdFromResponse(result: any): string | null {
  const direct = result?.task_id || result?.message_id || result?.id;
  if (direct) return String(direct);
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return null;
  try {
    const parsed = JSON.parse(text);
    return parsed?.task_id || parsed?.message_id || parsed?.id || null;
  } catch {
    return null;
  }
}

export function emitExplicitTaskTrace(
  context: ExplicitTaskTraceContext,
  status: TaskTraceStatus,
  taskId: string | null,
  extra: ExplicitTaskTraceExtra = {},
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

export async function waitForExplicitTaskLifecycle(
  taskId: string,
  startedAt: number,
  dependencies: ExplicitTaskLifecycleDependencies,
): Promise<ExplicitTaskLifecycleOutcome> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = dependencies.timeoutMs ?? 120_000;
  const pollIntervalMs = dependencies.pollIntervalMs ?? 2_000;
  const stale30Ms = dependencies.stale30Ms ?? 30_000;
  const stale60Ms = dependencies.stale60Ms ?? 60_000;
  const emit = dependencies.emit;
  const deadline = now() + timeoutMs;
  let latest: any = null;
  const observed = new Set<string>();
  let warned30 = false;
  let warned60 = false;

  while (now() < deadline) {
    latest = await dependencies.getTask(taskId);
    const row = latest?.task || latest;
    const childStatus = row?.status;
    if ((childStatus === "acked" || childStatus === "running" || childStatus === "processing") && !observed.has(childStatus)) {
      observed.add(childStatus);
      emit(childStatus === "acked" ? "acked" : "started", taskId);
    }
    if (childStatus === "replied" || childStatus === "failed" || childStatus === "cancelled") {
      emit(childStatus === "replied" ? "replied" : "failed", taskId, {
        ...(childStatus === "replied" ? {} : { errorCode: `task_${childStatus}`, event: "task.failed" }),
      });
      return { kind: "terminal", status: childStatus, latest, row };
    }
    const elapsed = now() - startedAt;
    if (!warned30 && elapsed >= stale30Ms && childStatus === "delivered") {
      warned30 = true;
      emit("delivered", taskId, { event: "task.warning.delivered_stale_30s" });
    }
    if (!warned60 && elapsed >= stale60Ms && childStatus === "delivered") {
      warned60 = true;
      emit("delivered", taskId, { event: "task.warning.delivered_stale_60s" });
    }
    await sleep(pollIntervalMs);
  }

  emit("expired", taskId, { errorCode: "lifecycle_timeout" });
  return { kind: "expired", latest };
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
    const taskId = taskIdFromResponse(result);
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
