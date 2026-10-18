import { db } from "./db.js";
import { ensureRequirementEvents } from "./requirement-events.js";
import { canSeeTask, canUseProject, type TaskCaller } from "./task-access.js";
import { setRequirementWakeHook } from "./scheduled-backoff.js";
import { parseHubTimestamp } from "./hub-timestamp.js";

ensureRequirementEvents(db);
export type RequirementWake = { project_id: string | null; tag: string | null };
type StoredWake = RequirementWake & { creator_user_id: string; target_owner_user_id: string; configured_by_user_id: string };
type Plan = { schedule_id?: string; network_id: string; created_by: string | null;
  created_by_node_id: string | null; target_node_id: string };

/** No implicit broad access when identity/membership is gone. Read current
 * node mode and owner, rather than a token alias or a cached permission flag. */
function principal(userId: string | null, network: string, nodeId?: string | null): TaskCaller {
  let only = false;
  if (nodeId) {
    const node = db.get<any>("SELECT owner_user_id, permission_mode FROM nodes WHERE node_id = ?1 AND network_id = ?2", nodeId, network);
    if (!node || node.permission_mode === "readonly") return null;
    userId = node.owner_user_id; only = node.permission_mode === "restricted";
  }
  if (!userId || !db.get("SELECT 1 FROM network_members m JOIN users u ON u.user_id = m.user_id WHERE m.user_id = ?1 AND m.network_id = ?2 AND m.role != 'viewer'", userId, network)) return null;
  return { userId, ...(nodeId ? { node: { id: nodeId, only } } : {}) };
}
function audience(row: Plan) {
  return { creator: principal(row.created_by, row.network_id, row.created_by_node_id),
    target: principal(null, row.network_id, row.target_node_id) };
}
export function parseRequirementWake(raw: unknown, fallback: string | null = null): RequirementWake | null {
  if (raw === undefined) return fallback ? publicRequirementWake(fallback) : null;
  if (raw === null) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid_requirement_wake");
  const p = raw as Record<string, unknown>;
  if (Object.keys(p).some(k => k !== "project_id" && k !== "tag")) throw new Error("invalid_requirement_wake");
  const project = p.project_id ?? null, tag = p.tag ?? null;
  if (project !== null && (typeof project !== "string" || !project || project.length > 200)
    || tag !== null && (typeof tag !== "string" || !tag.trim() || tag.length > 20)
    || project === null && tag === null) throw new Error("invalid_requirement_wake");
  return { project_id: project as string | null, tag: tag as string | null };
}
export function publicRequirementWake(json: string): RequirementWake {
  const p = JSON.parse(json); return { project_id: p.project_id, tag: p.tag };
}
export function requirementWakeHead(network: string): number {
  return Number(db.get<any>("SELECT COALESCE(MAX(id), 0) AS id FROM requirement_events WHERE network_id = ?1", network)!.id);
}
/** Called by the existing authorized creator/editor paths. No production
 * plans are opted in by migration. The config records the creator authority. */
export function bindRequirementWake(row: Plan, policy: RequirementWake | null, enabled: boolean, type: string, configuratorUserId: string | null): string | null {
  if (!policy) return null;
  if (!enabled || type !== "interval") throw new Error("requirement_wake_requires_backoff_interval");
  const a = audience(row), configurator = principal(configuratorUserId, row.network_id);
  if (!a.creator || !a.target || !configurator) throw new Error("requirement_wake_identity_unresolved");
  if (policy.project_id && (!db.get("SELECT 1 FROM requirement_projects WHERE project_id = ?1 AND network_id = ?2", policy.project_id, row.network_id)
    || !canUseProject(a.creator, row.network_id, policy.project_id) || !canUseProject(configurator, row.network_id, policy.project_id))) throw new Error("requirement_wake_scope_not_visible");
  return JSON.stringify({ ...policy, creator_user_id: a.creator.userId, target_owner_user_id: a.target.userId, configured_by_user_id: configurator.userId } satisfies StoredWake);
}

/** One cursor and generation update, atomic with the calling reply/dispatch
 * transaction. Any write fault propagates; no consume-then-forget window. */
export function consumeRequirementWake(id: string, network: string, now = new Date()): boolean {
  if (db.transactionalFeaturesRefusal !== null) return false;
  return db.transaction(() => {
    const row = db.get<any>(`SELECT schedule_id, network_id, created_by, created_by_node_id, target_node_id,
      status, revision, schedule_json, no_change_backoff, requirement_wake_json, requirement_wake_cursor,
      next_run_at FROM scheduled_tasks WHERE schedule_id = ?1 AND network_id = ?2`, id, network);
    if (!row || row.status !== "active" || row.no_change_backoff !== 1 || !row.requirement_wake_json) return false;
    const spec = JSON.parse(row.schedule_json); if (spec.type !== "interval") return false;
    const policy: StoredWake = JSON.parse(row.requirement_wake_json), a = audience(row);
    const configurator = principal(policy.configured_by_user_id, network);
    const allowed = configurator && a.creator && a.target && a.creator.userId === policy.creator_user_id
      && a.target.userId === policy.target_owner_user_id;
    // Cursor is advanced even for invisible/irrelevant events, so a later
    // permission grant cannot replay history hidden at the consumption time.
    const events = db.all<any>(`SELECT id, requirement_id, actor_json, kind, field, old_json, new_json
      FROM requirement_events WHERE network_id = ?1 AND id > ?2 ORDER BY id LIMIT 256`, network, row.requirement_wake_cursor);
    if (!events.length) return false;
    let matching: number | null = null;
    for (const event of events) {
      if (!allowed || !(event.kind === "created" || event.kind === "changed" && event.field === "column")) continue;
      let actor: any; try { actor = JSON.parse(event.actor_json); } catch { continue; }
      if (!actor || !["user", "node"].includes(actor.kind) || typeof actor.id !== "string") continue;
      if (actor.kind === "node" && [row.target_node_id, row.created_by_node_id].includes(actor.id)) continue;
      if (event.kind === "changed") {
        const states = ["pool", "doing", "done", "abandoned"];
        let before: unknown, after: unknown;
        try { before = JSON.parse(event.old_json); after = JSON.parse(event.new_json); } catch { continue; }
        if (!states.includes(before as string) || !states.includes(after as string) || before === after) continue;
      }
      const card = db.get<any>(`SELECT network_id, project_id, tags_json, external_ref, archived, owner_json,
        participants_json, created_by, created_by_json, agent_owner_json, parent_id
        FROM requirements WHERE requirement_id = ?1 AND network_id = ?2`, event.requirement_id, network);
      if (!card || card.archived || card.external_ref?.startsWith("iteration:")) continue;
      if (policy.project_id && card.project_id !== policy.project_id) continue;
      if (policy.tag) { let tags: unknown; try { tags = JSON.parse(card.tags_json); } catch { continue; }
        if (!Array.isArray(tags) || !tags.includes(policy.tag)) continue; }
      if (!canSeeTask(a.creator!, card) || !canSeeTask(a.target!, card) || !canSeeTask(configurator!, card)) continue;
      matching = Number(event.id);
    }
    const cursor = Number(events.at(-1)!.id);
    const due = parseHubTimestamp(row.next_run_at);
    if (matching && row.next_run_at && due === null) throw new Error("requirement_wake_invalid_due_time");
    const next = matching && row.next_run_at
      ? new Date(Math.min(due!, now.getTime() + spec.every_seconds * 1000)).toISOString() : row.next_run_at;
    const result = db.run(`UPDATE scheduled_tasks SET requirement_wake_cursor = ?1,
      requirement_wake_last_event_id = CASE WHEN ?2 IS NOT NULL THEN ?2 ELSE requirement_wake_last_event_id END,
      backoff_streak = CASE WHEN ?2 IS NOT NULL THEN 0 ELSE backoff_streak END,
      backoff_effective_seconds = CASE WHEN ?2 IS NOT NULL THEN NULL ELSE backoff_effective_seconds END,
      backoff_last_run_id = CASE WHEN ?2 IS NOT NULL THEN NULL ELSE backoff_last_run_id END,
      revision = revision + CASE WHEN ?2 IS NOT NULL THEN 1 ELSE 0 END, next_run_at = ?3,
      updated_at = CASE WHEN ?2 IS NOT NULL THEN datetime('now') ELSE updated_at END
      WHERE schedule_id = ?4 AND network_id = ?5 AND revision = ?6 AND requirement_wake_cursor = ?7
      AND status = 'active' AND no_change_backoff = 1`, [cursor, matching, next, id, network, row.revision, row.requirement_wake_cursor]);
    if (result.changes !== 1) throw new Error("requirement_wake_atomic_write_failed");
    return matching !== null;
  });
}
/** Existing scheduler tick also scans opt-in plans whose next due is delayed. */
export function pollRequirementWakes(now = new Date()): void {
  if (db.transactionalFeaturesRefusal !== null) return;
  const rows = db.all<any>(`SELECT schedule_id, network_id FROM scheduled_tasks
    WHERE status = 'active' AND no_change_backoff = 1 AND requirement_wake_json IS NOT NULL`);
  for (const row of rows) consumeRequirementWake(row.schedule_id, row.network_id, now);
}
setRequirementWakeHook(consumeRequirementWake);
