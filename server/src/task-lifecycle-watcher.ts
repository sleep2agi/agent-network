import { db } from "./db.js";

export const DELIVERED_STALE_THRESHOLDS = [30, 60] as const;

export type DeliveredStalePatrolResult = {
  inserted: number;
  by_threshold_seconds: Record<(typeof DELIVERED_STALE_THRESHOLDS)[number], number>;
};

function sqliteUtcTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Persist Hub-authoritative warnings for tasks which are still delivered.
 *
 * The task row, not an agent-local timer, is the source of truth. event_key is
 * equal to the stable event name and protected by a unique index, so every
 * threshold is write-once across restarts, patrols, and multiple Hub workers.
 */
export function recordDeliveredStaleEvents(now = new Date()): DeliveredStalePatrolResult {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid lifecycle patrol time");

  const byThreshold = { 30: 0, 60: 0 };
  let inserted = 0;

  for (const thresholdSeconds of DELIVERED_STALE_THRESHOLDS) {
    const eventType = `task.warning.delivered_stale_${thresholdSeconds}s`;
    const cutoff = sqliteUtcTimestamp(new Date(now.getTime() - thresholdSeconds * 1000));
    const detail = thresholdSeconds === 30
      ? "still delivered after 30s; target has not started"
      : "still delivered after 60s; target may be offline or not consuming";
    const result = db.run(
      `INSERT INTO task_events
         (task_id, from_status, to_status, event_type, event_key, actor, detail, network_id)
       SELECT task_id, 'delivered', 'delivered', ?1, ?1, 'patrol', ?2, network_id
       FROM tasks
       WHERE status = 'delivered'
         AND delivered_at IS NOT NULL
         AND delivered_at <= ?3
       ON CONFLICT(task_id, event_key) DO NOTHING`,
      [eventType, detail, cutoff],
    );
    byThreshold[thresholdSeconds] = result.changes;
    inserted += result.changes;
  }

  return { inserted, by_threshold_seconds: byThreshold };
}
