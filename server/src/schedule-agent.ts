// Board #733 — Agents manage Hub scheduled tasks over MCP (schedule_* tools in tools.ts).
//
// REST /api/scheduled-tasks stays people-only (node tokens → 403 user_token_required). This module is the
// agent surface; every validation / write goes through the same helpers as REST (scheduled-tasks.ts).
//
// Permission model (node token = one bound node in one network):
//   • Scope: only schedules in the token's network that TARGET this node or that this node CREATED
//     (created_by_node_id). Anything else reads as schedule_not_found (no existence probe).
//   • Write gate: the owner must be able to write in the network (same canWrite as send_task), and a
//     read-only node (permission_mode=readonly) cannot mutate schedules at all.
//   • Target gate: a schedule (create, retarget, update, run-now) aimed at another node needs exactly the
//     verdict send_task gets for that target (node-permissions.ts dispatchVerdict, owner's Agent grants +
//     the node's mode). Stricter than send_task in one way: the verdict is enforced even under
//     COMMHUB_NODE_PERMISSIONS=log, because the scheduler would refuse the run later anyway.
//   • Mutations (update / pause / resume / cancel / run_now) only on schedules THIS node created
//     (created_by_node_id = self). A person's schedule that targets the node is read-only for it.
//   • created_by = the node's owner user id (the identity send_task's dispatchVerdict checks), so the
//     scheduler's per-run canMessageAgent(created_by, …) keeps re-checking the owner's grants on every run.
//     A node without a known owner cannot create schedules (a NULL created_by would skip that re-check).
//   • Quota: ≤ COMMHUB_AGENT_SCHEDULE_QUOTA (default 20) active/paused schedules created per node.
//     Minimum cadence is the shared parseScheduleSpec rule (interval ≥ 60 s), the same as REST.

import { db } from "./db.js";
import {
  cancelSchedule, decodeRowForAgent, dispatchScheduledOccurrence, getScheduleRow, insertSchedule, patchSchedule,
  scheduleRuns, ScheduleInputError, validateScheduleCreate, parseScheduleSpec, type ScheduledRow,
} from "./scheduled-tasks.js";
import { SCHEDULED_TASK_STORAGE_SELECT } from "./rest-projections.js";
import { dispatchVerdict, nodePermissionDeniedBody, recordNodePermission, type NodeIdentity } from "./node-permissions.js";

export type AgentScheduleResult = Record<string, unknown> & { ok: boolean };

export function agentScheduleQuota(): number {
  const n = Number(process.env.COMMHUB_AGENT_SCHEDULE_QUOTA);
  return Number.isSafeInteger(n) && n > 0 ? n : 20;
}

const fail = (error: string, extra: Record<string, unknown> = {}): AgentScheduleResult => ({ ok: false, error, ...extra });

/** The scope rule. Exported so the mutation tests can pin it. */
export function nodeMaySeeSchedule(id: NodeIdentity, row: ScheduledRow): boolean {
  if (!id.nodeId || row.network_id !== id.networkId) return false;
  return row.target_node_id === id.nodeId || row.created_by_node_id === id.nodeId;
}

function visibleRow(id: NodeIdentity, scheduleId: string): ScheduledRow | null {
  const row = getScheduleRow(scheduleId);
  return row && nodeMaySeeSchedule(id, row) ? row : null;
}

/** Visible AND created by this node; else the error to return. Exported for the mutation tests. */
export function nodeMayMutateSchedule(id: NodeIdentity, row: ScheduledRow): boolean {
  return !!id.nodeId && row.created_by_node_id === id.nodeId;
}
function ownRow(id: NodeIdentity, scheduleId: string): ScheduledRow | AgentScheduleResult {
  const row = visibleRow(id, scheduleId);
  if (!row) return fail("schedule_not_found");
  if (!nodeMayMutateSchedule(id, row)) return fail("not_schedule_creator", { message: "only schedules this node created can be changed" });
  return row;
}
const isRow = (r: ScheduledRow | AgentScheduleResult): r is ScheduledRow => typeof (r as ScheduledRow).schedule_id === "string";

/** send_task's verdict for this target, always enforced (see header). null = allowed. */
function targetDenied(id: NodeIdentity, route: string, target: { node_id: string; alias: string }): AgentScheduleResult | null {
  const verdict = dispatchVerdict(id, { alias: target.alias, nodeId: target.node_id });
  if (!verdict) return null;
  recordNodePermission(id, route, verdict.reason, verdict.sample);
  return { ...nodePermissionDeniedBody(verdict.reason, route) };
}

function writeGate(id: NodeIdentity, canWrite: boolean, route: string): AgentScheduleResult | null {
  if (!id.nodeId) return fail("node_identity_unbound");
  if (!canWrite) return fail("permission_denied", { message: "this node's owner cannot write in this network" });
  if (id.mode === "readonly") return { ...nodePermissionDeniedBody("mode_readonly", route) };
  return null;
}

function inputError(e: any): AgentScheduleResult {
  if (e instanceof ScheduleInputError) return fail(e.code, e.extra);
  return fail(String(e?.message || "invalid_schedule"));
}

export function agentListSchedules(id: NodeIdentity, status?: string): AgentScheduleResult {
  if (!id.nodeId) return fail("node_identity_unbound");
  const params: unknown[] = [id.networkId, id.nodeId];
  let sql = `SELECT ${SCHEDULED_TASK_STORAGE_SELECT} FROM scheduled_tasks WHERE network_id = ?1 AND (target_node_id = ?2 OR created_by_node_id = ?2)`;
  if (status) { sql += " AND status = ?3"; params.push(status); }
  sql += " ORDER BY updated_at DESC LIMIT 200";
  return { ok: true, schedules: db.all<ScheduledRow>(sql, ...params).map(decodeRowForAgent) };
}

export function agentGetSchedule(id: NodeIdentity, scheduleId: string): AgentScheduleResult {
  const row = visibleRow(id, scheduleId);
  return row ? { ok: true, schedule: decodeRowForAgent(row) } : fail("schedule_not_found");
}

export function agentScheduleRuns(id: NodeIdentity, scheduleId: string, limit?: number): AgentScheduleResult {
  const row = visibleRow(id, scheduleId);
  if (!row) return fail("schedule_not_found");
  return { ok: true, ...scheduleRuns(row, Math.max(1, Math.min(200, Math.floor(Number(limit)) || 50))) };
}

export function agentCreateSchedule(id: NodeIdentity, canWrite: boolean, body: Record<string, unknown>): AgentScheduleResult {
  const route = "mcp:schedule_create";
  const gate = writeGate(id, canWrite, route);
  if (gate) return gate;
  if (!id.ownerUserId) return { ...nodePermissionDeniedBody("owner_unknown", route) };
  const input = { ...body, target_node_id: body.target_node_id ?? id.nodeId };
  let v: ReturnType<typeof validateScheduleCreate>;
  try { v = validateScheduleCreate(id.networkId, input); } catch (e) { return inputError(e); }
  const denied = targetDenied(id, route, v.target);
  if (denied) return denied;
  const quota = agentScheduleQuota();
  const used = Number(db.get<{ n: number | string }>(
    "SELECT COUNT(*) AS n FROM scheduled_tasks WHERE network_id = ?1 AND created_by_node_id = ?2 AND status IN ('active', 'paused')",
    id.networkId, id.nodeId,
  )?.n ?? 0);
  if (used >= quota) return fail("schedule_quota_exceeded", { quota, active: used, message: "cancel one of this node's schedules first" });
  const row = insertSchedule(id.networkId, id.ownerUserId, id.nodeId, v);
  return { ok: true, schedule: decodeRowForAgent(row) };
}

export function agentUpdateSchedule(id: NodeIdentity, canWrite: boolean, scheduleId: string, body: Record<string, unknown>): AgentScheduleResult {
  const route = "mcp:schedule_update";
  const gate = writeGate(id, canWrite, route);
  if (gate) return gate;
  const row = ownRow(id, scheduleId);
  if (!isRow(row)) return row;
  if (body.base_revision !== undefined && Number(body.base_revision) !== row.revision) {
    return fail("revision_conflict", { current_revision: row.revision });
  }
  const retarget = body.target_node_id !== undefined && body.target_node_id !== row.target_node_id;
  let target = { node_id: row.target_node_id, alias: row.target_alias };
  if (retarget) {
    const node = db.get<{ node_id: string; alias: string | null }>(
      "SELECT node_id, alias FROM nodes WHERE node_id = ?1 AND network_id = ?2", String(body.target_node_id), row.network_id);
    if (!node?.alias) return fail("target_node_not_found");
    target = { node_id: node.node_id, alias: node.alias };
  }
  const denied = targetDenied(id, route, target);
  if (denied) return denied;
  try {
    const patched = patchSchedule(row, { ...body, revision: body.revision ?? row.revision });
    return { ok: true, schedule: decodeRowForAgent(patched) };
  } catch (e) { return inputError(e); }
}

/** #816: partial success, one result per distinct ID; no change to existing write authority. */
export function agentBatchScheduleInterval(id: NodeIdentity, canWrite: boolean, scheduleIds: string[], everySeconds: number): AgentScheduleResult {
  const gate = writeGate(id, canWrite, "mcp:schedule_batch_interval");
  if (gate) return gate;
  const schedule = { type: "interval", every_seconds: everySeconds };
  try { parseScheduleSpec(schedule, "UTC"); } catch (e) { return inputError(e); }
  const results = [...new Set(scheduleIds)].map(schedule_id => {
    const row = ownRow(id, schedule_id);
    if (!isRow(row)) return { schedule_id, ...row };
    if (row.schedule_type !== "interval") return { schedule_id, ok: false, error: "not_interval_schedule" };
    const result = agentUpdateSchedule(id, canWrite, schedule_id, { schedule, base_revision: row.revision });
    if (!result.ok) return { schedule_id, ...result };
    const updated = result.schedule as ReturnType<typeof decodeRowForAgent>;
    return { schedule_id, ok: true, every_seconds: everySeconds, next_run_at: updated.next_run_at, status: updated.status, revision: updated.revision };
  });
  const updated = results.filter(r => r.ok).length;
  return { ok: updated === results.length, updated, failed: results.length - updated, results };
}

export function agentCancelSchedule(id: NodeIdentity, canWrite: boolean, scheduleId: string): AgentScheduleResult {
  const gate = writeGate(id, canWrite, "mcp:schedule_cancel");
  if (gate) return gate;
  const row = ownRow(id, scheduleId);
  if (!isRow(row)) return row;
  cancelSchedule(row);
  return { ok: true, status: "cancelled" };
}

export function agentRunScheduleNow(id: NodeIdentity, canWrite: boolean, scheduleId: string): AgentScheduleResult {
  const route = "mcp:schedule_run_now";
  const gate = writeGate(id, canWrite, route);
  if (gate) return gate;
  const row = ownRow(id, scheduleId);
  if (!isRow(row)) return row;
  if (row.status === "cancelled") return fail("schedule_cancelled");
  const denied = targetDenied(id, route, { node_id: row.target_node_id, alias: row.target_alias });
  if (denied) return denied;
  try {
    const result = dispatchScheduledOccurrence(row, new Date().toISOString(), false);
    const { event: _event, ...rest } = result;
    return { ok: result.status !== "failed", ...rest };
  } catch (e: any) {
    return fail("dispatch_failed", { message: String(e?.message || e).slice(0, 500) });
  }
}
