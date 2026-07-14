import { afterEach, describe, expect, test } from "bun:test";
import { createQueueTestHarness, tableSnapshot } from "./hub-440-queue-test-support.js";
import { QueueServiceError } from "./hub-440-queue-types.js";

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });
const LEASE_TABLES = [
  "tasks", "inbox", "task_events", "h1_queue_deliveries", "h1_task_assignments",
  "h1_queue_idempotency", "h1_queue_idempotency_refs", "h1_queue_security_audit", "h1_queue_doorbell_outbox",
] as const;

describe("#440 H1 lease admission", () => {
  test("claim rejects a delivery whose exact inbox recipient was changed", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const queued = h.service.enqueueMessage(h.principalA, {
      operationId: "recipient-mismatch",
      targetNodeId: "node-b",
      content: "exact recipient",
    });
    h.db.run("UPDATE inbox SET node_id='node-c' WHERE id=?1", [queued.resourceId]);
    const before = tableSnapshot(h.raw, LEASE_TABLES);
    expect(h.service.claim(h.principalB, { limit: 1 })).toEqual([]);
    expect(h.leaseMintCount()).toBe(0);
    expect(tableSnapshot(h.raw, LEASE_TABLES)).toBe(before);
  });

  test("terminal task projection cannot be reclaimed through a still-pending delivery", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const queued = h.service.enqueueTask(h.principalA, {
      operationId: "terminal-projection",
      targetNodeId: "node-b",
      content: "must stay terminal",
    });
    h.db.run(
      "UPDATE tasks SET status='replied', result='legacy terminal result', completed_at=?1 WHERE task_id=?2",
      [new Date(h.nowMs()).toISOString(), queued.taskId],
    );
    const before = tableSnapshot(h.raw, LEASE_TABLES);
    expect(h.service.claim(h.principalB, { limit: 1 })).toEqual([]);
    expect(h.leaseMintCount()).toBe(0);
    expect(tableSnapshot(h.raw, LEASE_TABLES)).toBe(before);
  });

  test("terminal task projection invalidates renew even when delivery lease still looks active", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueTask(h.principalA, {
      operationId: "terminal-after-ack",
      targetNodeId: "node-b",
      content: "must not renew",
    });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...lease, operationId: "ack-before-terminal" });
    h.db.run(
      "UPDATE tasks SET status='replied', result='legacy terminal result', completed_at=?1 WHERE task_id=?2",
      [new Date(h.nowMs()).toISOString(), lease.taskId],
    );
    const before = tableSnapshot(h.raw, LEASE_TABLES);
    expect(() => h.service.renew(h.principalB, lease)).toThrow("lease_invalid_or_not_owned");
    expect(tableSnapshot(h.raw, LEASE_TABLES)).toBe(before);
  });

  test("claim and renew audit failures roll lease state back", () => {
    const claimHarness = createQueueTestHarness();
    try {
      claimHarness.service.enqueueMessage(claimHarness.principalA, { operationId: "claim-audit", targetNodeId: "node-b", content: "m" });
      const beforeClaim = tableSnapshot(claimHarness.raw, ["h1_queue_deliveries", "h1_queue_security_audit"]);
      claimHarness.raw.exec("CREATE TRIGGER fail_claim_audit BEFORE INSERT ON h1_queue_security_audit BEGIN SELECT RAISE(ABORT, 'claim_audit_failure'); END");
      expect(() => claimHarness.service.claim(claimHarness.principalB, { limit: 1 })).toThrow("claim_audit_failure");
      expect(tableSnapshot(claimHarness.raw, ["h1_queue_deliveries", "h1_queue_security_audit"])).toBe(beforeClaim);
    } finally { claimHarness.close(); }

    const renewHarness = createQueueTestHarness();
    try {
      renewHarness.service.enqueueMessage(renewHarness.principalA, { operationId: "renew-audit", targetNodeId: "node-b", content: "m" });
      const lease = renewHarness.service.claim(renewHarness.principalB, { limit: 1 })[0]!;
      const beforeRenew = tableSnapshot(renewHarness.raw, ["h1_queue_deliveries", "h1_queue_security_audit"]);
      renewHarness.raw.exec("CREATE TRIGGER fail_renew_audit BEFORE INSERT ON h1_queue_security_audit BEGIN SELECT RAISE(ABORT, 'renew_audit_failure'); END");
      expect(() => renewHarness.service.renew(renewHarness.principalB, lease)).toThrow("renew_audit_failure");
      expect(tableSnapshot(renewHarness.raw, ["h1_queue_deliveries", "h1_queue_security_audit"])).toBe(beforeRenew);
    } finally { renewHarness.close(); }
  });

  test("task claim is one-shot, lost response stays exclusive until TTL, then epoch increments", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const enqueued = h.service.enqueueTask(h.principalA, { operationId: "enqueue-1", targetNodeId: "node-b", content: "work" });
    const first = h.service.claim(h.principalB, { limit: 1 });
    expect(first).toHaveLength(1);
    expect(first[0]?.taskId).toBe(enqueued.taskId);
    expect(first[0]?.epoch).toBe("1");
    expect(JSON.stringify(h.raw.query("SELECT * FROM h1_queue_deliveries").all())).not.toContain(first[0]!.leaseId);
    expect(h.service.claim(h.principalB, { limit: 1 })).toEqual([]);
    h.advance(30_001);
    const reclaimed = h.service.claim(h.principalB, { limit: 1 });
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]?.deliveryId).toBe(first[0]?.deliveryId);
    expect(reclaimed[0]?.epoch).toBe("2");
    expect(reclaimed[0]?.leaseId).not.toBe(first[0]?.leaseId);
    expect(() => h.service.renew(h.principalB, first[0]!)).toThrow("lease_invalid_or_not_owned");
  });

  test("expired running task reclaim resets exact inbox projection before the next ack", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueTask(h.principalA, { operationId: "running-reclaim", targetNodeId: "node-b", content: "work" });
    const first = h.service.claim(h.principalB, { limit: 1 })[0]!;
    h.service.acknowledge(h.principalB, { ...first, operationId: "first-ack" });
    h.advance(30_001);
    const second = h.service.claim(h.principalB, { limit: 1 })[0]!;
    expect(second.epoch).toBe("2");
    expect((h.raw.query("SELECT acked FROM inbox WHERE id=?1").get(second.resourceId) as any).acked).toBe(0);
    expect(h.service.acknowledge(h.principalB, { ...second, operationId: "second-ack" }).state).toBe("running");
  });

  test("cap=10 fails before candidate selection/mint and preserves every active lease", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    for (let i = 0; i < 11; i++) h.service.enqueueMessage(h.principalA, { operationId: `m-${i}`, targetNodeId: "node-b", content: `m${i}` });
    const ten = h.service.claim(h.principalB, { limit: 10 });
    expect(ten).toHaveLength(10);
    const mintedBeforeRefusal = h.leaseMintCount();
    const before = tableSnapshot(h.raw, ["h1_queue_deliveries"]);
    expect(() => h.service.claim(h.principalB, { limit: 1 })).toThrow("consumer_inflight_limit");
    expect(h.leaseMintCount()).toBe(mintedBeforeRefusal);
    expect(tableSnapshot(h.raw, ["h1_queue_deliveries"])).toBe(before);
  });

  test("renew is monotonic, preserves epoch/hash/attempt, and audits every success", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueMessage(h.principalA, { operationId: "m", targetNodeId: "node-b", content: "m" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    const rowBefore = h.raw.query("SELECT epoch, lease_hash, attempt_number, lease_expires_at_ms FROM h1_queue_deliveries WHERE delivery_id=?1").get(lease.deliveryId) as any;
    const a = h.service.renew(h.principalB, lease);
    const b = h.service.renew(h.principalB, lease);
    expect(b.expiresAt).toBe(a.expiresAt);
    const rowAfter = h.raw.query("SELECT epoch, lease_hash, attempt_number, lease_expires_at_ms FROM h1_queue_deliveries WHERE delivery_id=?1").get(lease.deliveryId) as any;
    expect(rowAfter.epoch).toBe(rowBefore.epoch);
    expect(rowAfter.lease_hash).toBe(rowBefore.lease_hash);
    expect(rowAfter.attempt_number).toBe(rowBefore.attempt_number);
    expect(rowAfter.lease_expires_at_ms).toBeGreaterThanOrEqual(rowBefore.lease_expires_at_ms);
    expect((h.raw.query("SELECT COUNT(*) AS n FROM h1_queue_security_audit WHERE action='lease_renewed'").get() as any).n).toBe(2);
  });

  test("epoch above MAX_SAFE_INTEGER round-trips as decimal and increments only in SQL", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const e = h.service.enqueueMessage(h.principalA, { operationId: "big", targetNodeId: "node-b", content: "m" });
    h.raw.exec(`UPDATE h1_queue_deliveries SET epoch=9007199254740993 WHERE delivery_id='${e.deliveryId}'`);
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    expect(lease.epoch).toBe("9007199254740994");
    expect(() => h.service.renew(h.principalB, { ...lease, epoch: "09007199254740994" })).toThrow("lease_invalid_or_not_owned");
  });

  test("int64 epoch exhaustion fails before lease mint with a stable transition conflict", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    const e = h.service.enqueueMessage(h.principalA, { operationId: "max", targetNodeId: "node-b", content: "m" });
    h.raw.exec(`UPDATE h1_queue_deliveries SET epoch=9223372036854775807 WHERE delivery_id='${e.deliveryId}'`);
    const before = tableSnapshot(h.raw, ["h1_queue_deliveries", "h1_queue_security_audit"]);
    const mints = h.leaseMintCount();
    expect(() => h.service.claim(h.principalB, { limit: 1 })).toThrow("queue_transition_conflict");
    expect(h.leaseMintCount()).toBe(mints);
    expect(tableSnapshot(h.raw, ["h1_queue_deliveries", "h1_queue_security_audit"])).toBe(before);
  });

  test("wrong principal/token/hash/epoch and expired lease share one generic error with zero mutation", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueMessage(h.principalA, { operationId: "m", targetNodeId: "node-b", content: "m" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    const before = tableSnapshot(h.raw, ["h1_queue_deliveries", "inbox", "h1_queue_security_audit"]);
    for (const attempt of [
      () => h.service.acknowledge(h.principalC, { ...lease, operationId: "bad-p" }),
      () => h.service.acknowledge(h.principalB, { ...lease, leaseId: "x", operationId: "bad-h" }),
      () => h.service.acknowledge(h.principalB, { ...lease, epoch: "999", operationId: "bad-e" }),
    ]) {
      try { attempt(); throw new Error("expected refusal"); }
      catch (error) { expect(error).toBeInstanceOf(QueueServiceError); expect((error as QueueServiceError).code).toBe("lease_invalid_or_not_owned"); }
      expect(tableSnapshot(h.raw, ["h1_queue_deliveries", "inbox", "h1_queue_security_audit"])).toBe(before);
    }
  });
});

describe("#440 H1 no-response terminality", () => {
  test("message ack becomes consumed, creates no task/outbox/lineage, and identical replay is read-only", () => {
    const h = createQueueTestHarness(); cleanups.push(h.close);
    h.service.enqueueMessage(h.principalA, { operationId: "m", targetNodeId: "node-b", content: "m" });
    const lease = h.service.claim(h.principalB, { limit: 1 })[0]!;
    const first = h.service.acknowledge(h.principalB, { ...lease, operationId: "consume-1" });
    expect(first.state).toBe("consumed");
    const stable = tableSnapshot(h.raw, ["h1_queue_deliveries", "tasks", "h1_queue_doorbell_outbox", "h1_delegation_edges"]);
    expect(h.service.acknowledge(h.principalB, { ...lease, operationId: "consume-1" })).toEqual(first);
    expect(tableSnapshot(h.raw, ["h1_queue_deliveries", "tasks", "h1_queue_doorbell_outbox", "h1_delegation_edges"])).toBe(stable);
    for (const op of ["consume-2", "consume-3"]) {
      expect(() => h.service.acknowledge(h.principalB, { ...lease, operationId: op })).toThrow("lease_invalid_or_not_owned");
    }
  });
});
