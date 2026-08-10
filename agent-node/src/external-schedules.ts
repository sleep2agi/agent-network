import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { managedCronInventory, type CrontabAdapter } from "./owner-schedule-control.js";

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_SCHEDULES = 64;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const KINDS = new Set(["cron", "systemd", "tmux", "playwright", "custom"]);
const STATUSES = new Set(["success", "failed", "running", "unknown"]);
const ENTRY_KEYS = new Set([
  "id", "name", "kind", "frequency", "last_run_at", "last_status",
  "last_error", "next_run_at", "log_path", "enabled",
]);

export interface ExternalScheduleReport {
  id: string;
  name: string;
  kind: "cron" | "systemd" | "tmux" | "playwright" | "custom";
  frequency: string;
  last_run_at: string | null;
  last_status: "success" | "failed" | "running" | "unknown";
  last_error: string | null;
  next_run_at: string | null;
  log_ref: string | null;
  enabled: boolean;
  editable?: boolean;
  revision?: number;
}

export interface ExternalSchedulesSnapshot {
  observed_at: string;
  schedules: ExternalScheduleReport[];
  error?: "invalid_manifest" | "unsafe_manifest" | "read_failed";
}

function boundedString(value: unknown, field: string, max: number, nullable = false): string | null {
  if (value == null && nullable) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > max || /[\r\n\0]/.test(value)) {
    throw new Error(`invalid ${field}`);
  }
  return value;
}

function timestamp(value: unknown, field: string): string | null {
  if (value == null) return null;
  const text = boundedString(value, field, 64);
  if (!text || !Number.isFinite(Date.parse(text))) throw new Error(`invalid ${field}`);
  return new Date(text).toISOString();
}

export function parseExternalSchedulesManifest(
  raw: string,
  observedAt = new Date().toISOString(),
  managed = new Map<string, { cron: string; enabled: boolean; revision: number }>(),
): ExternalSchedulesSnapshot {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest must be an object");
  const root = parsed as Record<string, unknown>;
  if (Object.keys(root).some((key) => key !== "external_schedules")) throw new Error("unknown manifest key");
  if (!Array.isArray(root.external_schedules) || root.external_schedules.length > MAX_SCHEDULES) {
    throw new Error("invalid external_schedules");
  }
  const ids = new Set<string>();
  const schedules = root.external_schedules.map((entry, index): ExternalScheduleReport => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`invalid schedule ${index}`);
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some((key) => !ENTRY_KEYS.has(key))) throw new Error(`unknown schedule key ${index}`);
    const id = boundedString(row.id, "id", 128);
    if (!id || !ID_RE.test(id) || ids.has(id)) throw new Error(`invalid schedule id ${index}`);
    ids.add(id);
    const kind = boundedString(row.kind, "kind", 32);
    const lastStatus = boundedString(row.last_status ?? "unknown", "last_status", 16);
    if (!kind || !KINDS.has(kind) || !lastStatus || !STATUSES.has(lastStatus)) throw new Error(`invalid schedule enum ${index}`);
    const logPath = row.log_path == null ? null : boundedString(row.log_path, "log_path", 1024);
    const logRef = logPath ? basename(logPath) : null;
    if (logPath && (!logRef || logRef === "." || logRef === "..")) throw new Error(`invalid log_path ${index}`);
    if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw new Error(`invalid enabled ${index}`);
    const controlled = kind === "cron" ? managed.get(id) : undefined;
    return {
      id,
      name: boundedString(row.name, "name", 200)!,
      kind: kind as ExternalScheduleReport["kind"],
      frequency: controlled?.cron ?? boundedString(row.frequency, "frequency", 120)!,
      last_run_at: timestamp(row.last_run_at, "last_run_at"),
      last_status: lastStatus as ExternalScheduleReport["last_status"],
      last_error: row.last_error == null ? null : boundedString(row.last_error, "last_error", 500, true),
      next_run_at: timestamp(row.next_run_at, "next_run_at"),
      // Never report a host path. The basename is enough to identify the log
      // locally without exposing the node's directory layout to Hub clients.
      log_ref: logRef,
      enabled: controlled?.enabled ?? (row.enabled === undefined ? true : row.enabled === true),
      ...(controlled ? { editable: true, revision: controlled.revision } : {}),
    };
  });
  return { observed_at: timestamp(observedAt, "observed_at")!, schedules };
}

export function readExternalSchedulesSnapshot(
  configPath: string,
  observedAt = new Date().toISOString(),
  options: { ownerControlEnabled?: boolean; ownerNodeId?: string; crontabAdapter?: CrontabAdapter } = {},
): ExternalSchedulesSnapshot | undefined {
  if (!configPath) return undefined;
  const manifestPath = join(dirname(configPath), "external-schedules.json");
  try {
    const stat = lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANIFEST_BYTES) {
      return { observed_at: observedAt, schedules: [], error: "unsafe_manifest" };
    }
    let managed = new Map<string, { cron: string; enabled: boolean; revision: number }>();
    if (options.ownerControlEnabled && options.ownerNodeId) {
      try { managed = managedCronInventory(options.ownerNodeId, options.crontabAdapter); } catch {
        // Inventory remains honestly read-only when crontab cannot be verified.
      }
    }
    return parseExternalSchedulesManifest(readFileSync(manifestPath, "utf8"), observedAt, managed);
  } catch (error: any) {
    if (error?.code === "ENOENT") return { observed_at: observedAt, schedules: [] };
    if (error instanceof SyntaxError || /^invalid |^unknown |manifest /.test(String(error?.message || ""))) {
      return { observed_at: observedAt, schedules: [], error: "invalid_manifest" };
    }
    return { observed_at: observedAt, schedules: [], error: "read_failed" };
  }
}
