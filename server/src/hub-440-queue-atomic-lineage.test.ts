import { afterEach, describe, expect, test } from "bun:test";
import type { DbAdapter, QueryResult } from "./db-adapter.js";
import { AtomicQueueTransactionsUnavailableError } from "./db-adapter.js";
import { H1QueueService } from "./hub-440-queue-service.js";
import { createQueueTestHarness, tableSnapshot } from "./hub-440-queue-test-support.js";
import { QueueServiceError, type NodeConsumerPrincipal, type QueueFaultStage } from "./hub-440-queue-types.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

const ATOMIC_TABLES = [
  "tasks", "inbox", "task_events", "h1_queue_deliveries", "h1_task_assignments",
  "h1_queue_idempotency", "h1_queue_idempotency_refs", "h1_queue_security_audit", "h1_queue_doorbell_outbox",
  "h1_delegation_edges", "h1_reply_attachments",
] as const;

describe("#440 H1 capability and transaction gates", () => {
  test("PostgreSQL-unavailable capability refuses producer and consumer calls before first SQL", () => {
    let sqlCalls = 0;
    const unavailable: DbAdapter = {
      dialect: "postgres",
      atomicQueueTransactions: "unavailable",
      run(): QueryResult { sqlCalls++; return { changes: 0 }; },
      get<T>(): T | null { sqlCalls++; return null; },
      all<T>(): T[] { sqlCalls++; return []; },
      exec(): void { sqlCalls++; },
      transaction<T>(_fn: () => T): T { sqlCalls++; throw new Error("must not run"); },
      immediateTransaction<T>(_fn: () => T): T { sqlCalls++; throw new Error("must not run"); },
      close(): void {},
    };
    const principal: NodeConsumerPrincipal = {
      kind: "node_consumer", userId: "u", networkId: "n", nodeId: "node", tokenId: "tok", aliasSnapshot: "a",
    };
    const service = new H1QueueService(unavailable);
    for (const call of [
      () => service.enqueueTask(principal, { operationId: "o", targetNodeId: "x", content: "c" }),
      () => service.claim(principal, { limit: 1 }),
      () => service.renew(principal, { deliveryId: "d", leaseId: "l", epoch: "1" }),
      () => service.acknowledge(principal, { deliveryId: "d", leaseId: "l", epoch: "1", operationId: "a" }),
      () => service.cancel(principal, { taskId: "t", operationId: "c" }),
    ]) {
      expect(call).toThrow(AtomicQueueTransactionsUnavailableError);
      expect(sqlCalls).toBe(0);
    }
  });

  test("principal is revalidated inside the mutation transaction before queue writes", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const before = tableSnapshot(h.raw, ATOMIC_TABLES);
    h.db.run("UPDATE api_tokens SET revoked_at='2026-01-01' WHERE token_id='tok-a'");
    expect(() => h.service.enqueueMessage(h.principalA, { operationId: "revoked", targetNodeId: "node-b", content: "x" }))
      .toThrow("consumer_principal_invalid");
    expect(tableSnapshot(h.raw, ATOMIC_TABLES)).toBe(before);
  });
});

describe("#440 H1 terminal transaction atomicity", () => {
  test("ordinary reply storage failure is not washed into an absent destination", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueTask(h.principalA, { operationId: "enqueue-storage-fault", targetNodeId: "node-b", content: "work" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...lease, operationId: "ack-storage-fault" });
    const before = tableSnapshot(h.raw, ATOMIC_TABLES);
    const originalGet = h.db.get.bind(h.db);
    h.db.get = ((sql: string, ...params: unknown[]) => {
      if (sql.includes("SELECT node_id, COALESCE(alias, node_name) AS alias_snapshot") && params[0] === "node-a") {
        throw new Error("injected_reply_target_storage_failure");
      }
      return originalGet(sql, ...params);
    }) as typeof h.db.get;
    expect(() => h.service.reply(h.principalB, { ...lease, operationId: "reply-storage-fault", result: "answer" }))
      .toThrow("injected_reply_target_storage_failure");
    expect(tableSnapshot(h.raw, ATOMIC_TABLES)).toBe(before);
  });

  for (const stage of [
    "after_delivery", "after_task", "after_reply_resource", "after_event",
    "after_audit", "after_idempotency", "after_doorbell",
  ] satisfies QueueFaultStage[]) {
    test(`reply fault ${stage} rolls every table back byte-for-byte`, () => {
      const h = createQueueTestHarness(); cleanups.push(h.close);
      h.service.enqueueTask(h.principalA, { operationId: "enqueue", targetNodeId: "node-b", content: "work" });
      const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
      h.service.acknowledge(h.principalB, { ...lease, operationId: "ack" });
      const before = tableSnapshot(h.raw, ATOMIC_TABLES);
      h.setFault(stage);
      expect(() => h.service.reply(h.principalB, { ...lease, operationId: "reply", result: "answer" }))
        .toThrow(`fault:${stage}`);
      expect(tableSnapshot(h.raw, ATOMIC_TABLES)).toBe(before);
    });
  }

  test("real event/audit/idempotency/outbox INSERT failures roll terminal state back", () => {
    for (const [table, trigger] of [
      ["task_events", "fail_task_event"],
      ["h1_queue_security_audit", "fail_queue_audit"],
      ["h1_queue_idempotency", "fail_queue_idem"],
      ["h1_queue_doorbell_outbox", "fail_queue_outbox"],
    ] as const) {
      const h = createQueueTestHarness();
      try {
        h.service.enqueueTask(h.principalA, { operationId: `enqueue-${table}`, targetNodeId: "node-b", content: "work" });
        const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
        h.service.acknowledge(h.principalB, { ...lease, operationId: `ack-${table}` });
        const before = tableSnapshot(h.raw, ATOMIC_TABLES);
        h.raw.exec(`CREATE TRIGGER ${trigger} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected_${table}_failure'); END`);
        expect(() => h.service.reply(h.principalB, { ...lease, operationId: `reply-${table}`, result: "answer" }))
          .toThrow(`injected_${table}_failure`);
        expect(tableSnapshot(h.raw, ATOMIC_TABLES)).toBe(before);
      } finally {
        h.close();
      }
    }
  });

  test("successful reply terminalizes original task and creates zero child task", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const original = h.service.enqueueTask(h.principalA, { operationId: "enqueue", targetNodeId: "node-b", content: "work" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...lease, operationId: "ack" });
    const result = h.service.reply(h.principalB, { ...lease, operationId: "reply", result: "answer" });
    expect(result).toEqual({ deliveryId: original.deliveryId, taskId: original.taskId, state: "replied" });
    const task = h.raw.query("SELECT status, result, completed_at FROM tasks WHERE task_id=?1").get(original.taskId) as any;
    expect(task.status).toBe("replied");
    expect(task.result).toBe("answer");
    expect(task.completed_at).toBeTruthy();
    expect((h.raw.query("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(1);
    const stable = tableSnapshot(h.raw, ATOMIC_TABLES);
    expect(h.service.reply(h.principalB, { ...lease, operationId: "reply", result: "answer" })).toEqual(result);
    expect(tableSnapshot(h.raw, ATOMIC_TABLES)).toBe(stable);
    expect(() => h.service.reply(h.principalB, { ...lease, operationId: "changed", result: "overwrite" }))
      .toThrow("lease_invalid_or_not_owned");
    expect(tableSnapshot(h.raw, ATOMIC_TABLES)).toBe(stable);
  });

  test("reply may terminalize an exact leased task without a separate acknowledgement", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const original = h.service.enqueueTask(h.principalA, {
      operationId: "enqueue-direct-reply", targetNodeId: "node-b", content: "work",
    });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;

    expect(h.service.reply(h.principalB, {
      ...lease, operationId: "direct-reply", result: "answer",
    })).toEqual({ deliveryId: original.deliveryId, taskId: original.taskId, state: "replied" });
    expect(h.raw.query("SELECT acked FROM inbox WHERE id=?1").get(original.resourceId)).toEqual({ acked: 1 });
    expect(h.raw.query("SELECT status, result FROM tasks WHERE task_id=?1").get(original.taskId))
      .toEqual({ status: "replied", result: "answer" });
    expect(h.raw.query(
      "SELECT from_status, to_status FROM task_events WHERE task_id=?1 ORDER BY id DESC LIMIT 1",
    ).get(original.taskId)).toEqual({ from_status: "delivered", to_status: "replied" });
  });

  test("absent, foreign, and already-consumed deliveries use one non-oracular error", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueMessage(h.principalA, { operationId: "m", targetNodeId: "node-b", content: "m" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...lease, operationId: "consume" });
    const before = tableSnapshot(h.raw, ATOMIC_TABLES);
    const calls = [
      () => h.service.acknowledge(h.principalB, { deliveryId: "absent", leaseId: "x", epoch: "1", operationId: "absent" }),
      () => h.service.acknowledge(h.principalC, { ...lease, operationId: "foreign" }),
      () => h.service.acknowledge(h.principalB, { ...lease, operationId: "consumed-again" }),
    ];
    for (const call of calls) {
      try { call(); throw new Error("expected failure"); }
      catch (error) { expect(error).toBeInstanceOf(QueueServiceError); expect((error as QueueServiceError).code).toBe("lease_invalid_or_not_owned"); }
      expect(tableSnapshot(h.raw, ATOMIC_TABLES)).toBe(before);
    }
  });
});

describe("#440 H1 attachment-only lineage", () => {
  test("terminal parent projection rejects delegation before child or edge creation", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueTask(h.principalA, { operationId: "parent", targetNodeId: "node-b", content: "parent" });
    const parentLease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...parentLease, operationId: "parent-ack" });
    h.db.run(
      "UPDATE tasks SET status='replied', result='legacy terminal result', completed_at=?1 WHERE task_id=?2",
      [new Date(h.nowMs()).toISOString(), parentLease.taskId],
    );
    const before = tableSnapshot(h.raw, ATOMIC_TABLES);
    expect(() => h.service.delegateTask(h.principalB, {
      parentDeliveryId: parentLease.deliveryId,
      parentLeaseId: parentLease.leaseId,
      parentEpoch: parentLease.epoch,
      operationId: "must-not-delegate",
      targetNodeId: "node-c",
      content: "child",
    })).toThrow("lease_invalid_or_not_owned");
    expect(tableSnapshot(h.raw, ATOMIC_TABLES)).toBe(before);
  });

  test("child completion creates one no-response attachment for exact delegator and never mutates parent", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueTask(h.principalA, { operationId: "parent", targetNodeId: "node-b", content: "parent" });
    const parentLease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...parentLease, operationId: "parent-ack" });
    const child = h.service.delegateTask(h.principalB, {
      parentDeliveryId: parentLease.deliveryId, parentLeaseId: parentLease.leaseId,
      parentEpoch: parentLease.epoch, operationId: "delegate", targetNodeId: "node-c", content: "child",
    });
    const childLease = h.service.claim(h.principalC, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalC, { ...childLease, operationId: "child-ack" });
    const parentBefore = JSON.stringify(h.raw.query("SELECT * FROM tasks WHERE task_id=?1").get(parentLease.taskId));
    h.service.reply(h.principalC, { ...childLease, operationId: "child-reply", result: "child result" });
    expect(JSON.stringify(h.raw.query("SELECT * FROM tasks WHERE task_id=?1").get(parentLease.taskId))).toBe(parentBefore);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(2);
    const attachment = h.raw.query(`SELECT a.*, d.resource_kind, d.task_id, d.requires_response, d.consumer_node_id
      FROM h1_reply_attachments a JOIN h1_queue_deliveries d ON d.delivery_id=a.attachment_delivery_id`).get() as any;
    expect(attachment.edge_id).toBe(child.edgeId);
    expect(attachment.resource_kind).toBe("reply");
    expect(attachment.task_id).toBeNull();
    expect(attachment.requires_response).toBe(0);
    expect(attachment.consumer_node_id).toBe("node-b");
    const attachmentLease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    expect(attachmentLease.resourceKind).toBe("reply");
    expect(h.service.acknowledge(h.principalB, { ...attachmentLease, operationId: "attachment-consume" }).state).toBe("consumed");
    expect((h.raw.query("SELECT COUNT(*) AS n FROM tasks").get() as any).n).toBe(2);
  });

  for (const parentChange of ["cancel", "reassign"] as const) {
    const changedLabel = parentChange === "cancel" ? "cancelled" : "reassigned";
    test(`child remains completable but ${changedLabel} parent suppresses attachment and stays byte-stable`, () => {
      const h = createQueueTestHarness(); cleanups.push(h.close);
      const parent = h.service.enqueueTask(h.principalA, { operationId: "parent", targetNodeId: "node-b", content: "parent" });
      const parentLease = h.service.claim(h.principalB, { limit: 1 })[0]!;
      h.service.acknowledge(h.principalB, { ...parentLease, operationId: "parent-ack" });
      h.service.delegateTask(h.principalB, {
        parentDeliveryId: parentLease.deliveryId, parentLeaseId: parentLease.leaseId,
        parentEpoch: parentLease.epoch, operationId: "delegate", targetNodeId: "node-c", content: "child",
      });
      const childLease = h.service.claim(h.principalC, { limit: 1 })[0]!;
      h.service.acknowledge(h.principalC, { ...childLease, operationId: "child-ack" });
      if (parentChange === "cancel") h.service.cancel(h.principalA, { taskId: parent.taskId!, operationId: "parent-cancel" });
      else h.service.reassign(h.control, { taskId: parent.taskId!, targetNodeId: "node-c", operationId: "parent-reassign" });
      const parentBefore = JSON.stringify(h.raw.query("SELECT * FROM tasks WHERE task_id=?1").get(parent.taskId));
      const parentDeliveryBefore = JSON.stringify(h.raw.query("SELECT * FROM h1_queue_deliveries WHERE delivery_id=?1").get(parent.deliveryId));
      expect(h.service.reply(h.principalC, { ...childLease, operationId: "child-reply", result: "child result" }).state).toBe("replied");
      expect(JSON.stringify(h.raw.query("SELECT * FROM tasks WHERE task_id=?1").get(parent.taskId))).toBe(parentBefore);
      expect(JSON.stringify(h.raw.query("SELECT * FROM h1_queue_deliveries WHERE delivery_id=?1").get(parent.deliveryId))).toBe(parentDeliveryBefore);
      expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_reply_attachments").get() as any).n).toBe(0);
      expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_queue_security_audit WHERE action='attachment_suppressed_stale_parent'").get() as any).n).toBe(1);
    });
  }
});

describe("#440 H1 doorbell generation guard", () => {
  test("terminal task projection suppresses an otherwise-current pending wakeup", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const queued = h.service.enqueueTask(h.principalA, {
      operationId: "terminal-before-doorbell",
      targetNodeId: "node-b",
      content: "work",
    });
    h.db.run(
      "UPDATE tasks SET status='replied', result='legacy terminal result', completed_at=?1 WHERE task_id=?2",
      [new Date(h.nowMs()).toISOString(), queued.taskId],
    );
    expect(h.service.listReadyDoorbells()).toEqual([]);
    expect((h.raw.query(
      "SELECT status FROM h1_queue_doorbell_outbox WHERE expected_delivery_id=?1",
    ).get(queued.deliveryId) as any).status).toBe("suppressed");
  });

  test("stale epoch/state wakeups are suppressed and payload is identifier-free", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueMessage(h.principalA, { operationId: "m", targetNodeId: "node-b", content: "m" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    expect(h.service.listReadyDoorbells()).toEqual([]);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_queue_doorbell_outbox WHERE status='suppressed'").get() as any).n).toBe(1);
    h.db.run(`INSERT INTO h1_queue_doorbell_outbox
      (outbox_id, network_id, consumer_node_id, expected_delivery_id, expected_epoch, expected_state, status, created_at_ms)
      VALUES ('manual', 'net-a', 'node-b', ?1, CAST(?2 AS INTEGER), 'leased', 'pending', ?3)`,
      [lease.deliveryId, lease.epoch, h.nowMs()]);
    const ready = h.service.listReadyDoorbells();
    expect(ready).toEqual([{ outboxId: "manual", consumerNodeId: "node-b", payload: { type: "queue_changed" } }]);
    expect(JSON.stringify(ready)).not.toContain(lease.deliveryId);
    expect(JSON.stringify(ready)).not.toContain(lease.leaseId);
    h.service.acknowledge(h.principalB, { ...lease, operationId: "consume" });
    expect(h.service.listReadyDoorbells()).toEqual([]);
    expect((h.raw.query("SELECT status FROM h1_queue_doorbell_outbox WHERE outbox_id='manual'").get() as any).status).toBe("suppressed");
  });
});
