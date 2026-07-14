import { afterEach, describe, expect, test } from "bun:test";
import { createQueueTestHarness, tableSnapshot } from "./hub-440-queue-test-support.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const CONTROL_TABLES = [
  "tasks", "inbox", "task_events", "h1_queue_deliveries", "h1_task_assignments",
  "h1_queue_idempotency", "h1_queue_idempotency_refs", "h1_queue_security_audit", "h1_queue_doorbell_outbox",
] as const;

describe("#440 H1 producer resource matrix", () => {
  test("broadcast creates one exact-node no-response resource per recipient and no shared task", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const rows = h.service.enqueueBroadcast(h.principalA, {
      operationId: "broadcast", targetNodeIds: ["node-c", "node-b", "node-b"], content: "notice",
    });
    expect(rows).toHaveLength(2);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(0);
    const durable = h.raw.query("SELECT resource_kind, task_id, requires_response, consumer_node_id FROM h1_queue_deliveries ORDER BY consumer_node_id").all() as any[];
    expect(durable).toEqual([
      { resource_kind: "broadcast", task_id: null, requires_response: 0, consumer_node_id: "node-b" },
      { resource_kind: "broadcast", task_id: null, requires_response: 0, consumer_node_id: "node-c" },
    ]);
    for (const [principal, node] of [[h.principalB, "node-b"], [h.principalC, "node-c"]] as const) {
      const lease = h.service.claim(principal, { limit: 1 })[0]!;
      expect(lease.resourceKind).toBe("broadcast");
      expect(h.service.acknowledge(principal, { ...lease, operationId: `consume-${node}` }).state).toBe("consumed");
    }
    expect((h.raw.query("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(0);
  });

  test("operation id replay is exact and changed input is rejected without writes", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const first = h.service.enqueueMessage(h.principalA, { operationId: "same", targetNodeId: "node-b", content: "one" });
    const stable = tableSnapshot(h.raw, ["inbox", "h1_queue_deliveries", "h1_queue_idempotency", "h1_queue_security_audit", "h1_queue_doorbell_outbox"]);
    expect(h.service.enqueueMessage(h.principalA, { operationId: "same", targetNodeId: "node-b", content: "one" })).toEqual(first);
    expect(() => h.service.enqueueMessage(h.principalA, { operationId: "same", targetNodeId: "node-b", content: "changed" })).toThrow("operation_conflict");
    expect(tableSnapshot(h.raw, ["inbox", "h1_queue_deliveries", "h1_queue_idempotency", "h1_queue_security_audit", "h1_queue_doorbell_outbox"])).toBe(stable);
  });
});

describe("#440 H1 control mutations", () => {
  test("dead-letter accepts only a bounded stable reason code", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueTask(h.principalA, { operationId: "dead-task", targetNodeId: "node-b", content: "work" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    const before = tableSnapshot(h.raw, CONTROL_TABLES);
    expect(() => h.service.deadLetter(h.principalB, {
      ...lease,
      operationId: "invalid-dead-letter",
      reasonCode: "free-form secret /tmp/private",
    })).toThrow("invalid_queue_request");
    expect(tableSnapshot(h.raw, CONTROL_TABLES)).toBe(before);
  });

  test("only immutable producer or QueueControlPrincipal can cancel", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const task = h.service.enqueueTask(h.principalA, { operationId: "task", targetNodeId: "node-b", content: "work" });
    const before = tableSnapshot(h.raw, ["tasks", "inbox", "h1_queue_deliveries", "task_events", "h1_queue_security_audit"]);
    expect(() => h.service.cancel(h.principalC, { taskId: task.taskId!, operationId: "foreign-cancel" })).toThrow("queue_transition_conflict");
    expect(tableSnapshot(h.raw, ["tasks", "inbox", "h1_queue_deliveries", "task_events", "h1_queue_security_audit"])).toBe(before);
    h.db.run("UPDATE tasks SET from_node_id='node-c', from_name='alias-c' WHERE task_id=?1", [task.taskId]);
    const afterProjectionTamper = tableSnapshot(h.raw, CONTROL_TABLES);
    expect(() => h.service.cancel(h.principalC, { taskId: task.taskId!, operationId: "projection-forged-cancel" }))
      .toThrow("queue_transition_conflict");
    expect(tableSnapshot(h.raw, CONTROL_TABLES)).toBe(afterProjectionTamper);
    expect(h.service.cancel(h.principalA, { taskId: task.taskId!, operationId: "producer-cancel" }).state).toBe("cancelled");
  });

  test("reassign invalidates old lease and increments >MAX_SAFE assignment generation only in SQL", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const task = h.service.enqueueTask(h.principalA, { operationId: "task", targetNodeId: "node-b", content: "work" });
    const oldLease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...oldLease, operationId: "ack" });
    h.db.run("UPDATE tasks SET from_node_id='node-c', from_name='alias-c' WHERE task_id=?1", [task.taskId]);
    h.raw.exec(`UPDATE h1_task_assignments SET assignment_epoch=9007199254740993 WHERE task_id='${task.taskId}'`);
    h.raw.exec(`UPDATE h1_queue_deliveries SET assignment_generation=9007199254740993 WHERE delivery_id='${oldLease.deliveryId}'`);
    const reassigned = h.service.reassign(h.control, { taskId: task.taskId!, targetNodeId: "node-c", operationId: "reassign" });
    expect(() => h.service.reply(h.principalB, { ...oldLease, operationId: "stale", result: "bad" })).toThrow("lease_invalid_or_not_owned");
    const assignment = h.raw.query(`SELECT CAST(a.assignment_epoch AS TEXT) AS assignment_epoch,
      CAST(d.assignment_generation AS TEXT) AS delivery_generation, a.consumer_node_id
      FROM h1_task_assignments a JOIN h1_queue_deliveries d ON d.delivery_id=a.delivery_id
      WHERE a.task_id=?1`).get(task.taskId) as any;
    expect(assignment).toEqual({
      assignment_epoch: "9007199254740994",
      delivery_generation: "9007199254740994",
      consumer_node_id: "node-c",
    });
    expect(h.service.claim(h.principalC, { limit: 1 })[0]?.deliveryId).toBe(reassigned.deliveryId);
    const afterClaim = h.raw.query(`SELECT CAST(a.assignment_epoch AS TEXT) AS assignment_epoch,
      CAST(d.assignment_generation AS TEXT) AS delivery_generation
      FROM h1_task_assignments a JOIN h1_queue_deliveries d ON d.delivery_id=a.delivery_id
      WHERE a.task_id=?1`).get(task.taskId) as any;
    expect(afterClaim).toEqual({
      assignment_epoch: "9007199254740994",
      delivery_generation: "9007199254740994",
    });
    expect((h.raw.query("SELECT producer_node_id FROM h1_queue_deliveries WHERE delivery_id=?1").get(reassigned.deliveryId) as any).producer_node_id)
      .toBe("node-a");
  });

  test("retry refuses a legacy terminal projection while the H1 attempt is still live", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const task = h.service.enqueueTask(h.principalA, { operationId: "live-task", targetNodeId: "node-b", content: "work" });
    h.db.run("UPDATE tasks SET status='failed', result='legacy-only failure', completed_at=?1 WHERE task_id=?2", [
      new Date(h.nowMs()).toISOString(), task.taskId,
    ]);
    const before = tableSnapshot(h.raw, CONTROL_TABLES);
    expect(() => h.service.retry(h.control, { taskId: task.taskId!, operationId: "must-not-retry" }))
      .toThrow("queue_transition_conflict");
    expect(tableSnapshot(h.raw, CONTROL_TABLES)).toBe(before);
  });

  test("retry default target comes from immutable H1 assignment, not mutable task projection", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const task = h.service.enqueueTask(h.principalA, {
      operationId: "immutable-retry-target", targetNodeId: "node-b", content: "work",
    });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.deadLetter(h.principalB, { ...lease, operationId: "terminal", reasonCode: "bounded_failure" });
    h.db.run("UPDATE tasks SET to_node_id='node-c', to_name='alias-c' WHERE task_id=?1", [task.taskId]);

    const retried = h.service.retry(h.control, { taskId: task.taskId!, operationId: "retry-default" });
    expect(h.raw.query(
      `SELECT d.consumer_node_id, t.to_node_id, t.from_node_id, t.from_name
         FROM h1_queue_deliveries d JOIN tasks t ON t.task_id=d.task_id
        WHERE d.delivery_id=?1`,
    ).get(retried.deliveryId)).toEqual({
      consumer_node_id: "node-b", to_node_id: "node-b",
      from_node_id: "node-a", from_name: "alias-a",
    });

    const explicitlyRetried = h.service.retry(h.control, {
      taskId: task.taskId!, operationId: "retry-explicit", targetNodeId: "node-c",
    });
    expect(h.raw.query(
      "SELECT consumer_node_id FROM h1_queue_deliveries WHERE delivery_id=?1",
    ).get(explicitlyRetried.deliveryId)).toEqual({ consumer_node_id: "node-c" });
  });

  test("retry creates a new task and preserves original terminal producer/result bytes", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const task = h.service.enqueueTask(h.principalA, { operationId: "task", targetNodeId: "node-b", content: "work" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...lease, operationId: "ack" });
    h.db.run("UPDATE tasks SET from_node_id='node-c', from_name='alias-c' WHERE task_id=?1", [task.taskId]);
    h.service.deadLetter(h.principalB, { ...lease, operationId: "dead", reasonCode: "bounded_failure" });
    const original = JSON.stringify(h.raw.query("SELECT * FROM tasks WHERE task_id=?1").get(task.taskId));
    const retried = h.service.retry(h.control, { taskId: task.taskId!, operationId: "retry" });
    expect(retried.taskId).not.toBe(task.taskId);
    expect(JSON.stringify(h.raw.query("SELECT * FROM tasks WHERE task_id=?1").get(task.taskId))).toBe(original);
    const retryRow = h.raw.query("SELECT from_node_id, to_node_id, status, result FROM tasks WHERE task_id=?1").get(retried.taskId) as any;
    expect(retryRow).toEqual({ from_node_id: "node-a", to_node_id: "node-b", status: "delivered", result: null });
  });
});
