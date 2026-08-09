import { db, logTaskEvent } from "./db.js";
import { assertNodeActive } from "./lifecycle-guard.js";
import { addNetworkScope, canRestWriteNetwork, singleNetworkId, type RestNetworkScope } from "./network-scope.js";
import { pushEvent, pushNetworkObserverEvent } from "./push.js";

export type ScheduleSpec =
  | { type: "once"; run_at: string }
  | { type: "interval"; every_seconds: number }
  | { type: "daily"; time: string }
  | { type: "weekly"; time: string; weekdays: number[] };

type ScheduledRow = {
  schedule_id: string;
  network_id: string;
  created_by: string | null;
  name: string;
  target_node_id: string;
  target_alias: string;
  task_content: string;
  priority: "high" | "normal" | "low";
  schedule_type: ScheduleSpec["type"];
  schedule_json: string;
  timezone: string;
  overlap_policy: "skip" | "allow";
  status: "active" | "paused" | "completed" | "cancelled";
  next_run_at: string | null;
  last_run_at: string | null;
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

function decodeRow(row: ScheduledRow): Record<string, unknown> {
  let schedule: unknown = null;
  try { schedule = JSON.parse(row.schedule_json); } catch {}
  const { created_by: _createdBy, schedule_json: _scheduleJson, ...publicRow } = row;
  return { ...publicRow, schedule };
}

function scopedSchedule(scheduleId: string, scope: RestNetworkScope): ScheduledRow | null {
  const params: unknown[] = [scheduleId];
  let sql = "SELECT * FROM scheduled_tasks WHERE schedule_id = ?1";
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

type DispatchEvent = { alias: string; networkId: string; taskId: string; priority: string; state: "delivered" | "queued" };

export function dispatchScheduledOccurrence(row: ScheduledRow, scheduledFor: string, advanceSchedule: boolean): { runId: string; taskId?: string; status: string; event?: DispatchEvent } {
  const runId = `srun_${crypto.randomUUID()}`;
  let event: DispatchEvent | undefined;
  let finalStatus = "failed";
  let createdTaskId: string | undefined;

  db.transaction(() => {
    // UNIQUE(schedule_id, scheduled_for) is the cross-process claim. If two
    // Hub processes race, one INSERT wins and the other transaction aborts.
    db.run(
      `INSERT INTO scheduled_task_runs (run_id, schedule_id, network_id, scheduled_for, status)
       VALUES (?1, ?2, ?3, ?4, 'claiming')`,
      [runId, row.schedule_id, row.network_id, scheduledFor],
    );

    if (row.overlap_policy === "skip") {
      const placeholders = OPEN_TASK_STATUSES.map((_, i) => `?${i + 2}`).join(", ");
      const open = db.get<{ task_id: string }>(
        `SELECT r.task_id FROM scheduled_task_runs r
         JOIN tasks t ON t.task_id = r.task_id
         WHERE r.schedule_id = ?1 AND t.status IN (${placeholders})
         ORDER BY r.created_at DESC LIMIT 1`,
        row.schedule_id, ...OPEN_TASK_STATUSES,
      );
      if (open) {
        finalStatus = "skipped";
        db.run(
          "UPDATE scheduled_task_runs SET status = 'skipped', error_code = 'previous_run_active', completed_at = datetime('now') WHERE run_id = ?1",
          [runId],
        );
        if (advanceSchedule) advance(row, scheduledFor);
        return;
      }
    }

    const node = db.get<{ node_id: string; alias: string | null }>(
      "SELECT node_id, alias FROM nodes WHERE node_id = ?1 AND network_id = ?2",
      row.target_node_id, row.network_id,
    );
    if (!node?.alias) {
      finalStatus = "failed";
      db.run(
        "UPDATE scheduled_task_runs SET status = 'failed', error_code = 'target_node_not_found', error_message = 'The bound node no longer exists in this network', completed_at = datetime('now') WHERE run_id = ?1",
        [runId],
      );
      if (advanceSchedule) advance(row, scheduledFor);
      return;
    }
    const lifecycle = assertNodeActive(node.alias, row.network_id);
    if (!lifecycle.ok) {
      finalStatus = "failed";
      db.run(
        "UPDATE scheduled_task_runs SET status = 'failed', error_code = 'target_not_active', error_message = ?1, completed_at = datetime('now') WHERE run_id = ?2",
        [String((lifecycle as any).error || "target_not_active").slice(0, 500), runId],
      );
      if (advanceSchedule) advance(row, scheduledFor);
      return;
    }

    const taskId = crypto.randomUUID();
    const session = db.get<{ status: string | null }>(
      "SELECT status FROM sessions WHERE node_id = ?1 AND network_id = ?2 ORDER BY updated_at DESC LIMIT 1",
      row.target_node_id, row.network_id,
    );
    const deliveryState: "delivered" | "queued" = session && session.status !== "offline" ? "delivered" : "queued";
    const metaJson = JSON.stringify({
      scheduled_task_id: row.schedule_id,
      scheduled_run_id: runId,
      scheduled_for: scheduledFor,
      created_by: row.created_by,
      auth_origin: "hub_scheduler",
    });
    db.run(
      `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, requires_response, network_id, meta_json)
       VALUES (?1, ?2, ?3, 'task', ?4, ?5, 'scheduler', 'reply', ?6, ?7)`,
      [taskId, node.alias, node.node_id, row.priority, row.task_content, row.network_id, metaJson],
    );
    db.run(
      `INSERT INTO tasks (task_id, from_name, to_node_id, to_name, priority, status, content, requires_response, created_at, delivered_at, expires_at, network_id, meta_json)
       VALUES (?1, 'scheduler', ?2, ?3, ?4, 'delivered', ?5, 'reply', datetime('now'), datetime('now'), datetime('now', '+86400 seconds'), ?6, ?7)`,
      [taskId, node.node_id, node.alias, row.priority, row.task_content, row.network_id, metaJson],
    );
    db.run("UPDATE scheduled_task_runs SET task_id = ?1, status = ?2, completed_at = datetime('now') WHERE run_id = ?3", [taskId, deliveryState, runId]);
    db.run("UPDATE sessions SET task = ?1, updated_at = datetime('now') WHERE node_id = ?2 AND network_id = ?3", [row.task_content.slice(0, 200), node.node_id, row.network_id]);
    db.run("UPDATE scheduled_tasks SET target_alias = ?1, last_run_at = ?2, updated_at = datetime('now') WHERE schedule_id = ?3", [node.alias, scheduledFor, row.schedule_id]);
    if (advanceSchedule) advance({ ...row, target_alias: node.alias }, scheduledFor);
    createdTaskId = taskId;
    finalStatus = deliveryState;
    event = { alias: node.alias, networkId: row.network_id, taskId, priority: row.priority, state: deliveryState };
  });

  // Everything below is a post-commit doorbell. A logging/SSE failure must
  // never turn a durably-created task into an API-level failure: callers may
  // retry an apparent failure and create a second manual occurrence.
  try {
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

function advance(row: ScheduledRow, scheduledFor: string): void {
  const spec = JSON.parse(row.schedule_json) as ScheduleSpec;
  const next = nextOccurrence(spec, row.timezone, new Date());
  if (spec.type === "once" || !next) {
    db.run(
      "UPDATE scheduled_tasks SET status = 'completed', next_run_at = NULL, last_run_at = ?1, revision = revision + 1, updated_at = datetime('now') WHERE schedule_id = ?2",
      [scheduledFor, row.schedule_id],
    );
  } else {
    db.run(
      "UPDATE scheduled_tasks SET next_run_at = ?1, last_run_at = ?2, revision = revision + 1, updated_at = datetime('now') WHERE schedule_id = ?3",
      [iso(next), scheduledFor, row.schedule_id],
    );
  }
}

export function runDueScheduledTasks(now = new Date(), limit = 100): { processed: number; failed: number } {
  const due = db.all<ScheduledRow>(
    "SELECT * FROM scheduled_tasks WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?1 ORDER BY next_run_at LIMIT ?2",
    iso(now), limit,
  );
  let processed = 0;
  let failed = 0;
  for (const row of due) {
    try {
      // Re-read inside the claim path so a pause/cancel immediately before the
      // tick wins. The unique occurrence key handles a second scheduler.
      const current = db.get<ScheduledRow>("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1 AND status = 'active' AND next_run_at = ?2", row.schedule_id, row.next_run_at);
      if (!current?.next_run_at) continue;
      dispatchScheduledOccurrence(current, current.next_run_at, true);
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

export async function handleScheduledTaskRequest(ctx: ScheduledRequestContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname !== "/api/scheduled-tasks" && !url.pathname.startsWith("/api/scheduled-tasks/")) return null;
  if (ctx.isNodeToken) return jsonError("user_token_required", 403);

  if (url.pathname === "/api/scheduled-tasks" && req.method === "GET") {
    const params: unknown[] = [];
    let sql = "SELECT * FROM scheduled_tasks WHERE 1=1";
    sql = addNetworkScope(sql, params, ctx.scope);
    const status = url.searchParams.get("status");
    if (status) { sql += ` AND status = ?${params.length + 1}`; params.push(status); }
    sql += " ORDER BY updated_at DESC LIMIT 500";
    return Response.json({ ok: true, schedules: db.all<ScheduledRow>(sql, ...params).map(decodeRow) });
  }

  if (url.pathname === "/api/scheduled-tasks" && req.method === "POST") {
    let body: Record<string, unknown>;
    try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
    const networkId = resolveWriteNetwork(body, ctx);
    if (!networkId) return jsonError("network_id_required", 400);
    if (!writeAllowed(ctx, networkId)) return jsonError("permission_denied", 403);
    try {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const content = typeof body.task === "string" ? body.task.trim() : "";
      if (!name || name.length > 120) throw new Error("invalid_name");
      if (!content || content.length > 10_000) throw new Error("invalid_task");
      const priority = typeof body.priority === "string" ? body.priority : "normal";
      if (!PRIORITIES.has(priority)) throw new Error("invalid_priority");
      const target = validateTarget(networkId, body.target_node_id);
      const { spec, timezone } = parseScheduleSpec(body.schedule, body.timezone);
      const next = nextOccurrence(spec, timezone, new Date());
      if (!next) throw new Error("schedule_has_no_future_occurrence");
      const scheduleId = `sched_${crypto.randomUUID()}`;
      db.run(
        `INSERT INTO scheduled_tasks
         (schedule_id, network_id, created_by, name, target_node_id, target_alias, task_content, priority, schedule_type, schedule_json, timezone, overlap_policy, next_run_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'skip', ?12)`,
        [scheduleId, networkId, ctx.auth?.userId ?? null, name, target.node_id, target.alias, content, priority, spec.type, JSON.stringify(spec), timezone, iso(next)],
      );
      const created = db.get<ScheduledRow>("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", scheduleId)!;
      return Response.json({ ok: true, schedule: decodeRow(created) }, { status: 201 });
    } catch (e: any) {
      const code = String(e?.message || "invalid_schedule");
      const status = code === "target_node_not_found" ? 404 : 400;
      return jsonError(code, status);
    }
  }

  const match = url.pathname.match(/^\/api\/scheduled-tasks\/([^/]+)(?:\/(runs|run-now))?$/);
  if (!match) return jsonError("not_found", 404);
  const scheduleId = decodeURIComponent(match[1]);
  const sub = match[2] || null;
  const row = scopedSchedule(scheduleId, ctx.scope);
  if (!row) return jsonError("schedule_not_found", 404);

  if (sub === "runs" && req.method === "GET") {
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
    const runs = db.all(
      "SELECT run_id, schedule_id, scheduled_for, task_id, status, error_code, error_message, created_at, completed_at FROM scheduled_task_runs WHERE schedule_id = ?1 AND network_id = ?2 ORDER BY created_at DESC LIMIT ?3",
      row.schedule_id, row.network_id, limit,
    );
    return Response.json({ ok: true, runs });
  }
  if (!sub && req.method === "GET") return Response.json({ ok: true, schedule: decodeRow(row) });
  if (!writeAllowed(ctx, row.network_id)) return jsonError("permission_denied", 403);

  if (sub === "run-now" && req.method === "POST") {
    if (row.status === "cancelled") return jsonError("schedule_cancelled", 409);
    try {
      const result = dispatchScheduledOccurrence(row, iso(new Date()), false);
      return Response.json({ ok: true, ...result }, { status: result.status === "failed" ? 409 : 202 });
    } catch (e: any) {
      return jsonError("dispatch_failed", 409, { message: String(e?.message || e).slice(0, 500) });
    }
  }

  if (!sub && req.method === "DELETE") {
    db.run("UPDATE scheduled_tasks SET status = 'cancelled', next_run_at = NULL, revision = revision + 1, updated_at = datetime('now') WHERE schedule_id = ?1", [row.schedule_id]);
    return Response.json({ ok: true, status: "cancelled" });
  }

  if (!sub && req.method === "PATCH") {
    let body: Record<string, unknown>;
    try { body = await bodyObject(req); } catch { return jsonError("invalid_json", 400); }
    if (!Number.isSafeInteger(body.revision) || Number(body.revision) !== row.revision) return jsonError("revision_conflict", 409, { current_revision: row.revision });
    try {
      const name = body.name === undefined ? row.name : String(body.name).trim();
      const content = body.task === undefined ? row.task_content : String(body.task).trim();
      const priority = body.priority === undefined ? row.priority : String(body.priority);
      if (!name || name.length > 120) throw new Error("invalid_name");
      if (!content || content.length > 10_000) throw new Error("invalid_task");
      if (!PRIORITIES.has(priority)) throw new Error("invalid_priority");
      const target = body.target_node_id === undefined ? { node_id: row.target_node_id, alias: row.target_alias } : validateTarget(row.network_id, body.target_node_id);
      const parsed = body.schedule === undefined
        ? { spec: JSON.parse(row.schedule_json) as ScheduleSpec, timezone: body.timezone === undefined ? row.timezone : String(body.timezone) }
        : parseScheduleSpec(body.schedule, body.timezone === undefined ? row.timezone : body.timezone);
      if (!validTimezone(parsed.timezone)) throw new Error("invalid_timezone");
      const requestedStatus = body.status === undefined ? row.status : String(body.status);
      if (!new Set(["active", "paused"]).has(requestedStatus)) throw new Error("invalid_status");
      const next = requestedStatus === "active" ? nextOccurrence(parsed.spec, parsed.timezone, new Date()) : null;
      if (requestedStatus === "active" && !next) throw new Error("schedule_has_no_future_occurrence");
      const updated = db.run(
        `UPDATE scheduled_tasks SET name = ?1, target_node_id = ?2, target_alias = ?3, task_content = ?4,
         priority = ?5, schedule_type = ?6, schedule_json = ?7, timezone = ?8, status = ?9, next_run_at = ?10,
         revision = revision + 1, updated_at = datetime('now') WHERE schedule_id = ?11 AND revision = ?12`,
        [name, target.node_id, target.alias, content, priority, parsed.spec.type, JSON.stringify(parsed.spec), parsed.timezone, requestedStatus, next ? iso(next) : null, row.schedule_id, row.revision],
      );
      if (updated.changes !== 1) return jsonError("revision_conflict", 409);
      return Response.json({ ok: true, schedule: decodeRow(db.get<ScheduledRow>("SELECT * FROM scheduled_tasks WHERE schedule_id = ?1", row.schedule_id)!) });
    } catch (e: any) {
      const code = String(e?.message || "invalid_schedule");
      return jsonError(code, code === "target_node_not_found" ? 404 : 400);
    }
  }
  return jsonError("method_not_allowed", 405);
}
