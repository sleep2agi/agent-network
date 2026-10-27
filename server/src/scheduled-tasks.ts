import { bindRequirementWake, parseRequirementWake, publicRequirementWake, requirementWakeHead, pollRequirementWakes, type RequirementWake } from "./scheduled-requirement-wake.js";
import { scheduledOutcomeGuidance } from "./scheduled-outcome-guidance.js";
import { parseBackoffPolicy, refreshScheduledBackoff } from "./scheduled-backoff.js";
import { db, logTaskEvent } from "./db.js";
import { sessionTaskOnDispatch } from "./session-task-on-dispatch.js";
import { TASK_CONTENT_MAX, sessionTaskPreview } from "./shared/task-content-limit.js";
import { assertNodeActive } from "./lifecycle-guard.js";
import { assertNodeHealthy } from "./node-health-guard.js";
import { addNetworkScope, canRestWriteNetwork, singleNetworkId, type RestNetworkScope } from "./network-scope.js";
import { canMessageAgent, type AgentRef } from "./agent-access.js";
import { dispatchVerdict } from "./node-permissions.js";
import { hasSubscribers, pushEvent, pushNetworkObserverEvent } from "./push.js";
import { SCHEDULED_TASK_STORAGE_SELECT } from "./rest-projections.js";
import { blockerTimedOut, blockerTimeoutClock, expireStuckBlocker, sendStuckNotice, skipsBlockedBy, stuckNoticeSkips, stuckTimeoutMs, type StuckNotice } from "./scheduled-stuck.js";
import { applyNoProgressBackoff, evaluateScheduleFailures, failureSummary } from "./scheduled-failures.js";
import { parseHubTimestamp } from "./hub-timestamp.js";
import { scheduledTargetOffline, sendOfflineNotice, type OfflineNotice } from "./scheduled-offline.js";

export type ScheduleSpec =
  | { type: "once"; run_at: string }
  | { type: "interval"; every_seconds: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; time: string; weekdays: number[] };

export type MisfirePolicy = "catch_up_once" | "skip";

export type ScheduledRow = {
  schedule_id: string;
  network_id: string;
  created_by: string | null;
  created_by_node_id: string | null;
  name: string;
  target_node_id: string;
  target_alias: string;
  task_content: string;
  priority: "high" | "normal" | "low";
  schedule_type: ScheduleSpec["type"];
  schedule_json: string;
  timezone: string;
  overlap_policy: "skip" | "allow";
  misfire_policy: MisfirePolicy;
  status: "active" | "paused" | "completed" | "cancelled";
  next_run_at: string | null;
  last_run_at: string | null;
  no_change_backoff: number;
  backoff_streak: number;
  backoff_effective_seconds: number | null;
  backoff_last_run_id: string | null;
  requirement_wake_json: string | null;
  requirement_wake_cursor: number;
  requirement_wake_last_event_id: number | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

type RequestAuth = {
  userId: string;
  networkId: string | null;
  username: string;
} | null;

export type ScheduledRequestContext = {
  req: Request;
  url: URL;
  auth: RequestAuth;
  isAdmin: boolean;
  isNodeToken: boolean;
  scope: RestNetworkScope;
};

const PRIORITIES = new Set(["high", "normal", "low"]);
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const OPEN_TASK_STATUSES = ["created", "delivered", "acked", "running"];
const MISFIRE_POLICIES = new Set<MisfirePolicy>(["catch_up_once", "skip"]);
export const MISFIRE_GRACE_MS = 60_000;

export function assertScheduledTaskBackendSupported(): void {
  const refusal = db.transactionalFeaturesRefusal;
  if (refusal !== null) {
    throw new Error(`scheduled_tasks_require_transactional_sqlite_backend${refusal ? `: ${refusal}` : ""}`);
  }
}

function jsonError(error: string, status: number, extra: Record<string, unknown> = {}): Response {
  return Response.json({ ok: false, error, ...extra }, { status });
}

function iso(date: Date): string {
  return date.toISOString();
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function parseMisfirePolicy(raw: unknown, fallback: MisfirePolicy = "catch_up_once"): MisfirePolicy {
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || !MISFIRE_POLICIES.has(raw as MisfirePolicy)) throw new Error("invalid_misfire_policy");
  return raw as MisfirePolicy;
}

function zonedParts(date: Date, timezone: string): { date: string; time: string; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value || "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(value("weekday"));
  return { date: `${value("year")}-${value("month")}-${value("day")}`, time: `${value("hour")}:${value("minute")}`, weekday };
}

/** Parse and validate the public schedule shape. No cron expressions: the
 * supported forms are intentionally portable between Dashboard and mobile. */
export function parseScheduleSpec(raw: unknown, timezoneRaw: unknown): { spec: ScheduleSpec; timezone: string } {
  if (!raw || typeof raw !== "object") throw new Error("schedule_required");
  const obj = raw as Record<string, unknown>;
  const type = obj.type;
  const timezone = typeof timezoneRaw === "string" && timezoneRaw.trim() ? timezoneRaw.trim() : "UTC";
  if (!validTimezone(timezone)) throw new Error("invalid_timezone");

  if (type === "once") {
    if (typeof obj.run_at !== "string") throw new Error("run_at_required");
    const when = new Date(obj.run_at);
    if (!Number.isFinite(when.getTime())) throw new Error("invalid_run_at");
    return { spec: { type, run_at: iso(when) }, timezone };
  }
  if (type === "interval") {
    const every = Number(obj.every_seconds);
    if (!Number.isSafeInteger(every) || every < 60 || every > 365 * 86400) throw new Error("invalid_interval");
    return { spec: { type, every_seconds: every }, timezone };
  }
  if (type === "daily") {
    if (typeof obj.time !== "string" || !TIME_RE.test(obj.time)) throw new Error("invalid_time");
    return { spec: { type, time: obj.time }, timezone };
  }
  if (type === "weekly") {
    if (typeof obj.time !== "string" || !TIME_RE.test(obj.time)) throw new Error("invalid_time");
    if (!Array.isArray(obj.weekdays) || obj.weekdays.length === 0) throw new Error("weekdays_required");
    const weekdays = [...new Set(obj.weekdays.map(Number))].sort();
    if (weekdays.some((d) => !Number.isSafeInteger(d) || d < 0 || d > 6)) throw new Error("invalid_weekdays");
    return { spec: { type, time: obj.time, weekdays }, timezone };
  }
  throw new Error("invalid_schedule_type");
}

/** Return the first occurrence strictly after `after`. Daily/weekly scans UTC
 * minutes and compares IANA-zone wall time, so DST gaps/folds follow the
 * platform timezone database instead of a hand-written offset guess. */
export function nextOccurrence(spec: ScheduleSpec, timezone: string, after: Date): Date | null {
  if (spec.type === "once") {
    const when = new Date(spec.run_at);
    return when.getTime() > after.getTime() ? when : null;
  }
  if (spec.type === "interval") return new Date(after.getTime() + spec.every_seconds * 1000);

  // A wall-clock time can occur twice when DST falls back. If today's local
  // occurrence already happened at or before `after`, skip every duplicate
  // carrying that same local date. Otherwise a "daily 01:30" schedule runs
  // twice on the fall-back day.
  const afterLocal = zonedParts(after, timezone);
  let alreadyOccurredDate: string | null = null;
  const backward = new Date(Math.floor(after.getTime() / 60000) * 60000);
  for (let i = 0; i <= 26 * 60; i++, backward.setTime(backward.getTime() - 60000)) {
    const local = zonedParts(backward, timezone);
    if (local.date === afterLocal.date && local.time === spec.time && (spec.type === "daily" || spec.weekdays.includes(local.weekday))) {
      alreadyOccurredDate = local.date;
      break;
    }
  }

  const cursor = new Date(Math.floor(after.getTime() / 60000) * 60000 + 60000);
  const max = 8 * 24 * 60;
  for (let i = 0; i < max; i++, cursor.setTime(cursor.getTime() + 60000)) {
    const local = zonedParts(cursor, timezone);
    if (local.time !== spec.time) continue;
    if (local.date === alreadyOccurredDate) continue;
    if (spec.type === "daily" || spec.weekdays.includes(local.weekday)) return new Date(cursor);
  }
  throw new Error("next_occurrence_unresolvable");
}

/** REST shape (pinned by rest-explicit-columns-http.test.ts): creator ids stay server-side. */
function decodeRow(row: ScheduledRow): Record<string, unknown> {
  let schedule: unknown = null;
  try { schedule = JSON.parse(row.schedule_json); } catch {}
  const { created_by: _createdBy, created_by_node_id: _createdByNode, schedule_json: _scheduleJson,
    no_change_backoff, backoff_streak, backoff_effective_seconds, backoff_last_run_id,
    requirement_wake_json, requirement_wake_cursor, requirement_wake_last_event_id, ...publicRow } = row;
  if (requirement_wake_json && schedule && typeof schedule === "object")
    schedule = { ...schedule, requirement_wake: publicRequirementWake(requirement_wake_json) };
  return { ...publicRow, schedule, ...(requirement_wake_json ? { requirement_wake_state:
    { cursor: requirement_wake_cursor, last_event_id: requirement_wake_last_event_id } } : {}), ...(no_change_backoff === 1 ? { no_change_backoff: true,
    backoff: { streak: backoff_streak, effective_seconds: backoff_effective_seconds
      ?? (schedule as { every_seconds?: number } | null)?.every_seconds, last_run_id: backoff_last_run_id } } : {}) };
}

/** MCP (agent) shape: REST shape + which node created it (null = a person / old row). Never the user id. */
export function decodeRowForAgent(row: ScheduledRow): Record<string, unknown> {
  return { ...decodeRow(row), created_by_node_id: row.created_by_node_id ?? null };
}

export function getScheduleRow(scheduleId: string): ScheduledRow | null {
  return db.get<ScheduledRow>(`SELECT ${SCHEDULED_TASK_STORAGE_SELECT} FROM scheduled_tasks WHERE schedule_id = ?1`, scheduleId);
}

export class ScheduleInputError extends Error {
  constructor(public code: string, public status: number, public extra: Record<string, unknown> = {}) { super(code); }
}

export type ValidatedScheduleCreate = {
  name: string; content: string; priority: string; misfirePolicy: MisfirePolicy; backoff: boolean; wake: RequirementWake | null;
  target: { node_id: string; alias: string }; spec: ScheduleSpec; timezone: string; next: Date;
};

/** Shared by REST POST and MCP schedule_create. Throws Error(code) like before. */
export function validateScheduleCreate(networkId: string, body: Record<string, unknown>): ValidatedScheduleCreate {
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const content = typeof body.task === "string" ? body.task.trim() : "";
  if (!name || name.length > 120) throw new Error("invalid_name");
  if (!content || content.length > TASK_CONTENT_MAX) throw new Error("invalid_task");
  const priority = typeof body.priority === "string" ? body.priority : "normal";
  if (!PRIORITIES.has(priority)) throw new Error("invalid_priority");
  const misfirePolicy = parseMisfirePolicy(body.misfire_policy);
  const target = validateTarget(networkId, body.target_node_id);
  const { spec, timezone } = parseScheduleSpec(body.schedule, body.timezone);
  const next = nextOccurrence(spec, timezone, new Date());
  if (!next) throw new Error("schedule_has_no_future_occurrence");
  return { name, content, priority, misfirePolicy, target, spec, timezone, next,
    backoff: parseBackoffPolicy(body.no_change_backoff, spec.type),
    wake: parseRequirementWake((body.schedule as Record<string, unknown>).requirement_wake) };
}

export function insertSchedule(networkId: string, createdBy: string | null, createdByNodeId: string | null, v: ValidatedScheduleCreate): ScheduledRow {
  const scheduleId = `sched_${crypto.randomUUID()}`;
  const wakeJson = bindRequirementWake({ network_id: networkId, created_by: createdBy,
    created_by_node_id: createdByNodeId, target_node_id: v.target.node_id }, v.wake, v.backoff, v.spec.type, createdBy);
  db.run(
    `INSERT INTO scheduled_tasks
     (schedule_id, network_id, created_by, created_by_node_id, name, target_node_id, target_alias, task_content, priority, schedule_type, schedule_json, timezone, overlap_policy, misfire_policy, next_run_at, no_change_backoff, requirement_wake_json, requirement_wake_cursor)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'skip', ?13, ?14, ?15, ?16, ?17)`,
    [scheduleId, networkId, createdBy, createdByNodeId, v.name, v.target.node_id, v.target.alias, v.content, v.priority, v.spec.type, JSON.stringify(v.spec), v.timezone, v.misfirePolicy, iso(v.next), v.backoff ? 1 : 0, wakeJson, wakeJson ? requirementWakeHead(networkId) : 0],
  );
  return getScheduleRow(scheduleId)!;
}

/** Idempotent cancel (shared by REST DELETE / POST cancel and MCP schedule_cancel). */
export function cancelSchedule(row: ScheduledRow): void {
  if (row.status === "cancelled") return;
  db.run("UPDATE scheduled_tasks SET status = 'cancelled', next_run_at = NULL, backoff_streak = 0, backoff_effective_seconds = NULL, backoff_last_run_id = NULL, revision = revision + 1, updated_at = datetime('now') WHERE schedule_id = ?1", [row.schedule_id]);
}

export function scheduleRuns(row: ScheduledRow, limit: number): Record<string, unknown> {
  const runs = db.all(
    // #523 — a task that ended `failed` leaves run.error_message empty; its reason is the task's reply text.
    `SELECT r.run_id, r.schedule_id, r.scheduled_for, r.task_id, r.status, r.error_code,
            CASE WHEN r.error_message IS NULL AND r.status = 'failed' THEN SUBSTR(t.result, 1, 500) ELSE r.error_message END AS error_message,
            r.blocked_by_task_id, r.blocked_by_state, r.created_at, r.completed_at, r.work_outcome, r.schedule_revision, r.work_outcome_node_id
       FROM scheduled_task_runs r
       LEFT JOIN tasks t ON t.task_id = r.task_id AND t.network_id = r.network_id
      WHERE r.schedule_id = ?1 AND r.network_id = ?2 ORDER BY r.created_at DESC, r.scheduled_for DESC LIMIT ?3`,
    row.schedule_id, row.network_id, limit,
  );
  return { runs, ...failureSummary(row.schedule_id) };
}

/** Shared PATCH semantics (REST PATCH and MCP schedule_update). Throws ScheduleInputError. */
export function patchSchedule(row: ScheduledRow, body: Record<string, unknown>, actorUserId: string | null = null): ScheduledRow {
  // Cancellation/completion are terminal states. Editing must never become
  // an implicit resurrection path (including by supplying status=active).
  if (row.status === "cancelled") throw new ScheduleInputError("schedule_cancelled", 409);
  if (row.status === "completed") throw new ScheduleInputError("schedule_completed", 409);
  if (!Number.isSafeInteger(body.revision) || Number(body.revision) !== row.revision) throw new ScheduleInputError("revision_conflict", 409, { current_revision: row.revision });
  try {
    const name = body.name === undefined ? row.name : String(body.name).trim();
    const content = body.task === undefined ? row.task_content : String(body.task).trim();
    const priority = body.priority === undefined ? row.priority : String(body.priority);
    if (!name || name.length > 120) throw new Error("invalid_name");
    if (!content || content.length > TASK_CONTENT_MAX) throw new Error("invalid_task");
    if (!PRIORITIES.has(priority)) throw new Error("invalid_priority");
    const target = body.target_node_id === undefined ? { node_id: row.target_node_id, alias: row.target_alias } : validateTarget(row.network_id, body.target_node_id);
    const parsed = body.schedule === undefined
      ? { spec: JSON.parse(row.schedule_json) as ScheduleSpec, timezone: body.timezone === undefined ? row.timezone : String(body.timezone) }
      : parseScheduleSpec(body.schedule, body.timezone === undefined ? row.timezone : body.timezone);
    if (!validTimezone(parsed.timezone)) throw new Error("invalid_timezone");
    const requestedStatus = body.status === undefined ? row.status : String(body.status);
    if (!new Set(["active", "paused"]).has(requestedStatus)) throw new Error("invalid_status");
    const misfirePolicy = parseMisfirePolicy(body.misfire_policy, row.misfire_policy);
    // Editing descriptive fields must not silently reset the schedule's
    // cadence. Recompute only when the scheduling inputs change, when a
    // paused schedule resumes, or when repairing an impossible active row
    // with no next occurrence. The recompute uses the same DST-safe helper
    // as creation and dispatch advancement.
    const scheduleJson = JSON.stringify(parsed.spec);
    const backoff = parseBackoffPolicy(body.no_change_backoff, parsed.spec.type, row.no_change_backoff === 1);
    if (backoff && row.overlap_policy !== "skip") throw new Error("no_change_backoff_requires_skip_overlap");
    const rawWake = (body.schedule as Record<string, unknown> | undefined)?.requirement_wake;
    const wake = parseRequirementWake(rawWake, backoff ? row.requirement_wake_json : null);
    const wakeJson = bindRequirementWake({ ...row, target_node_id: target.node_id }, wake, backoff, parsed.spec.type, actorUserId);
    // Every edit creates a new reporting generation. Reset opted-in cadence
    // too, so the visible state never describes an older target/revision.
    const schedulingChanged = scheduleJson !== row.schedule_json || parsed.timezone !== row.timezone;
    const backoffGenerationReset = row.no_change_backoff === 1 || backoff;
    const resumed = row.status !== "active" && requestedStatus === "active";
    const next = requestedStatus !== "active"
      ? null
      : schedulingChanged || backoffGenerationReset || resumed || !row.next_run_at
        ? nextOccurrence(parsed.spec, parsed.timezone, new Date())
        : new Date(row.next_run_at);
    if (requestedStatus === "active" && !next) throw new Error("schedule_has_no_future_occurrence");
    // Runs no longer bump revision, so the scheduler may have advanced
    // next_run_at after `row` was read. When cadence is preserved, keep the
    // stored value instead of writing back the already-fired occurrence.
    const keepStoredNext = requestedStatus === "active" && !schedulingChanged && !backoffGenerationReset && !resumed && !!row.next_run_at ? 1 : 0;
    const updated = db.run(
      `UPDATE scheduled_tasks SET name = ?1, target_node_id = ?2, target_alias = ?3, task_content = ?4,
       priority = ?5, schedule_type = ?6, schedule_json = ?7, timezone = ?8, status = ?9,
       next_run_at = CASE WHEN ?14 = 1 AND next_run_at IS NOT NULL THEN next_run_at ELSE ?10 END,
       misfire_policy = ?11, no_change_backoff = ?15, requirement_wake_json = ?16, requirement_wake_cursor = ?17, requirement_wake_last_event_id = NULL, backoff_streak = 0, backoff_effective_seconds = NULL, backoff_last_run_id = NULL, revision = revision + 1, updated_at = datetime('now') WHERE schedule_id = ?12 AND revision = ?13`,
      [name, target.node_id, target.alias, content, priority, parsed.spec.type, scheduleJson, parsed.timezone, requestedStatus, next ? iso(next) : null, misfirePolicy, row.schedule_id, row.revision, keepStoredNext, backoff ? 1 : 0, wakeJson, wakeJson ? requirementWakeHead(row.network_id) : 0],
    );
    if (updated.changes !== 1) throw new ScheduleInputError("revision_conflict", 409);
    return getScheduleRow(row.schedule_id)!;
  } catch (e: any) {
    if (e instanceof ScheduleInputError) throw e;
    const code = String(e?.message || "invalid_schedule");
    throw new ScheduleInputError(code, code === "target_node_not_found" ? 404 : 400);
  }
}

function scopedSchedule(scheduleId: string, scope: RestNetworkScope): ScheduledRow | null {
  const params: unknown[] = [scheduleId];
  let sql = `SELECT ${SCHEDULED_TASK_STORAGE_SELECT} FROM scheduled_tasks WHERE schedule_id = ?1`;
  sql = addNetworkScope(sql, params, scope);
  return db.get<ScheduledRow>(sql, ...params);
}

function resolveWriteNetwork(body: Record<string, unknown>, ctx: ScheduledRequestContext): string | null {
  if (ctx.auth?.networkId) return ctx.auth.networkId;
  if (typeof body.network_id === "string" && body.network_id) return body.network_id;
  return singleNetworkId(ctx.scope);
}

function validateTarget(networkId: string, nodeId: unknown): { node_id: string; alias: string } {
  if (typeof nodeId !== "string" || nodeId.length < 2 || nodeId.length > 200) throw new Error("invalid_target_node_id");
  const node = db.get<{ node_id: string; alias: string | null }>(
    "SELECT node_id, alias FROM nodes WHERE node_id = ?1 AND network_id = ?2",
    nodeId, networkId,
  );
  if (!node?.alias) throw new Error("target_node_not_found");
  return { node_id: node.node_id, alias: node.alias };
}

function stuckNoticeFor(row: ScheduledRow, reason: StuckNotice["reason"], blocker: { task_id: string; created_at: string }, skips: number, timeoutMs: number): StuckNotice {
  return {
    reason, scheduleId: row.schedule_id, scheduleName: row.name, networkId: row.network_id, createdBy: row.created_by,
    alias: row.target_alias, timezone: row.timezone, taskId: blocker.task_id, taskCreatedAt: blocker.created_at, skips, timeoutMs,
  };
}

/** The line an Agent-created schedule's task always starts with (board #733). */
export function agentSchedulePrefix(alias: string | null, nodeId: string): string {
  return `[scheduled by agent ${alias ?? "?"} (${nodeId})]\n`;
}

function agentCreatorDenial(row: ScheduledRow, target: AgentRef): { code: string; message: string } | null {
  const creator = db.get<{ alias: string | null; owner_user_id: string | null; permission_mode: string | null }>(
    "SELECT alias, owner_user_id, permission_mode FROM nodes WHERE node_id = ?1 AND network_id = ?2", row.created_by_node_id, row.network_id);
  if (!creator) return { code: "creator_node_gone", message: "The node that created this schedule no longer exists in this network" };
  const mode = creator.permission_mode === "readonly" || creator.permission_mode === "restricted" ? creator.permission_mode : "normal";
  if (mode === "readonly") return { code: "creator_node_readonly", message: "The node that created this schedule is read-only" };
  const verdict = dispatchVerdict({
    networkId: row.network_id, nodeId: row.created_by_node_id, logKey: row.created_by_node_id!,
    aliases: creator.alias ? [creator.alias] : [], ownerUserId: creator.owner_user_id, mode,
  }, target);
  if (verdict) return { code: "creator_access_revoked", message: `The node that created this schedule may not send_task to this agent now (${verdict.reason})` };
  return null;
}

type DispatchEvent = { alias: string; networkId: string; taskId: string; priority: string; state: "delivered" | "queued" };

export function dispatchScheduledOccurrence(row: ScheduledRow, scheduledFor: string, advanceSchedule: boolean, advanceAfter = new Date()): { runId: string; taskId?: string; status: string; event?: DispatchEvent } {
  const runId = `srun_${crypto.randomUUID()}`;
  let event: DispatchEvent | undefined;
  let finalStatus = "failed";
  let createdTaskId: string | undefined;
  const notices: StuckNotice[] = [];
  let offlineNotice: OfflineNotice | null = null;
  const timedOut: Array<{ taskId: string; fromStatus: string }> = [];

  db.transaction(() => {
    // UNIQUE(schedule_id, scheduled_for) is the cross-process claim. If two
    // Hub processes race, one INSERT wins and the other transaction aborts.
    db.run(
      `INSERT INTO scheduled_task_runs (run_id, schedule_id, network_id, scheduled_for, status, schedule_revision)
       VALUES (?1, ?2, ?3, ?4, 'claiming', ?5)`,
      [runId, row.schedule_id, row.network_id, scheduledFor, row.revision],
    );

    const current = getScheduleRow(row.schedule_id);
    if (!current || current.revision !== row.revision || current.status === "cancelled"
      || (advanceSchedule && current.status !== "active")) throw new Error("schedule_changed");
    row = current;
    // Manual dispatch is an explicit wake. Its new generation fences all
    // already-running reports, while a paused schedule remains paused.
    if (!advanceSchedule && row.no_change_backoff === 1) {
      const base = JSON.parse(row.schedule_json).every_seconds;
      db.run(`UPDATE scheduled_tasks SET revision = revision + 1, backoff_streak = 0,
        backoff_effective_seconds = NULL, backoff_last_run_id = NULL,
        requirement_wake_cursor = ?4, requirement_wake_last_event_id = NULL,
        next_run_at = CASE WHEN status = 'active' THEN ?1 ELSE next_run_at END,
        updated_at = datetime('now') WHERE schedule_id = ?2 AND revision = ?3`,
        [new Date(advanceAfter.getTime() + base * 1000).toISOString(), row.schedule_id, row.revision, requirementWakeHead(row.network_id)]);
      row = getScheduleRow(row.schedule_id)!;
    }
    db.run("UPDATE scheduled_task_runs SET schedule_revision = ?1 WHERE run_id = ?2", [row.revision, runId]);

    // Board #757 — do not create a task that will merely expire while its
    // exact target session is offline. This branch deliberately precedes the
    // overlap check: target_offline is the actionable reason for this round.
    const targetNode = db.get<{ node_id: string; alias: string | null }>(
      "SELECT node_id, alias FROM nodes WHERE node_id = ?1 AND network_id = ?2",
      row.target_node_id, row.network_id,
    );
    if (targetNode?.alias && scheduledTargetOffline(targetNode.node_id, targetNode.alias, row.network_id, advanceAfter.getTime())) {
      finalStatus = "skipped";
      db.run(
        `UPDATE scheduled_task_runs SET status = 'skipped', error_code = 'target_offline',
           error_message = 'The target node is offline; no task was created', completed_at = datetime('now') WHERE run_id = ?1`,
        [runId],
      );
      const claimed = db.run(
        "UPDATE scheduled_tasks SET offline_alert_at = ?1 WHERE schedule_id = ?2 AND offline_alert_at IS NULL",
        [advanceAfter.toISOString(), row.schedule_id],
      ).changes === 1;
      if (claimed) offlineNotice = {
        scheduleId: row.schedule_id, scheduleName: row.name, networkId: row.network_id,
        createdBy: row.created_by, createdByNodeId: row.created_by_node_id,
        targetAlias: targetNode.alias,
      };
      if (advanceSchedule) advance({ ...row, target_alias: targetNode.alias }, scheduledFor, advanceAfter);
      // #2622 —— 目标长期离线时按同因链放慢（默认 3 次后 2 倍递增，上限 1 小时）。
      try {
        const bo = applyNoProgressBackoff(row.schedule_id);
        if (bo && bo.effective_seconds) {
          const sched = db.get<{ next_run_at: string | null }>("SELECT next_run_at FROM scheduled_tasks WHERE schedule_id = ?1", row.schedule_id);
          const at = parseHubTimestamp(sched?.next_run_at);
          if (at !== null) advance({ ...row, target_alias: targetNode.alias }, scheduledFor, new Date(at));
        }
      } catch (e: any) {
        console.error(`[scheduled-tasks] no-progress backoff failed schedule=${row.schedule_id}: ${e?.message || e}`);
      }
      return;
    }
    // Seeing the target online rearms exactly one warning for a future offline episode.
    if (targetNode?.alias) db.run("UPDATE scheduled_tasks SET offline_alert_at = NULL WHERE schedule_id = ?1 AND offline_alert_at IS NOT NULL", [row.schedule_id]);

    if (row.overlap_policy === "skip") {
      const placeholders = OPEN_TASK_STATUSES.map((_, i) => `?${i + 2}`).join(", ");
      // received:节点那边有没有把这条任务取走过(inbox 行被 ack,或任务已进 acked/running)。
      // 跳过记录带上它,客户端才分得清「节点还没收到」和「节点在处理」—— 前者是投递故障,
      // 后者才是真的上一次还没做完。
      const findOpen = () => db.get<{ task_id: string; received: number; created_at: string; consumed_at: string | null; started_at: string | null; last_activity_at: string | null; status: string }>(
        `SELECT r.task_id, t.created_at, t.consumed_at, t.started_at, t.last_activity_at, t.status,
                CASE WHEN t.status IN ('acked', 'running')
                       OR EXISTS (SELECT 1 FROM inbox i WHERE (i.task_id = r.task_id OR i.id = r.task_id) AND i.acked = 1)
                     THEN 1 ELSE 0 END AS received
         FROM scheduled_task_runs r
         JOIN tasks t ON t.task_id = r.task_id
         WHERE r.schedule_id = ?1 AND t.status IN (${placeholders})
         ORDER BY r.created_at DESC LIMIT 1`,
        row.schedule_id, ...OPEN_TASK_STATUSES,
      );
      let open = findOpen();
      // #464 — a blocker open past the stuck timeout is ended as `expired` (the existing terminal state) and
      // this occurrence dispatches normally. Bounded: each pass ends one exact open task or stops.
      for (let guard = 0; open && guard < 20 && blockerTimedOut(open, row.schedule_json, advanceAfter); guard++) {
        const { ageMs, limitMs, source } = blockerTimeoutClock(open, row.schedule_json, advanceAfter);
        if (!expireStuckBlocker(open.task_id, row.network_id, ageMs, limitMs, source)) break;
        timedOut.push({ taskId: open.task_id, fromStatus: open.status });
        // Each stuck episode gets exactly one notice: if the stuck notice already went out (N skips), stay quiet.
        if (skipsBlockedBy(row.schedule_id, open.task_id) < stuckNoticeSkips()) {
          notices.push(stuckNoticeFor(row, "timed_out", open, skipsBlockedBy(row.schedule_id, open.task_id), limitMs));
        }
        open = findOpen();
      }
      if (open) {
        finalStatus = "skipped";
        const blockedState = open.received ? "in_progress" : "not_received";
        db.run(
          `UPDATE scheduled_task_runs SET status = 'skipped', error_code = 'previous_run_active', error_message = ?2,
             blocked_by_task_id = ?3, blocked_by_state = ?4, completed_at = datetime('now') WHERE run_id = ?1`,
          [
            runId,
            blockedState === "not_received"
              ? `previous run task ${open.task_id} has not been received by the node yet`
              : `previous run task ${open.task_id} is still in progress on the node`,
            open.task_id,
            blockedState,
          ],
        );
        // #464 — the Nth consecutive skip behind the same task tells the schedule's creator, once.
        const skips = skipsBlockedBy(row.schedule_id, open.task_id);
        if (skips === stuckNoticeSkips()) notices.push(stuckNoticeFor(row, "stuck", open, skips, stuckTimeoutMs(row.schedule_json)));
        if (advanceSchedule) advance(row, scheduledFor, advanceAfter);
        return;
      }
    }

    const node = targetNode;
    if (!node?.alias) {
      finalStatus = "failed";
      db.run(
        "UPDATE scheduled_task_runs SET status = 'failed', error_code = 'target_node_not_found', error_message = 'The bound node no longer exists in this network', completed_at = datetime('now') WHERE run_id = ?1",
        [runId],
      );
      if (advanceSchedule) advance(row, scheduledFor, advanceAfter);
      return;
    }
    // 多用户 Agent 权限:排程是「建它的人」的委托。建的人后来被设成受限成员、而且没被授权
    // 给目标 Agent 发任务时,不再代他派发(否则受限前建的排程会永远绕过授权)。
    // Board #733 — an Agent-created schedule is that node's standing send_task: every run re-evaluates the
    // creating node as it is NOW (exists, not read-only, current owner) with send_task's own dispatchVerdict.
    const creatorDenial = row.created_by_node_id
      ? agentCreatorDenial(row, { alias: node.alias, nodeId: node.node_id })
      : row.created_by && !canMessageAgent(row.created_by, row.network_id, { alias: node.alias, nodeId: node.node_id })
        ? { code: "creator_access_revoked", message: "The schedule creator is no longer allowed to message this agent" }
        : null;
    if (creatorDenial) {
      finalStatus = "failed";
      db.run(
        "UPDATE scheduled_task_runs SET status = 'failed', error_code = ?1, error_message = ?2, completed_at = datetime('now') WHERE run_id = ?3",
        [creatorDenial.code, creatorDenial.message, runId],
      );
      if (advanceSchedule) advance(row, scheduledFor, advanceAfter);
      return;
    }
    const creatorNode = row.created_by_node_id
      ? db.get<{ alias: string | null }>("SELECT alias FROM nodes WHERE node_id = ?1 AND network_id = ?2", row.created_by_node_id, row.network_id)
      : null;
    const lifecycle = assertNodeActive(node.alias, row.network_id);
    if (!lifecycle.ok) {
      finalStatus = "failed";
      db.run(
        "UPDATE scheduled_task_runs SET status = 'failed', error_code = 'target_not_active', error_message = ?1, completed_at = datetime('now') WHERE run_id = ?2",
        [String((lifecycle as any).error || "target_not_active").slice(0, 500), runId],
      );
      if (advanceSchedule) advance(row, scheduledFor, advanceAfter);
      return;
    }

    // #460 — the target reports a degraded layer (App Server down / TUI gone / login revoked): the run fails
    // with that reason instead of queueing a task nobody will execute. Unknown / stale health runs as before.
    const health = assertNodeHealthy(node.alias, row.network_id, { forceAllowed: false });
    if (!health.ok) {
      finalStatus = "failed";
      db.run(
        "UPDATE scheduled_task_runs SET status = 'failed', error_code = 'node_degraded', error_message = ?1, completed_at = datetime('now') WHERE run_id = ?2",
        [health.message.slice(0, 500), runId],
      );
      if (advanceSchedule) advance(row, scheduledFor, advanceAfter);
      return;
    }

    const taskId = crypto.randomUUID();
    // claude-code 裸节点的 node-server 上报 report_status 不带 node_id,它的 sessions 行
    // node_id 永远是 NULL —— 只按 node_id 找会话,这类节点每一次都判成 queued、门铃不响,
    // 任务在 inbox 里等到别的消息顺带捎进去(生产上 20–36 分钟)。按 node_id 找不到时退回
    // 同网同别名、node_id 为空的会话;SSE 订阅者注册表是「有没有人在听」的实测,也算数。
    const session = db.get<{ status: string | null }>(
      "SELECT status FROM sessions WHERE node_id = ?1 AND network_id = ?2 ORDER BY updated_at DESC LIMIT 1",
      row.target_node_id, row.network_id,
    ) ?? db.get<{ status: string | null }>(
      "SELECT status FROM sessions WHERE alias = ?1 AND network_id = ?2 AND node_id IS NULL ORDER BY updated_at DESC LIMIT 1",
      node.alias, row.network_id,
    );
    const deliveryState: "delivered" | "queued" =
      (session && session.status !== "offline") || hasSubscribers(node.alias, row.network_id) ? "delivered" : "queued";
    // Board #733 — provenance is server-set: an Agent-created schedule names its node in meta and in a
    // prefix the receiving agent always sees first, so it can never pass as a person's schedule.
    const metaJson = JSON.stringify({
      scheduled_task_id: row.schedule_id,
      scheduled_run_id: runId,
      scheduled_for: scheduledFor,
      auth_origin: "hub_scheduler",
      ...(row.created_by_node_id ? { scheduled_by_node_id: row.created_by_node_id, scheduled_by_alias: creatorNode?.alias ?? null } : {}),
    });
    const originalContent = row.created_by_node_id
      ? `${agentSchedulePrefix(creatorNode?.alias ?? null, row.created_by_node_id)}${row.task_content}`
      : row.task_content;
    const taskContent = originalContent + (row.no_change_backoff === 1
      && row.schedule_type === "interval" && row.overlap_policy === "skip"
      && db.transactionalFeaturesRefusal === null ? scheduledOutcomeGuidance(taskId) : "");
    db.run(
      `INSERT INTO inbox (id, task_id, session_name, node_id, type, priority, content, from_session, requires_response, network_id, meta_json)
       VALUES (?1, ?1, ?2, ?3, 'task', ?4, ?5, 'scheduler', 'reply', ?6, ?7)`,
      [taskId, node.alias, node.node_id, row.priority, taskContent, row.network_id, metaJson],
    );
    db.run(
      `INSERT INTO tasks (task_id, from_name, to_node_id, to_name, priority, status, content, requires_response, created_at, delivered_at, expires_at, network_id, meta_json)
       VALUES (?1, 'scheduler', ?2, ?3, ?4, 'delivered', ?5, 'reply', datetime('now'), datetime('now'), datetime('now', '+86400 seconds'), ?6, ?7)`,
      [taskId, node.node_id, node.alias, row.priority, taskContent, row.network_id, metaJson],
    );
    // Dispatch is not completion. Keep the run open until the exact bound
    // task reaches replied/failed/cancelled/expired; db.ts owns that mirror.
    db.run("UPDATE scheduled_task_runs SET task_id = ?1, status = ?2, completed_at = NULL WHERE run_id = ?3", [taskId, deliveryState, runId]);

        // #2622 —— 上一层任务还没跑完时按同因链放慢（间隔 180s 的排程曾一天写 343 行 skip）。
        try {
          applyNoProgressBackoff(row.schedule_id);
        } catch (e: any) {
          console.error(`[scheduled-tasks] no-progress backoff failed schedule=${row.schedule_id}: ${e?.message || e}`);
        }
    db.run(`UPDATE sessions SET task = ${sessionTaskOnDispatch("?1")}, updated_at = datetime('now') WHERE node_id = ?2 AND network_id = ?3`, [sessionTaskPreview(taskContent), node.node_id, row.network_id]);
    db.run("UPDATE scheduled_tasks SET target_alias = ?1, last_run_at = ?2, updated_at = datetime('now') WHERE schedule_id = ?3", [node.alias, scheduledFor, row.schedule_id]);
    if (advanceSchedule) advance({ ...row, target_alias: node.alias }, scheduledFor, advanceAfter);
    createdTaskId = taskId;
    finalStatus = deliveryState;
    event = { alias: node.alias, networkId: row.network_id, taskId, priority: row.priority, state: deliveryState };
  });

  // Everything below is a post-commit doorbell. A logging/SSE failure must
  // never turn a durably-created task into an API-level failure: callers may
  // retry an apparent failure and create a second manual occurrence.
  try {
    for (const t of timedOut) logTaskEvent(t.taskId, t.fromStatus, "expired", "hub-scheduler", `stuck timeout; schedule=${row.schedule_id} run=${runId}`);
    for (const n of notices) sendStuckNotice(n);
    if (offlineNotice) sendOfflineNotice(offlineNotice);
    // #523 — a run that failed at dispatch counts toward the consecutive-failure alert (task failures arrive via db.ts).
    if (finalStatus === "failed") evaluateScheduleFailures(row.schedule_id, advanceAfter);
    if (createdTaskId) logTaskEvent(createdTaskId, null, "delivered", "hub-scheduler", `schedule=${row.schedule_id} run=${runId}`);
    if (event) {
      const pending = db.get<{ cnt: number }>("SELECT COUNT(*) AS cnt FROM inbox WHERE session_name = ?1 AND network_id = ?2 AND acked = 0", event.alias, event.networkId);
      if (event.state === "delivered") pushEvent(event.alias, { type: "new_task", inbox_count: pending?.cnt ?? 1, priority: event.priority, from: "scheduler" }, event.networkId);
      pushNetworkObserverEvent(event.networkId, { type: "new_task", task_id: event.taskId, from: "scheduler", to: event.alias, status: event.state, priority: event.priority });
    }
  } catch (e: any) {
    console.error(`[scheduled-tasks] post-commit notification failed schedule=${row.schedule_id} run=${runId}: ${e?.message || e}`);
  }
  return { runId, taskId: createdTaskId, status: finalStatus, event };
}

// `revision` is the optimistic-concurrency token for *user edits*. Run
// bookkeeping (next_run_at/last_run_at) must not bump it: a 2-minute schedule
// would otherwise turn every edit that spans a run into a 409 and the client
// would drop the user's draft. Terminal completion still bumps, because it is
// a status change the user sees and it is what stops an in-flight PATCH (whose
// UPDATE is guarded by `AND revision = ?`) from reviving a finished one-shot.
function advance(row: ScheduledRow, scheduledFor: string, after = new Date(), recordLastRun = true): void {
  refreshScheduledBackoff(row.schedule_id, row.network_id, after);
  const stored = getScheduleRow(row.schedule_id)!;
  const spec = JSON.parse(row.schedule_json) as ScheduleSpec;
  const effective = spec.type === "interval" && stored.no_change_backoff === 1
    ? { ...spec, every_seconds: Math.max(spec.every_seconds, stored.backoff_effective_seconds ?? spec.every_seconds) } : spec;
  const next = nextOccurrence(effective, row.timezone, after);
  const lastRunAt = recordLastRun ? scheduledFor : row.last_run_at;
  if (spec.type === "once" || !next) {
    db.run(
      "UPDATE scheduled_tasks SET status = 'completed', next_run_at = NULL, last_run_at = ?1, revision = revision + 1, updated_at = datetime('now') WHERE schedule_id = ?2",
      [lastRunAt, row.schedule_id],
    );
  } else {
    db.run(
      "UPDATE scheduled_tasks SET next_run_at = ?1, last_run_at = ?2, updated_at = datetime('now') WHERE schedule_id = ?3",
      [iso(next), lastRunAt, row.schedule_id],
    );
  }
}

function isMissedOccurrence(scheduledFor: string, now: Date): boolean {
  const scheduledAt = new Date(scheduledFor).getTime();
  return Number.isFinite(scheduledAt) && now.getTime() - scheduledAt > MISFIRE_GRACE_MS;
}

function skipScheduledMisfire(row: ScheduledRow, scheduledFor: string, now: Date): void {
  const runId = `srun_${crypto.randomUUID()}`;
  db.transaction(() => {
    db.run(
      `INSERT INTO scheduled_task_runs
       (run_id, schedule_id, network_id, scheduled_for, status, error_code, error_message, completed_at, schedule_revision)
       VALUES (?1, ?2, ?3, ?4, 'skipped', 'misfire_skipped', 'The occurrence was overdue and the schedule is configured to skip missed runs', datetime('now'), ?5)`,
      [runId, row.schedule_id, row.network_id, scheduledFor, row.revision],
    );
    // A skipped occurrence is auditable but is not an execution: preserve
    // last_run_at while moving the schedule directly to its next future slot.
    advance(row, scheduledFor, now, false);
  });
}

export function runDueScheduledTasks(now = new Date(), limit = 100): { processed: number; failed: number } {
  pollRequirementWakes(now);
  const due = db.all<ScheduledRow>(
    `SELECT ${SCHEDULED_TASK_STORAGE_SELECT} FROM scheduled_tasks WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?1 ORDER BY next_run_at LIMIT ?2`,
    iso(now), limit,
  );
  let processed = 0;
  let failed = 0;
  for (const row of due) {
    try {
      // Re-read inside the claim path so a pause/cancel immediately before the
      // tick wins. The unique occurrence key handles a second scheduler.
      const current = db.get<ScheduledRow>(`SELECT ${SCHEDULED_TASK_STORAGE_SELECT} FROM scheduled_tasks WHERE schedule_id = ?1 AND status = 'active' AND next_run_at = ?2`, row.schedule_id, row.next_run_at);
      if (!current?.next_run_at) continue;
      if (current.misfire_policy === "skip" && isMissedOccurrence(current.next_run_at, now)) {
        skipScheduledMisfire(current, current.next_run_at, now);
      } else {
        // catch_up_once is also the compatibility default for pre-migration
        // rows. Advancing from `now` collapses any number of missed slots into
        // one task instead of replaying an outage as a dispatch storm.
        dispatchScheduledOccurrence(current, current.next_run_at, true, now);
      }
      processed++;
    } catch (e: any) {
      if (/UNIQUE|duplicate key/i.test(String(e?.message))) continue;
      failed++;
      console.error(`[scheduled-tasks] occurrence failed schedule=${row.schedule_id}: ${e?.message || e}`);
    }
  }
  return { processed, failed };
}

export function startScheduledTaskScheduler(intervalMs?: number): ReturnType<typeof setInterval> {
  const configured = Number(process.env.COMMHUB_SCHEDULER_TICK_MS);
  const ms = intervalMs && intervalMs > 0 ? intervalMs : configured > 0 ? configured : 10_000;
  // First tick is immediate so a restarted Hub converges without waiting one
  // full cadence. Recurrences advance from "now", intentionally collapsing a
  // long outage into one catch-up occurrence instead of a dispatch storm.
  runDueScheduledTasks();
  return setInterval(() => runDueScheduledTasks(), ms);
}

async function bodyObject(req: Request): Promise<Record<string, unknown>> {
  try {
    const value = await req.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    throw new Error("invalid_json");
  }
}

function writeAllowed(ctx: ScheduledRequestContext, networkId: string | null): boolean {
  return !ctx.isNodeToken && canRestWriteNetwork(ctx.auth, networkId, ctx.isAdmin);
}


type WatcherPublic = { user_id: string; username: string; display_name: string };

function scheduleWatchers(scheduleId: string): WatcherPublic[] {
  return db.all<{ user_id: string; username: string; display_name: string | null }>(
    `SELECT w.user_id, u.username, u.display_name
     FROM scheduled_task_watchers w JOIN users u ON u.user_id = w.user_id
     WHERE w.schedule_id = ?1 ORDER BY u.username`,
    [scheduleId],
  ).map(row => ({ user_id: row.user_id, username: row.username, display_name: row.display_name ?? "" }));
}

function userInNetwork(userId: string, networkId: string): boolean {
  if (db.get("SELECT 1 AS ok FROM network_members WHERE network_id = ?1 AND user_id = ?2", [networkId, userId])) return true;
  return !!db.get("SELECT 1 AS ok FROM networks WHERE network_id = ?1 AND owner_id = ?2", [networkId, userId]);
}

function replaceScheduleWatchers(scheduleId: string, networkId: string, raw: unknown): void {
  if (!Array.isArray(raw) || raw.length > 20) throw new ScheduleInputError("invalid_watchers", 400);
  const ids: string[] = [];
  for (const item of raw) {
    const id = typeof item === "string" ? item : item && typeof item === "object" && typeof (item as { user_id?: unknown }).user_id === "string" ? (item as { user_id: string }).user_id : "";
    if (!id || id.length > 200) throw new ScheduleInputError("invalid_watchers", 400);
    if (!ids.includes(id)) ids.push(id);
  }
  for (const id of ids) {
    if (!userInNetwork(id, networkId)) throw new ScheduleInputError("watcher_not_in_network", 400, { user_id: id });
  }
  db.run("DELETE FROM scheduled_task_watchers WHERE schedule_id = ?1", [scheduleId]);
  for (const id of ids) db.run("INSERT INTO scheduled_task_watchers (schedule_id, user_id) VALUES (?1, ?2)", [scheduleId, id]);
}

function watchingSchedule(scheduleId: string, userId: string | null): boolean {
  if (!userId) return false;
  return !!db.get("SELECT 1 AS ok FROM scheduled_task_watchers WHERE schedule_id = ?1 AND user_id = ?2", [scheduleId, userId]);
}

function canManageWatchers(row: ScheduledRow, ctx: ScheduledRequestContext): boolean {
  const uid = ctx.auth?.userId ?? null;
  if (ctx.isAdmin) return true;
  if (uid && row.created_by === uid) return true;
  return !row.created_by && writeAllowed(ctx, row.network_id);
}

function decorateSchedule(row: ScheduledRow, ctx: ScheduledRequestContext): Record<string, unknown> {
  const watchers = scheduleWatchers(row.schedule_id);
  const uid = ctx.auth?.userId ?? null;
  const isWatcher = !!uid && watchers.some(w => w.user_id === uid);
  return {
    ...decodeRow(row),
    watchers,
    is_watcher: isWatcher,
    can_edit: writeAllowed(ctx, row.network_id) || isWatcher,
    can_manage_watchers: canManageWatchers(row, ctx),
  };
}

export async function handleScheduledTaskRequest(ctx: ScheduledRequestContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname !== "/api/scheduled-tasks" && !url.pathname.startsWith("/api/scheduled-tasks/")) return null;
  if (ctx.isNodeToken) return jsonError("user_token_required", 403);

  if (url.pathname === "/api/scheduled-tasks" && req.method === "GET") {
    const params: unknown[] = [];
    let sql = `SELECT ${SCHEDULED_TASK_STORAGE_SELECT} FROM scheduled_tasks WHERE 1=1`;
    sql = addNetworkScope(sql, params, ctx.scope);
    const status = url.searchParams.get("status");
    if (status) { sql += ` AND status = ?${params.length + 1}`; params.push(status); }
    sql += " ORDER BY updated_at DESC LIMIT 500";
    return Response.json({ ok: true, schedules: db.all<ScheduledRow>(sql, ...params).map(row => decorateSchedule(row, ctx)) });
  }

  if (url.pathname === "/api/scheduled-tasks" && req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
    const networkId = resolveWriteNetwork(body, ctx);
    if (!networkId) return jsonError("network_id_required", 400);
    if (!writeAllowed(ctx, networkId)) return jsonError("permission_denied", 403);
    try {
      const created = insertSchedule(networkId, ctx.auth?.userId ?? null, null, validateScheduleCreate(networkId, body));
      if (body.watchers !== undefined) replaceScheduleWatchers(created.schedule_id, networkId, body.watchers);
      return Response.json({ ok: true, schedule: decorateSchedule(getScheduleRow(created.schedule_id)!, ctx) }, { status: 201 });
    } catch (e: any) {
      if (e instanceof ScheduleInputError) return jsonError(e.code, e.status, e.extra);
      const code = String(e?.message || "invalid_schedule");
      const status = code === "target_node_not_found" ? 404 : 400;
      return jsonError(code, status);
    }
  }

  const match = url.pathname.match(/^\/api\/scheduled-tasks\/([^/]+)(?:\/(runs|run-now|cancel))?$/);
  if (!match) return jsonError("not_found", 404);
  const scheduleId = decodeURIComponent(match[1]);
  const sub = match[2] || null;
  const row = scopedSchedule(scheduleId, ctx.scope);
  if (!row) return jsonError("schedule_not_found", 404);

  if (sub === "runs" && req.method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
    return Response.json({ ok: true, ...scheduleRuns(row, limit) });
  }
  if (!sub && req.method === "GET") return Response.json({ ok: true, schedule: decorateSchedule(row, ctx) });
  const watcher = watchingSchedule(row.schedule_id, ctx.auth?.userId ?? null);
  const writer = writeAllowed(ctx, row.network_id);
  if (!writer && !watcher) return jsonError("permission_denied", 403);
  if (!writer && (sub === "cancel" || (!sub && req.method === "DELETE"))) return jsonError("watcher_cannot_cancel", 403);
  if (!writer && sub === "run-now") return jsonError("watcher_cannot_run", 403);

  if (sub === "run-now" && req.method === "POST") {
    if (row.status === "cancelled") return jsonError("schedule_cancelled", 409);
    try {
      const result = dispatchScheduledOccurrence(row, iso(new Date()), false);
      return Response.json({ ok: true, ...result }, { status: result.status === "failed" ? 409 : 202 });
    } catch (e: any) {
      return jsonError("dispatch_failed", 409, { message: String(e?.message || e).slice(0, 500) });
    }
  }

  // Cancel — accept two spellings for the same operation:
  //   DELETE /api/scheduled-tasks/:id            (original)
  //   POST   /api/scheduled-tasks/:id/cancel     (added because some reverse
  //                                              proxies swallow DELETE and
  //                                              return 405 HTML; POST is
  //                                              universally allowed)
  // Idempotent: re-cancelling an already-cancelled row is a 200 no-op, not a
  // 409, because a client that just saw the row (still on screen as
  // "cancelled" between polls) should get the same outcome whether it's the
  // first click or a retry.
  if ((!sub && req.method === "DELETE") || (sub === "cancel" && req.method === "POST")) {
    cancelSchedule(row);
    return Response.json({ ok: true, status: "cancelled" });
  }

  if (!sub && req.method === "PATCH") {
    let body: Record<string, unknown>;
    try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
    if (body.watchers !== undefined && !canManageWatchers(row, ctx)) return jsonError("watcher_cannot_manage_watchers", 403);
    try {
      const updated = patchSchedule(row, body, ctx.auth?.userId ?? null);
      if (body.watchers !== undefined) replaceScheduleWatchers(updated.schedule_id, updated.network_id, body.watchers);
      return Response.json({ ok: true, schedule: decorateSchedule(getScheduleRow(updated.schedule_id)!, ctx) });
    } catch (e: any) {
      if (e instanceof ScheduleInputError) return jsonError(e.code, e.status, e.extra);
      throw e;
    }
  }
  return jsonError("method_not_allowed", 405);
}
