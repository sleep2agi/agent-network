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
  return { event: `task.send.${input.status}`, ...input };
}
