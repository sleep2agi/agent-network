export type TaskTraceTransport = "mcp_http" | "sdk_mcp_proxy" | "channel_mcp_proxy";
export type TaskTraceStatus = "sending" | "delivered" | "failed" | "acked" | "started" | "replied" | "expired";

export interface TaskTraceEvent {
  event: string;
  from_alias: string;
  to_alias: string;
  task_id: string | null;
  parent_task_id: string | null;
  network_id: string | null;
  transport: TaskTraceTransport;
  status: TaskTraceStatus;
  duration_ms: number;
  lifecycle_tracking: "tracked" | "not_tracked";
  error_code?: string;
  error_message?: string;
}

const SECRET = /(?:atok|ntok|utok|ghp|github_pat)_[A-Za-z0-9_-]+|Bearer\s+\S+/gi;
const safeField = (value: string | null, fallback: string) =>
  (value ?? fallback).replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 240);

export function safeTaskTraceError(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? "unknown error");
  return raw.replace(SECRET, "[REDACTED]").replace(/[\r\n\x00-\x1f\x7f]/g, " ").slice(0, 240);
}

export function renderTaskTrace(event: TaskTraceEvent, json = process.env.ANET_TASK_TRACE_FORMAT === "json"): string {
  if (json) return JSON.stringify(event);
  const parent = safeField(event.parent_task_id, "<missing>");
  const task = safeField(event.task_id, "<pending>");
  const error = event.error_code ? ` error=${event.error_code}:${event.error_message ?? ""}` : "";
  return `[commhub:task] ${event.status} from=${safeField(event.from_alias, "<unknown>")} to=${safeField(event.to_alias, "<unknown>")} task_id=${task} parent_task_id=${parent} network_id=${safeField(event.network_id, "<unknown>")} transport=${event.transport} duration_ms=${event.duration_ms} lifecycle=${event.lifecycle_tracking}${error}`;
}

export function taskTraceEvent(input: Omit<TaskTraceEvent, "event">): TaskTraceEvent {
  const names: Record<TaskTraceStatus, string> = {
    sending: "task.send.start",
    delivered: "task.send.delivered",
    failed: "task.send.failed",
    acked: "task.ack",
    started: "task.started",
    replied: "task.replied",
    expired: "task.expired",
  };
  return { event: names[input.status], ...input };
}

export interface SendTaskTraceInput {
  fromAlias: string;
  toAlias: string;
  parentTaskId: string | null;
  networkId: string | null;
  transport: TaskTraceTransport;
  lifecycleTracking: "tracked" | "not_tracked";
}

export interface SendTaskTraceDependencies {
  send: () => Promise<any>;
  log: (line: string) => void;
  now?: () => number;
}

function taskIdFromSendResult(result: any): string | null {
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

export async function sendTaskWithTrace(
  input: SendTaskTraceInput,
  dependencies: SendTaskTraceDependencies,
): Promise<any> {
  const now = dependencies.now ?? Date.now;
  const startedAt = now();
  const emit = (status: "sending" | "delivered" | "failed", taskId: string | null, failure?: unknown, errorCode?: string) => {
    dependencies.log(renderTaskTrace(taskTraceEvent({
      from_alias: input.fromAlias,
      to_alias: input.toAlias,
      task_id: taskId,
      parent_task_id: input.parentTaskId,
      network_id: input.networkId,
      transport: input.transport,
      status,
      duration_ms: now() - startedAt,
      lifecycle_tracking: input.lifecycleTracking,
      ...(failure !== undefined ? { error_code: errorCode || "send_failed", error_message: safeTaskTraceError(failure) } : {}),
    })));
  };

  emit("sending", null);
  try {
    const result = await dependencies.send();
    const taskId = taskIdFromSendResult(result);
    if (taskId) {
      // Hub returns ok:false + queued:true for an offline target after the
      // task has already been durably inserted. A canonical id is therefore
      // the authoritative delivery receipt; do not mislabel queued work as a
      // send failure merely because immediate wake-up was unavailable.
      emit("delivered", taskId);
    } else if (result?.ok === false || result?.error) {
      emit("failed", taskId, result?.error || "CommHub rejected task", "send_rejected");
    } else {
      emit("failed", null, "CommHub response omitted task_id", "missing_task_id");
    }
    return result;
  } catch (error) {
    emit("failed", null, error, "send_failed");
    throw error;
  }
}
