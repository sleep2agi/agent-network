import { afterEach, describe, expect, test } from "bun:test";
import { sweepH1QueueRetention } from "./hub-440-queue-retention.js";
import { createQueueTestHarness, tableSnapshot } from "./hub-440-queue-test-support.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const RETENTION_TABLES = [
  "tasks", "inbox", "task_events", "h1_queue_deliveries", "h1_task_assignments",
  "h1_queue_idempotency", "h1_queue_idempotency_refs", "h1_queue_security_audit", "h1_queue_doorbell_outbox",
  "h1_delegation_edges", "h1_reply_attachments",
] as const;

describe("#440 H1 queue-aware retention", () => {
  test("superseded attempt cannot delete events or idempotency while the task has a live delivery", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const first = h.service.enqueueTask(h.principalA, {
      operationId: "same-op",
      targetNodeId: "node-b",
      content: "work",
    });
    h.service.reassign(h.control, { taskId: first.taskId!, targetNodeId: "node-c", operationId: "reassign" });
    h.service.listReadyDoorbells();
    const before = tableSnapshot(h.raw, RETENTION_TABLES);
    expect(sweepH1QueueRetention(h.db, { terminalBeforeMs: h.nowMs() }).deliveries).toBe(0);
    expect(tableSnapshot(h.raw, RETENTION_TABLES)).toBe(before);
    expect(h.service.enqueueTask(h.principalA, {
      operationId: "same-op",
      targetNodeId: "node-b",
      content: "work",
    })).toEqual(first);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(1);
  });

  test("one ineligible sibling outbox keeps the entire terminal task attempt set byte-stable", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const first = h.service.enqueueTask(h.principalA, {
      operationId: "task-set", targetNodeId: "node-b", content: "work",
    });
    const second = h.service.reassign(h.control, {
      taskId: first.taskId!, targetNodeId: "node-c", operationId: "reassign-set",
    });
    // Suppress only the superseded attempt's wakeup. The current attempt's
    // wakeup remains pending, then becomes a terminal-but-unswept sibling.
    expect(h.service.listReadyDoorbells().map((row) => row.outboxId)).toHaveLength(1);
    h.service.cancel(h.principalA, { taskId: first.taskId!, operationId: "cancel-set" });
    expect(h.raw.query(
      "SELECT status FROM h1_queue_doorbell_outbox WHERE expected_delivery_id=?1",
    ).get(second.deliveryId)).toEqual({ status: "pending" });
    const before = tableSnapshot(h.raw, RETENTION_TABLES);

    expect(sweepH1QueueRetention(h.db, { terminalBeforeMs: h.nowMs() + 1 })).toEqual({
      deliveries: 0, resources: 0, tasks: 0, events: 0,
      audits: 0, idempotency: 0, doorbells: 0,
    });
    expect(tableSnapshot(h.raw, RETENTION_TABLES)).toBe(before);

    h.service.listReadyDoorbells();
    const swept = sweepH1QueueRetention(h.db, { terminalBeforeMs: h.nowMs() + 1 });
    expect(swept.deliveries).toBe(2);
    expect(swept.resources).toBe(2);
    expect(swept.tasks).toBe(1);
  });

  test("multi-recipient broadcast keeps explicit idempotency refs until the last resource is swept", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const rows = h.service.enqueueBroadcast(h.principalA, {
      operationId: "broadcast-op", targetNodeIds: ["node-b", "node-c"], content: "notice",
    });
    const bLease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...bLease, operationId: "consume-b" });
    const firstTerminalAt = h.nowMs();
    h.advance(100);
    const cLease = h.service.claim(h.principalC, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalC, { ...cLease, operationId: "consume-c" });
    h.service.listReadyDoorbells();

    expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_queue_idempotency_refs WHERE operation_id='broadcast-op'").get() as any).n).toBe(2);
    sweepH1QueueRetention(h.db, { terminalBeforeMs: firstTerminalAt });
    expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_queue_idempotency WHERE operation_id='broadcast-op'").get() as any).n).toBe(1);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_queue_idempotency_refs WHERE operation_id='broadcast-op'").get() as any).n).toBe(1);
    expect(h.raw.query("SELECT 1 FROM h1_queue_deliveries WHERE delivery_id=?1").get(rows[1]!.deliveryId)).not.toBeNull();

    sweepH1QueueRetention(h.db, { terminalBeforeMs: h.nowMs() });
    expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_queue_idempotency WHERE operation_id='broadcast-op'").get() as any).n).toBe(0);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_queue_idempotency_refs WHERE operation_id='broadcast-op'").get() as any).n).toBe(0);
  });

  test("deletes one terminal unreferenced set only after its longest horizon", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const message = h.service.enqueueMessage(h.principalA, { operationId: "m", targetNodeId: "node-b", content: "m" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...lease, operationId: "consume" });
    h.service.listReadyDoorbells();
    const tooEarly = sweepH1QueueRetention(h.db, { terminalBeforeMs: h.nowMs() - 1 });
    expect(tooEarly.deliveries).toBe(0);
    const result = sweepH1QueueRetention(h.db, { terminalBeforeMs: h.nowMs() });
    expect(result.deliveries).toBe(1);
    expect(h.raw.query("SELECT 1 FROM h1_queue_deliveries WHERE delivery_id=?1").get(message.deliveryId)).toBeNull();
    expect(h.raw.query("SELECT 1 FROM inbox WHERE id=?1").get(message.resourceId)).toBeNull();
    expect(h.raw.query("SELECT 1 FROM h1_queue_idempotency WHERE delivery_id=?1").get(message.deliveryId)).toBeNull();
  });

  test("active leases and lineage-referenced parent/child sets are retained", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueMessage(h.principalA, { operationId: "active", targetNodeId: "node-b", content: "active" });
    h.service.claim(h.principalB, { limit: 1 });
    h.service.enqueueTask(h.principalA, { operationId: "parent", targetNodeId: "node-b", content: "parent" });
    const parentLease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...parentLease, operationId: "pa" });
    h.service.delegateTask(h.principalB, {
      parentDeliveryId: parentLease.deliveryId, parentLeaseId: parentLease.leaseId,
      parentEpoch: parentLease.epoch, operationId: "delegate", targetNodeId: "node-c", content: "child",
    });
    h.service.cancel(h.principalA, { taskId: parentLease.taskId!, operationId: "cancel-parent" });
    const before = tableSnapshot(h.raw, RETENTION_TABLES);
    const result = sweepH1QueueRetention(h.db, { terminalBeforeMs: h.nowMs() + 1 });
    expect(result.deliveries).toBe(0);
    expect(tableSnapshot(h.raw, RETENTION_TABLES)).toBe(before);
  });

  test("fully terminal lineage component is deleted as one atomic retention set", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const parent = h.service.enqueueTask(h.principalA, { operationId: "parent", targetNodeId: "node-b", content: "parent" });
    const parentLease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...parentLease, operationId: "parent-ack" });
    h.service.delegateTask(h.principalB, {
      parentDeliveryId: parentLease.deliveryId,
      parentLeaseId: parentLease.leaseId,
      parentEpoch: parentLease.epoch,
      operationId: "delegate",
      targetNodeId: "node-c",
      content: "child",
    });
    const childLease = h.service.claim(h.principalC, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalC, { ...childLease, operationId: "child-ack" });
    h.service.reply(h.principalC, { ...childLease, operationId: "child-reply", result: "child result" });
    const attachmentLease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...attachmentLease, operationId: "attachment-consume" });
    h.service.cancel(h.principalA, { taskId: parent.taskId!, operationId: "parent-cancel" });
    h.service.listReadyDoorbells();
    const result = sweepH1QueueRetention(h.db, { terminalBeforeMs: h.nowMs() });
    expect(result.deliveries).toBe(3);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_delegation_edges").get() as any).n).toBe(0);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_reply_attachments").get() as any).n).toBe(0);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(0);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_queue_deliveries").get() as any).n).toBe(0);
  });

  test("partial cleanup fault rolls the entire retention set back", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueMessage(h.principalA, { operationId: "m", targetNodeId: "node-b", content: "m" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...lease, operationId: "consume" });
    h.service.listReadyDoorbells();
    const before = tableSnapshot(h.raw, RETENTION_TABLES);
    expect(() => sweepH1QueueRetention(h.db, {
      terminalBeforeMs: h.nowMs(),
      faultAt(stage) { if (stage === "retention_after_first_delete") throw new Error("retention fault"); },
    })).toThrow("retention fault");
    expect(tableSnapshot(h.raw, RETENTION_TABLES)).toBe(before);
  });
});
