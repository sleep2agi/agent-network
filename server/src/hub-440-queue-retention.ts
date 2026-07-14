import {
  AtomicQueueTransactionsUnavailableError,
  type DbAdapter,
} from "./db-adapter.js";
import type { DeliveryState, QueueFaultStage } from "./hub-440-queue-types.js";

export type H1RetentionResult = Readonly<{
  deliveries: number;
  resources: number;
  tasks: number;
  events: number;
  audits: number;
  idempotency: number;
  doorbells: number;
}>;

type MutableRetentionResult = {
  -readonly [K in keyof H1RetentionResult]: H1RetentionResult[K];
};

type RetentionDelivery = {
  delivery_id: string;
  resource_kind: string;
  resource_id: string;
  task_id: string | null;
  state: DeliveryState;
  terminal_at_ms: number | null;
};

type LineageEdge = {
  edge_id: string;
  parent_task_id: string;
  child_task_id: string;
};

type IdempotencyKey = {
  network_id: string;
  principal_kind: string;
  principal_id: string;
  token_id: string;
  operation_id: string;
};

const TERMINAL_DELIVERY_STATES = new Set<DeliveryState>([
  "consumed", "replied", "dead_lettered", "cancelled", "superseded",
]);
const TERMINAL_TASK_STATES = new Set(["replied", "failed", "cancelled", "expired"]);

function placeholders(count: number, start = 1): string {
  return Array.from({ length: count }, (_, index) => `?${start + index}`).join(",");
}

function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function deleteIdempotencyForDeliveries(db: DbAdapter, deliveryIds: readonly string[]): number {
  if (deliveryIds.length === 0) return 0;
  const inList = placeholders(deliveryIds.length);
  const keys = db.all<IdempotencyKey>(
    `SELECT DISTINCT i.network_id, i.principal_kind, i.principal_id, i.token_id, i.operation_id
       FROM h1_queue_idempotency i
      WHERE i.delivery_id IN (${inList})
         OR EXISTS (
           SELECT 1 FROM h1_queue_idempotency_refs r
            WHERE r.network_id=i.network_id AND r.principal_kind=i.principal_kind
              AND r.principal_id=i.principal_id AND r.token_id=i.token_id
              AND r.operation_id=i.operation_id AND r.delivery_id IN (${inList})
         )`,
    ...deliveryIds,
  );
  let deleted = db.run(
    `DELETE FROM h1_queue_idempotency_refs WHERE delivery_id IN (${inList})`,
    [...deliveryIds],
  ).changes;
  for (const key of keys) {
    deleted += db.run(
      `DELETE FROM h1_queue_idempotency
        WHERE network_id=?1 AND principal_kind=?2 AND principal_id=?3
          AND token_id=?4 AND operation_id=?5
          AND NOT EXISTS (
            SELECT 1 FROM h1_queue_idempotency_refs r
             WHERE r.network_id=h1_queue_idempotency.network_id
               AND r.principal_kind=h1_queue_idempotency.principal_kind
               AND r.principal_id=h1_queue_idempotency.principal_id
               AND r.token_id=h1_queue_idempotency.token_id
               AND r.operation_id=h1_queue_idempotency.operation_id
          )`,
      [key.network_id, key.principal_kind, key.principal_id, key.token_id, key.operation_id],
    ).changes;
  }
  return deleted;
}

function connectedLineageComponents(edges: readonly LineageEdge[]): Array<{ taskIds: string[]; edgeIds: string[] }> {
  const adjacent = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!adjacent.has(edge.parent_task_id)) adjacent.set(edge.parent_task_id, new Set());
    if (!adjacent.has(edge.child_task_id)) adjacent.set(edge.child_task_id, new Set());
    adjacent.get(edge.parent_task_id)!.add(edge.child_task_id);
    adjacent.get(edge.child_task_id)!.add(edge.parent_task_id);
  }
  const visited = new Set<string>();
  const components: Array<{ taskIds: string[]; edgeIds: string[] }> = [];
  for (const start of [...adjacent.keys()].sort()) {
    if (visited.has(start)) continue;
    const queue = [start];
    const taskIds: string[] = [];
    visited.add(start);
    while (queue.length > 0) {
      const taskId = queue.shift()!;
      taskIds.push(taskId);
      for (const next of adjacent.get(taskId) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    const taskSet = new Set(taskIds);
    components.push({
      taskIds: taskIds.sort(),
      edgeIds: edges
        .filter((edge) => taskSet.has(edge.parent_task_id) || taskSet.has(edge.child_task_id))
        .map((edge) => edge.edge_id)
        .sort(),
    });
  }
  return components;
}

function sweepLineageComponent(
  db: DbAdapter,
  component: { taskIds: string[]; edgeIds: string[] },
  terminalBeforeMs: number,
  counts: MutableRetentionResult,
  faultAt?: (stage: QueueFaultStage) => void,
): boolean {
  const taskIn = placeholders(component.taskIds.length);
  const edgeIn = placeholders(component.edgeIds.length);
  const attachmentDeliveries = db.all<{ attachment_delivery_id: string }>(
    `SELECT attachment_delivery_id FROM h1_reply_attachments WHERE edge_id IN (${edgeIn})`,
    ...component.edgeIds,
  ).map((row) => row.attachment_delivery_id);
  const deliveryParams = [...component.taskIds, ...attachmentDeliveries];
  const deliveryWhere = attachmentDeliveries.length === 0
    ? `d.task_id IN (${taskIn})`
    : `d.task_id IN (${taskIn}) OR d.delivery_id IN (${placeholders(attachmentDeliveries.length, component.taskIds.length + 1)})`;
  const deliveries = db.all<RetentionDelivery>(
    `SELECT d.delivery_id, d.resource_kind, d.resource_id, d.task_id, d.state, d.terminal_at_ms
       FROM h1_queue_deliveries d WHERE ${deliveryWhere}`,
    ...deliveryParams,
  );
  const representedTasks = new Set(deliveries.flatMap((row) => row.task_id ? [row.task_id] : []));
  if (component.taskIds.some((taskId) => !representedTasks.has(taskId))) return false;
  if (deliveries.some((row) => !TERMINAL_DELIVERY_STATES.has(row.state)
      || row.terminal_at_ms === null || row.terminal_at_ms > terminalBeforeMs)) return false;

  const tasks = db.all<{ task_id: string; status: string }>(
    `SELECT task_id, status FROM tasks WHERE task_id IN (${taskIn})`,
    ...component.taskIds,
  );
  if (tasks.length !== component.taskIds.length || tasks.some((row) => !TERMINAL_TASK_STATES.has(row.status))) {
    return false;
  }

  const deliveryIds = distinct(deliveries.map((row) => row.delivery_id));
  const resourceIds = distinct(deliveries.map((row) => row.resource_id));
  const deliveryIn = placeholders(deliveryIds.length);
  const pendingDoorbell = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM h1_queue_doorbell_outbox
      WHERE expected_delivery_id IN (${deliveryIn}) AND status='pending'`,
    ...deliveryIds,
  )?.n ?? 0;
  if (pendingDoorbell !== 0) return false;

  counts.doorbells += db.run(
    `DELETE FROM h1_queue_doorbell_outbox WHERE expected_delivery_id IN (${deliveryIn})`,
    [...deliveryIds],
  ).changes;
  faultAt?.("retention_after_first_delete");
  counts.idempotency += deleteIdempotencyForDeliveries(db, deliveryIds);
  counts.audits += db.run(
    `DELETE FROM h1_queue_security_audit
      WHERE delivery_id IN (${deliveryIn}) OR task_id IN (${placeholders(component.taskIds.length, deliveryIds.length + 1)})`,
    [...deliveryIds, ...component.taskIds],
  ).changes;
  counts.events += db.run(
    `DELETE FROM task_events WHERE task_id IN (${taskIn})`,
    [...component.taskIds],
  ).changes;
  db.run(`DELETE FROM h1_reply_attachments WHERE edge_id IN (${edgeIn})`, [...component.edgeIds]);
  db.run(`DELETE FROM h1_delegation_edges WHERE edge_id IN (${edgeIn})`, [...component.edgeIds]);
  db.run(`DELETE FROM h1_task_assignments WHERE task_id IN (${taskIn})`, [...component.taskIds]);
  counts.deliveries += db.run(
    `DELETE FROM h1_queue_deliveries WHERE delivery_id IN (${deliveryIn})`,
    [...deliveryIds],
  ).changes;
  counts.resources += db.run(
    `DELETE FROM inbox WHERE id IN (${placeholders(resourceIds.length)})`,
    [...resourceIds],
  ).changes;
  counts.tasks += db.run(
    `DELETE FROM tasks WHERE task_id IN (${taskIn}) AND status IN ('replied','failed','cancelled','expired')`,
    [...component.taskIds],
  ).changes;
  return true;
}

function sweepStandaloneTaskSet(
  db: DbAdapter,
  taskId: string,
  terminalBeforeMs: number,
  counts: MutableRetentionResult,
  faultAt?: (stage: QueueFaultStage) => void,
): boolean {
  const deliveries = db.all<RetentionDelivery>(
    `SELECT delivery_id, resource_kind, resource_id, task_id, state, terminal_at_ms
       FROM h1_queue_deliveries WHERE task_id=?1 ORDER BY delivery_id`,
    taskId,
  );
  if (deliveries.length === 0) return false;
  if (deliveries.some((row) => row.resource_kind !== "task" || row.task_id !== taskId
      || !TERMINAL_DELIVERY_STATES.has(row.state)
      || row.terminal_at_ms === null || row.terminal_at_ms > terminalBeforeMs)) return false;

  const task = db.get<{ status: string }>(
    "SELECT status FROM tasks WHERE task_id=?1",
    taskId,
  );
  if (!task || !TERMINAL_TASK_STATES.has(task.status)) return false;

  const deliveryIds = distinct(deliveries.map((row) => row.delivery_id));
  const resourceIds = distinct(deliveries.map((row) => row.resource_id));
  const deliveryIn = placeholders(deliveryIds.length, 2);
  const assignment = db.get<{ delivery_id: string }>(
    "SELECT delivery_id FROM h1_task_assignments WHERE task_id=?1",
    taskId,
  );
  if (!assignment || !deliveryIds.includes(assignment.delivery_id)) return false;

  const lineageReference = db.get<{ one: number }>(
    `SELECT 1 AS one FROM h1_delegation_edges
      WHERE parent_task_id=?1 OR child_task_id=?1
     UNION ALL
     SELECT 1 AS one FROM h1_reply_attachments
      WHERE child_task_id=?1
         OR parent_delivery_id IN (${deliveryIn})
         OR child_terminal_delivery_id IN (${deliveryIn})
         OR attachment_delivery_id IN (${deliveryIn})
     LIMIT 1`,
    taskId,
    ...deliveryIds,
  );
  if (lineageReference) return false;

  const pendingDoorbell = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM h1_queue_doorbell_outbox
      WHERE expected_delivery_id IN (${placeholders(deliveryIds.length)}) AND status='pending'`,
    ...deliveryIds,
  )?.n ?? 0;
  if (pendingDoorbell !== 0) return false;

  counts.doorbells += db.run(
    `DELETE FROM h1_queue_doorbell_outbox
      WHERE expected_delivery_id IN (${placeholders(deliveryIds.length)})`,
    [...deliveryIds],
  ).changes;
  faultAt?.("retention_after_first_delete");
  counts.idempotency += deleteIdempotencyForDeliveries(db, deliveryIds);
  counts.audits += db.run(
    `DELETE FROM h1_queue_security_audit
      WHERE task_id=?1 OR delivery_id IN (${deliveryIn})`,
    [taskId, ...deliveryIds],
  ).changes;
  counts.events += db.run("DELETE FROM task_events WHERE task_id=?1", [taskId]).changes;

  const assignmentsDeleted = db.run(
    "DELETE FROM h1_task_assignments WHERE task_id=?1 AND delivery_id IN (" + deliveryIn + ")",
    [taskId, ...deliveryIds],
  ).changes;
  if (assignmentsDeleted !== 1) throw new Error("retention_task_assignment_set_changed");
  const deliveriesDeleted = db.run(
    `DELETE FROM h1_queue_deliveries WHERE delivery_id IN (${placeholders(deliveryIds.length)})`,
    [...deliveryIds],
  ).changes;
  if (deliveriesDeleted !== deliveryIds.length) throw new Error("retention_task_delivery_set_changed");
  counts.deliveries += deliveriesDeleted;
  const resourcesDeleted = db.run(
    `DELETE FROM inbox WHERE id IN (${placeholders(resourceIds.length)})`,
    [...resourceIds],
  ).changes;
  if (resourcesDeleted !== resourceIds.length) throw new Error("retention_task_resource_set_changed");
  counts.resources += resourcesDeleted;
  const tasksDeleted = db.run(
    "DELETE FROM tasks WHERE task_id=?1 AND status IN ('replied','failed','cancelled','expired')",
    [taskId],
  ).changes;
  if (tasksDeleted !== 1) throw new Error("retention_task_projection_changed");
  counts.tasks += tasksDeleted;
  return true;
}

/**
 * Delete complete H1 retention sets or none. The caller supplies the
 * already-computed longest horizon. Active attempts and incomplete lineage
 * components block selection before the first delete.
 */
export function sweepH1QueueRetention(
  db: DbAdapter,
  input: { terminalBeforeMs: number; faultAt?: (stage: QueueFaultStage) => void },
): H1RetentionResult {
  if (db.atomicQueueTransactions !== "same_connection_immediate") {
    throw new AtomicQueueTransactionsUnavailableError();
  }
  return db.immediateTransaction(() => {
    const counts: MutableRetentionResult = {
      deliveries: 0, resources: 0, tasks: 0, events: 0,
      audits: 0, idempotency: 0, doorbells: 0,
    };

    const edges = db.all<LineageEdge>(
      "SELECT edge_id, parent_task_id, child_task_id FROM h1_delegation_edges ORDER BY edge_id",
    );
    for (const component of connectedLineageComponents(edges)) {
      sweepLineageComponent(db, component, input.terminalBeforeMs, counts, input.faultAt);
    }

    const taskIds = db.all<{ task_id: string }>(
      `SELECT DISTINCT task_id FROM h1_queue_deliveries
        WHERE task_id IS NOT NULL ORDER BY task_id`,
    );
    for (const row of taskIds) {
      sweepStandaloneTaskSet(db, row.task_id, input.terminalBeforeMs, counts, input.faultAt);
    }

    const eligible = db.all<RetentionDelivery>(
      `SELECT d.delivery_id, d.resource_kind, d.resource_id, d.task_id, d.state, d.terminal_at_ms
         FROM h1_queue_deliveries d
        WHERE d.task_id IS NULL
          AND d.state IN ('consumed','replied','dead_lettered','cancelled','superseded')
          AND d.terminal_at_ms IS NOT NULL AND d.terminal_at_ms <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM h1_queue_doorbell_outbox o
             WHERE o.expected_delivery_id=d.delivery_id AND o.status='pending'
          )
          AND NOT EXISTS (
            SELECT 1 FROM h1_delegation_edges e
             WHERE e.parent_delivery_id=d.delivery_id OR e.child_task_id=d.task_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM h1_reply_attachments a
             WHERE a.attachment_delivery_id=d.delivery_id
                OR a.child_terminal_delivery_id=d.delivery_id
                OR a.parent_delivery_id=d.delivery_id
          )
        ORDER BY d.terminal_at_ms, d.delivery_id`,
      input.terminalBeforeMs,
    );

    for (const row of eligible) {
      counts.doorbells += db.run(
        "DELETE FROM h1_queue_doorbell_outbox WHERE expected_delivery_id=?1 AND status IN ('dispatched','suppressed')",
        [row.delivery_id],
      ).changes;
      input.faultAt?.("retention_after_first_delete");
      counts.idempotency += deleteIdempotencyForDeliveries(db, [row.delivery_id]);
      counts.audits += db.run(
        "DELETE FROM h1_queue_security_audit WHERE delivery_id=?1 OR task_id=?2",
        [row.delivery_id, row.task_id],
      ).changes;
      counts.deliveries += db.run("DELETE FROM h1_queue_deliveries WHERE delivery_id=?1", [row.delivery_id]).changes;
      counts.resources += db.run("DELETE FROM inbox WHERE id=?1", [row.resource_id]).changes;
    }
    return counts;
  });
}
