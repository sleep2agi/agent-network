/**
 * Stable REST row projections.
 *
 * These lists deliberately mirror the fields already exposed by the public
 * endpoints before #311.  Keeping them in one place makes the wire contract
 * independent from future ALTER TABLE migrations: adding a storage-only
 * column must never silently add a REST response key.
 */
export const NETWORK_REST_COLUMNS = [
  "network_id", "network_name", "owner_id", "description", "settings",
  "created_at", "updated_at", "visibility", "max_members",
] as const;

export const SESSION_REST_COLUMNS = [
  "resume_id", "alias", "tmux_name", "server", "ip", "hostname", "agent",
  "project_dir", "version", "status", "task", "output", "progress", "score",
  "cpu_load_1min", "cpu_cores", "mem_total_gb", "mem_used_gb", "mem_avail_gb",
  "disk_total_gb", "disk_used_gb", "disk_avail_gb", "process_rss_bytes",
  "process_rss_mb", "process_cpu_pct", "process_uptime_seconds",
  "process_in_flight_count", "network_id", "registered_at", "updated_at",
  "node_id", "session_id", "config_path", "channels", "last_seen_at", "model",
] as const;

export const AUDIT_LOG_REST_COLUMNS = [
  "id", "user_id", "username", "action", "target_type", "target_id", "detail",
  "ip", "network_id", "created_at",
] as const;

export const TASK_EVENT_REST_COLUMNS = [
  "id", "task_id", "from_status", "to_status", "event_type", "actor", "detail",
  "created_at", "network_id",
] as const;

export const TASK_REST_COLUMNS = [
  "task_id", "from_node_id", "from_name", "to_node_id", "to_name", "priority",
  "status", "content", "result", "in_reply_to", "requires_response", "scope",
  "created_at", "delivered_at", "started_at", "runtime_submitted_at", "consumed_at", "completed_at", "expires_at",
  "network_id", "parent_task_id", "meta_json",
] as const;

export const COMPLETION_REST_COLUMNS = [
  "id", "session_name", "task", "result", "artifacts", "score",
  "duration_minutes", "network_id", "completed_at",
] as const;

// Storage projection for scheduled-task rows. `created_by` and
// `schedule_json` are intentionally selected for server-side auth/decoding,
// then removed by decodeRow before the REST response is serialized.
export const SCHEDULED_TASK_STORAGE_COLUMNS = [
  "schedule_id", "network_id", "created_by", "name", "target_node_id",
  "target_alias", "task_content", "priority", "schedule_type", "schedule_json",
  "timezone", "overlap_policy", "misfire_policy", "status", "next_run_at",
  "last_run_at", "revision", "created_at", "updated_at",
] as const;

export function sqlColumns(columns: readonly string[], qualifier?: string): string {
  return columns.map((column) => qualifier ? `${qualifier}.${column}` : column).join(", ");
}

export const NETWORK_REST_SELECT = sqlColumns(NETWORK_REST_COLUMNS);
export const SESSION_REST_SELECT = sqlColumns(SESSION_REST_COLUMNS);
export const AUDIT_LOG_REST_SELECT = sqlColumns(AUDIT_LOG_REST_COLUMNS);
export const TASK_EVENT_REST_SELECT = sqlColumns(TASK_EVENT_REST_COLUMNS);
export const TASK_REST_SELECT = sqlColumns(TASK_REST_COLUMNS);
export const COMPLETION_REST_SELECT = sqlColumns(COMPLETION_REST_COLUMNS);
export const SCHEDULED_TASK_STORAGE_SELECT = sqlColumns(SCHEDULED_TASK_STORAGE_COLUMNS);
