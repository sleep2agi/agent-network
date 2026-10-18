import type { DbAdapter } from "./db-adapter";

const EVENT_TYPE = "task.delivery.channel_notification_injected";
const eventKey = (inboxId: string) => `channel_notification_injected:${inboxId}`;

export function channelDeliverySupported(database: DbAdapter): boolean {
  return database.atomicTransactions === true && database.transactionalFeaturesRefusal === null;
}

/** Only call inside the recipient-checked ACK transaction; ids come from its
 * owned inbox row, never an additional caller-supplied task id. No body/detail. */
export function recordChannelDelivery(database: DbAdapter, taskId: string, inboxId: string, actor: string): void {
  database.run(
    `INSERT INTO task_events (task_id,from_status,to_status,event_type,event_key,actor,detail,network_id)
     SELECT task_id,NULL,status,?2,?3,?4,NULL,network_id FROM tasks WHERE task_id=?1
     ON CONFLICT(task_id,event_key) DO NOTHING`,
    [taskId, EVENT_TYPE, eventKey(inboxId), actor],
  );
  if (!database.get("SELECT 1 AS seen FROM task_events WHERE task_id=?1 AND event_type=?2 AND event_key=?3", taskId, EVENT_TYPE, eventKey(inboxId))) {
    throw new Error("channel_delivery_task_missing");
  }
}

/** A retry/reassignment creates a new inbox row. Do not project an older
 * injection as evidence for that new delivery, even within the same second. */
export function channelDeliveryAt(database: DbAdapter, taskId: string, networkId: string | null): string | null {
  // A retry creates a new unacked transport row. Until that row is ACKed,
  // an event from the previous delivery is not evidence for the new one.
  // Do not order inbox rows by their opaque text id: SQLite rowid has no
  // PostgreSQL equivalent, and same-second retries need a stable chronology.
  const pendingParams: unknown[] = [taskId];
  const pendingScope = networkId === null ? "network_id IS NULL" : "network_id=?2";
  if (networkId !== null) pendingParams.push(networkId);
  if (database.get(
    `SELECT 1 AS pending FROM inbox
      WHERE type='task' AND COALESCE(task_id,id)=?1 AND acked=0 AND ${pendingScope} LIMIT 1`,
    ...pendingParams,
  )) return null;
  const params: unknown[] = [taskId, EVENT_TYPE];
  const inboxScope = networkId === null ? "network_id IS NULL" : "network_id=?3";
  const eventScope = networkId === null ? "e.network_id IS NULL" : "e.network_id=?3";
  if (networkId !== null) params.push(networkId);
  const row = database.get<{ created_at: string }>(
    `SELECT e.created_at FROM task_events e
      WHERE e.task_id=?1 AND e.event_type=?2 AND ${eventScope}
        AND EXISTS (SELECT 1 FROM inbox i
          WHERE i.type='task' AND COALESCE(i.task_id,i.id)=e.task_id
            AND e.event_key='channel_notification_injected:' || i.id
            AND ${inboxScope})
        AND NOT EXISTS (SELECT 1 FROM task_events d
          WHERE d.task_id=e.task_id AND d.event_type='task.send.delivered' AND d.id>e.id)
      ORDER BY e.id DESC LIMIT 1`,
    ...params,
  );
  return row?.created_at ?? null;
}

type Stage = { state: "observed" | "unknown"; at: string | null };
const observed = (at: unknown): Stage => typeof at === "string" && at.length > 0
  ? { state: "observed", at } : { state: "unknown", at: null };

/** Five independent observations, not five timestamps inferred from ACK.
 * There is deliberately no CLI-admission writer until a real receipt exists. */
export function channelDeliveryStages(task: {
  status?: string; delivered_at?: unknown; consumed_at?: unknown; completed_at?: unknown;
}, injectedAt: string) {
  return {
    delivered: observed(task.delivered_at),
    channel_notification_injected: observed(injectedAt),
    cli_admitted: { state: "unknown" as const, at: null },
    turn_started: observed(task.consumed_at),
    replied: task.status === "replied"
      ? { state: "observed" as const, at: typeof task.completed_at === "string" ? task.completed_at : null }
      : { state: "unknown" as const, at: null },
  };
}
