export type DashboardLaunchSource = "npx" | "global";

export interface DashboardLaunchRecord {
  schema: 1;
  port: number;
  listener_pid: number;
  listener_birth: string;
  source: DashboardLaunchSource;
  source_key: string;
  recorded_at: string;
}

export type DashboardListenerDecision =
  | { action: "start" }
  | { action: "already_running"; pid: number }
  | { action: "terminate_owned_stale"; pid: number; reason: "unhealthy" | "version_changed" }
  | { action: "refuse"; reason: string };

export function isDashboardProcessCommand(command: string): boolean {
  const normalized = command.trim();
  if (!normalized) return false;
  return normalized.includes("@sleep2agi/agent-network-dashboard")
    || /(?:^|[/\\])agent-network-dashboard(?:[/\\\s]|$)/.test(normalized)
    || /(?:^|\s)next-server(?:\s|$)/.test(normalized);
}

export function decideDashboardListener(input: {
  port: number;
  listenerPids: number[];
  record: DashboardLaunchRecord | null;
  listenerBirth: string | null;
  listenerCommand: string | null;
  desiredSource: DashboardLaunchSource;
  desiredSourceKey: string;
  healthy: boolean;
}): DashboardListenerDecision {
  const pids = [...new Set(input.listenerPids.filter(pid => Number.isSafeInteger(pid) && pid > 1))];
  if (pids.length === 0) return { action: "start" };
  if (pids.length !== 1) {
    return { action: "refuse", reason: `port ${input.port} has ambiguous listener PIDs (${pids.join(", ")})` };
  }

  const pid = pids[0];
  const record = input.record;
  if (!record) return { action: "refuse", reason: `port ${input.port} is occupied by an unmanaged process (pid ${pid})` };
  if (record.schema !== 1 || record.port !== input.port || record.listener_pid !== pid) {
    return { action: "refuse", reason: `port ${input.port} listener does not match the managed launch record` };
  }
  if (!input.listenerBirth || record.listener_birth !== input.listenerBirth) {
    return { action: "refuse", reason: `pid ${pid} birth fingerprint does not match the managed launch record` };
  }
  if (!input.listenerCommand || !isDashboardProcessCommand(input.listenerCommand)) {
    return { action: "refuse", reason: `pid ${pid} is not a verified Dashboard process` };
  }

  // A global install is explicitly operator-managed. Never auto-kill it.
  if (record.source !== "npx") {
    return { action: "refuse", reason: `port ${input.port} is owned by an explicitly managed global Dashboard (pid ${pid})` };
  }
  if (input.healthy && record.source === input.desiredSource && record.source_key === input.desiredSourceKey) {
    return { action: "already_running", pid };
  }
  return {
    action: "terminate_owned_stale",
    pid,
    reason: input.healthy ? "version_changed" : "unhealthy",
  };
}

export function parseDashboardLaunchRecord(value: unknown): DashboardLaunchRecord | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (row.schema !== 1 || !Number.isSafeInteger(row.port) || !Number.isSafeInteger(row.listener_pid)) return null;
  if (typeof row.listener_birth !== "string" || !row.listener_birth) return null;
  if (row.source !== "npx" && row.source !== "global") return null;
  if (typeof row.source_key !== "string" || !row.source_key) return null;
  if (typeof row.recorded_at !== "string" || !row.recorded_at) return null;
  return row as unknown as DashboardLaunchRecord;
}
