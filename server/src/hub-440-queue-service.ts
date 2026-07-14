import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AtomicQueueTransactionsUnavailableError,
  type DbAdapter,
} from "./db-adapter.js";
import {
  revalidateNodeConsumerPrincipal,
  revalidateQueueControlPrincipal,
} from "./hub-440-principal.js";
import {
  QueueServiceError,
  type ConsumerLease,
  type DelegationResult,
  type DeliveryMutationResult,
  type DeliveryResourceKind,
  type DeliveryState,
  type EnqueueResult,
  type NodeConsumerPrincipal,
  type QueueControlPrincipal,
  type QueueFaultStage,
  type QueuePrincipal,
  type QueueServiceOptions,
  type RenewResult,
} from "./hub-440-queue-types.js";

const LEASE_TTL_MS = 30_000;
const MAX_INFLIGHT = 10;
const MAX_EPOCH = "9223372036854775807";
const TERMINAL_STATES = ["consumed", "replied", "dead_lettered", "cancelled", "superseded"] as const;
const EXACT_RESOURCE_D = `
  EXISTS (
    SELECT 1 FROM inbox i
     WHERE i.id=d.resource_id AND i.network_id=d.network_id
       AND i.node_id=d.consumer_node_id AND i.type=d.resource_kind
       AND ((d.resource_kind='task' AND i.requires_response='reply')
         OR (d.resource_kind!='task' AND i.requires_response='none'))
       AND ((d.state IN ('pending','leased') AND i.acked=0)
         OR (d.resource_kind='task' AND d.state='running' AND i.acked=1))
  )
  AND (
    d.task_id IS NULL OR (
      d.resource_kind='task'
      AND EXISTS (
        SELECT 1 FROM tasks t
         WHERE t.task_id=d.task_id AND t.network_id=d.network_id
           AND t.to_node_id=d.consumer_node_id
           AND ((d.state IN ('pending','leased') AND t.status='delivered')
             OR (d.state='running' AND t.status='acked'))
      )
      AND EXISTS (
        SELECT 1 FROM h1_task_assignments a
         WHERE a.task_id=d.task_id AND a.network_id=d.network_id
           AND a.consumer_node_id=d.consumer_node_id AND a.delivery_id=d.delivery_id
           AND a.producer_node_id IS d.producer_node_id
      )
    )
  )`;
const EXACT_RESOURCE_TABLE = EXACT_RESOURCE_D.replaceAll("d.", "h1_queue_deliveries.");

type TargetNode = { node_id: string; alias_snapshot: string };
type DeliveryRow = {
  delivery_id: string;
  resource_kind: DeliveryResourceKind;
  resource_id: string;
  task_id: string | null;
  network_id: string;
  consumer_node_id: string;
  producer_node_id: string | null;
  requires_response: number;
  state: DeliveryState;
  epoch_text: string;
  assignment_generation_text: string;
  lease_expires_at_ms: number | null;
};

type IdempotencyRow = {
  operation: string;
  request_digest: string;
  result_json: string;
};

export type ReadyDoorbell = Readonly<{
  outboxId: string;
  consumerNodeId: string;
  payload: Readonly<{ type: "queue_changed"; count?: number }>;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalEpoch(value: string): boolean {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) return false;
  if (value.length < MAX_EPOCH.length) return true;
  if (value.length > MAX_EPOCH.length) return false;
  return value <= MAX_EPOCH;
}

export class H1QueueService {
  private readonly nowMs: () => number;
  private readonly randomId: (prefix: string) => string;
  private readonly leaseSecret: () => string;
  private readonly faultAt?: (stage: QueueFaultStage) => void;

  constructor(private readonly db: DbAdapter, options: QueueServiceOptions = {}) {
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.randomId = options.randomId ?? ((prefix) => `${prefix}_${randomUUID().replaceAll("-", "")}`);
    this.leaseSecret = options.leaseSecret ?? (() => randomBytes(32).toString("base64url"));
    this.faultAt = options.faultAt;
  }

  private ensureAtomic(): void {
    if (this.db.atomicQueueTransactions !== "same_connection_immediate") {
      throw new AtomicQueueTransactionsUnavailableError();
    }
  }

  private transaction<T>(principal: QueuePrincipal, body: () => T): T {
    this.ensureAtomic();
    return this.db.immediateTransaction(() => {
      if (principal.kind === "node_consumer") {
        revalidateNodeConsumerPrincipal(this.db, principal);
      } else {
        revalidateQueueControlPrincipal(this.db, principal);
      }
      return body();
    });
  }

  private fault(stage: QueueFaultStage): void {
    this.faultAt?.(stage);
  }

  private principalId(principal: QueuePrincipal): string {
    return principal.kind === "node_consumer" ? principal.nodeId : principal.userId;
  }

  private requestDigest(value: unknown): string {
    return sha256(JSON.stringify(value));
  }

  private replay<T>(principal: QueuePrincipal, operationId: string, operation: string, digest: string): T | null {
    if (!operationId) throw new QueueServiceError("invalid_queue_request", 400);
    const row = this.db.get<IdempotencyRow>(
      `SELECT operation, request_digest, result_json
         FROM h1_queue_idempotency
        WHERE network_id=?1 AND principal_kind=?2 AND principal_id=?3
          AND token_id=?4 AND operation_id=?5`,
      principal.networkId,
      principal.kind,
      this.principalId(principal),
      principal.tokenId,
      operationId,
    );
    if (!row) return null;
    if (row.operation !== operation || row.request_digest !== digest) {
      throw new QueueServiceError("operation_conflict");
    }
    return JSON.parse(row.result_json) as T;
  }

  private storeReplay(
    principal: QueuePrincipal,
    operationId: string,
    operation: string,
    digest: string,
    result: unknown,
    taskId: string | null,
    deliveryId: string | null,
    references?: readonly Readonly<{ deliveryId: string; taskId: string | null }>[],
  ): void {
    this.db.run(
      `INSERT INTO h1_queue_idempotency
         (network_id, principal_kind, principal_id, token_id, operation_id,
          operation, request_digest, result_json, task_id, delivery_id, created_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      [principal.networkId, principal.kind, this.principalId(principal), principal.tokenId,
        operationId, operation, digest, JSON.stringify(result), taskId, deliveryId, this.nowMs()],
    );
    const refs = references ?? (deliveryId ? [{ deliveryId, taskId }] : []);
    for (const ref of refs) {
      this.db.run(
        `INSERT INTO h1_queue_idempotency_refs
           (network_id, principal_kind, principal_id, token_id, operation_id, delivery_id, task_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        [principal.networkId, principal.kind, this.principalId(principal), principal.tokenId,
          operationId, ref.deliveryId, ref.taskId],
      );
    }
  }

  private audit(
    principal: QueuePrincipal | null,
    action: string,
    taskId: string | null,
    deliveryId: string | null,
    detail: Record<string, unknown> = {},
  ): void {
    const now = this.nowMs();
    this.db.run(
      `INSERT INTO h1_queue_security_audit
         (audit_id, network_id, principal_kind, principal_id, token_id, action,
          task_id, delivery_id, detail_json, created_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
      [this.randomId("qaudit"), principal?.networkId ?? String(detail.networkId ?? ""),
        principal?.kind ?? "system", principal ? this.principalId(principal) : "system",
        principal?.tokenId ?? null, action, taskId, deliveryId, JSON.stringify(detail), now],
    );
  }

  private targetNode(networkId: string, nodeId: string): TargetNode {
    const row = this.db.get<TargetNode>(
      `SELECT node_id, COALESCE(alias, node_name) AS alias_snapshot
         FROM nodes
        WHERE node_id=?1 AND network_id=?2
          AND COALESCE(lifecycle_state, 'active')='active'
        LIMIT 1`,
      nodeId,
      networkId,
    );
    if (!row) throw new QueueServiceError("target_node_unavailable", 404);
    return row;
  }

  private producerAlias(principal: QueuePrincipal): string {
    return principal.kind === "node_consumer" ? principal.aliasSnapshot : "hub";
  }

  private insertDoorbell(deliveryId: string, consumerNodeId: string, epoch: string, state: DeliveryState): void {
    const inserted = this.db.run(
      `INSERT INTO h1_queue_doorbell_outbox
         (outbox_id, network_id, consumer_node_id, expected_delivery_id,
          expected_epoch, expected_state, status, created_at_ms)
       SELECT ?1, network_id, ?2, ?3, CAST(?4 AS INTEGER), ?5, 'pending', ?6
         FROM h1_queue_deliveries WHERE delivery_id=?3`,
      [this.randomId("qbell"), consumerNodeId, deliveryId, epoch, state, this.nowMs()],
    ).changes;
    if (inserted !== 1) throw new QueueServiceError("queue_transition_conflict");
  }

  private insertDelivery(input: {
    principal: QueuePrincipal;
    target: TargetNode;
    kind: DeliveryResourceKind;
    resourceId: string;
    taskId: string | null;
    producerNodeId: string | null;
  }): string {
    const deliveryId = this.randomId("qdel");
    const now = this.nowMs();
    this.db.run(
      `INSERT INTO h1_queue_deliveries
         (delivery_id, resource_kind, resource_id, task_id, network_id,
          consumer_node_id, producer_node_id, requires_response, state, epoch,
          assignment_generation, attempt_number, created_at_ms, updated_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', 0, 0, 0, ?9, ?9)`,
      [deliveryId, input.kind, input.resourceId, input.taskId, input.principal.networkId,
        input.target.node_id, input.producerNodeId, input.kind === "task" ? 1 : 0, now],
    );
    return deliveryId;
  }

  private enqueueTaskRows(
    principal: QueuePrincipal,
    target: TargetNode,
    content: string,
    priority = "normal",
    parentTaskId: string | null = null,
    source?: Readonly<{ nodeId: string | null; alias: string }>,
  ): EnqueueResult {
    if (!content) throw new QueueServiceError("invalid_queue_request", 400);
    const taskId = this.randomId("qtask");
    const resourceId = this.randomId("qres");
    const now = this.nowMs();
    const producerNodeId = source ? source.nodeId : (principal.kind === "node_consumer" ? principal.nodeId : null);
    const producerAlias = source?.alias ?? this.producerAlias(principal);
    this.db.run(
      `INSERT INTO tasks
         (task_id, from_node_id, from_name, to_node_id, to_name, priority, status,
          content, requires_response, network_id, created_at, delivered_at, parent_task_id)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'delivered', ?7, 'reply', ?8, ?9, ?9, ?10)`,
      [taskId, producerNodeId, producerAlias, target.node_id,
        target.alias_snapshot, priority, content, principal.networkId, new Date(now).toISOString(), parentTaskId],
    );
    this.db.run(
      `INSERT INTO inbox
         (id, session_name, node_id, type, priority, content, from_session, acked,
          requires_response, network_id, created_at)
       VALUES (?1, ?2, ?3, 'task', ?4, ?5, ?6, 0, 'reply', ?7, ?8)`,
      [resourceId, target.alias_snapshot, target.node_id, priority, content,
        producerAlias, principal.networkId, new Date(now).toISOString()],
    );
    const deliveryId = this.insertDelivery({ principal, target, kind: "task", resourceId, taskId, producerNodeId });
    this.db.run(
      `INSERT INTO h1_task_assignments
         (task_id, network_id, producer_node_id, consumer_node_id, delivery_id, assignment_epoch, updated_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)`,
      [taskId, principal.networkId, producerNodeId, target.node_id, deliveryId, now],
    );
    this.db.run(
      "INSERT INTO task_events(task_id, from_status, to_status, actor, detail, network_id) VALUES (?1, NULL, 'delivered', ?2, 'h1 atomic enqueue', ?3)",
      [taskId, this.principalId(principal), principal.networkId],
    );
    return { resourceId, deliveryId, taskId };
  }

  private enqueueNoResponseRows(
    principal: QueuePrincipal,
    target: TargetNode,
    kind: Exclude<DeliveryResourceKind, "task">,
    content: string,
    producerNodeId = principal.kind === "node_consumer" ? principal.nodeId : null,
  ): EnqueueResult {
    if (!content) throw new QueueServiceError("invalid_queue_request", 400);
    const resourceId = this.randomId("qres");
    const now = this.nowMs();
    this.db.run(
      `INSERT INTO inbox
         (id, session_name, node_id, type, priority, content, from_session, acked,
          requires_response, network_id, created_at)
       VALUES (?1, ?2, ?3, ?4, 'normal', ?5, ?6, 0, 'none', ?7, ?8)`,
      [resourceId, target.alias_snapshot, target.node_id, kind, content,
        this.producerAlias(principal), principal.networkId, new Date(now).toISOString()],
    );
    const deliveryId = this.insertDelivery({ principal, target, kind, resourceId, taskId: null, producerNodeId });
    return { resourceId, deliveryId, taskId: null };
  }

  enqueueTask(principal: QueuePrincipal, input: { operationId: string; targetNodeId: string; content: string; priority?: string }): EnqueueResult {
    this.ensureAtomic();
    const digest = this.requestDigest({ targetNodeId: input.targetNodeId, content: input.content, priority: input.priority ?? "normal" });
    return this.transaction(principal, () => {
      const replay = this.replay<EnqueueResult>(principal, input.operationId, "enqueue_task", digest);
      if (replay) return replay;
      const target = this.targetNode(principal.networkId, input.targetNodeId);
      const result = this.enqueueTaskRows(principal, target, input.content, input.priority);
      this.fault("after_delivery");
      this.audit(principal, "task_enqueued", result.taskId, result.deliveryId);
      this.fault("after_audit");
      this.storeReplay(principal, input.operationId, "enqueue_task", digest, result, result.taskId, result.deliveryId);
      this.fault("after_idempotency");
      this.insertDoorbell(result.deliveryId, target.node_id, "0", "pending");
      this.fault("after_doorbell");
      return result;
    });
  }

  enqueueMessage(principal: QueuePrincipal, input: { operationId: string; targetNodeId: string; content: string }): EnqueueResult {
    this.ensureAtomic();
    const digest = this.requestDigest({ targetNodeId: input.targetNodeId, content: input.content });
    return this.transaction(principal, () => {
      const replay = this.replay<EnqueueResult>(principal, input.operationId, "enqueue_message", digest);
      if (replay) return replay;
      const target = this.targetNode(principal.networkId, input.targetNodeId);
      const result = this.enqueueNoResponseRows(principal, target, "message", input.content);
      this.audit(principal, "message_enqueued", null, result.deliveryId);
      this.storeReplay(principal, input.operationId, "enqueue_message", digest, result, null, result.deliveryId);
      this.insertDoorbell(result.deliveryId, target.node_id, "0", "pending");
      return result;
    });
  }

  enqueueBroadcast(principal: QueuePrincipal, input: { operationId: string; targetNodeIds: readonly string[]; content: string }): EnqueueResult[] {
    this.ensureAtomic();
    const targetNodeIds = [...new Set(input.targetNodeIds)].sort();
    const digest = this.requestDigest({ targetNodeIds, content: input.content });
    return this.transaction(principal, () => {
      const replay = this.replay<EnqueueResult[]>(principal, input.operationId, "enqueue_broadcast", digest);
      if (replay) return replay;
      if (targetNodeIds.length === 0) throw new QueueServiceError("invalid_queue_request", 400);
      const targets = targetNodeIds.map((id) => this.targetNode(principal.networkId, id));
      const results = targets.map((target) => {
        const result = this.enqueueNoResponseRows(principal, target, "broadcast", input.content);
        this.audit(principal, "broadcast_enqueued", null, result.deliveryId);
        this.insertDoorbell(result.deliveryId, target.node_id, "0", "pending");
        return result;
      });
      this.storeReplay(principal, input.operationId, "enqueue_broadcast", digest, results, null, null, results);
      return results;
    });
  }

  claim(principal: NodeConsumerPrincipal, input: { limit: number }): ConsumerLease[] {
    this.ensureAtomic();
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_INFLIGHT) {
      throw new QueueServiceError("invalid_queue_request", 400);
    }
    return this.transaction(principal, () => {
      const now = this.nowMs();
      const inflight = this.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM h1_queue_deliveries
          WHERE network_id=?1 AND consumer_node_id=?2 AND lease_owner_token_id=?3
            AND state IN ('leased','running') AND lease_expires_at_ms > ?4`,
        principal.networkId, principal.nodeId, principal.tokenId, now,
      )?.n ?? 0;
      if (inflight >= MAX_INFLIGHT) throw new QueueServiceError("consumer_inflight_limit", 429);
      const limit = Math.min(input.limit, MAX_INFLIGHT - inflight);
      const candidates = this.db.all<{ delivery_id: string; epoch_text: string; previous_state: DeliveryState }>(
        `SELECT d.delivery_id, CAST(d.epoch AS TEXT) AS epoch_text, d.state AS previous_state
           FROM h1_queue_deliveries d
          WHERE d.network_id=?1 AND d.consumer_node_id=?2
            AND (d.state='pending' OR (d.state IN ('leased','running') AND d.lease_expires_at_ms <= ?3))
            AND ${EXACT_RESOURCE_D}
          ORDER BY d.created_at_ms, d.delivery_id LIMIT ?4`,
        principal.networkId, principal.nodeId, now, limit,
      );
      const leases: ConsumerLease[] = [];
      for (const candidate of candidates) {
        if (candidate.epoch_text === MAX_EPOCH) {
          throw new QueueServiceError("queue_transition_conflict");
        }
        const leaseId = this.leaseSecret();
        const leaseHash = sha256(leaseId);
        const expires = now + LEASE_TTL_MS;
        const changed = this.db.run(
          `UPDATE h1_queue_deliveries
              SET state='leased', epoch=epoch+1, lease_hash=?1,
                  lease_owner_token_id=?2, lease_expires_at_ms=?3,
                  attempt_number=attempt_number+1,
                  terminal_at_ms=NULL, updated_at_ms=?4
            WHERE delivery_id=?5 AND network_id=?6 AND consumer_node_id=?7
              AND epoch < 9223372036854775807
              AND (state='pending' OR (state IN ('leased','running') AND lease_expires_at_ms <= ?4))`,
          [leaseHash, principal.tokenId, expires, now, candidate.delivery_id, principal.networkId, principal.nodeId],
        ).changes;
        if (changed !== 1) continue;
        const row = this.deliveryById(candidate.delivery_id);
        if (!row) throw new QueueServiceError("queue_transition_conflict");
        if (row.task_id && candidate.previous_state === "running") {
          const inboxChanged = this.db.run(
            `UPDATE inbox SET acked=0
              WHERE id=?1 AND network_id=?2 AND node_id=?3
                AND type='task' AND requires_response='reply' AND acked=1`,
            [row.resource_id, principal.networkId, principal.nodeId],
          ).changes;
          if (inboxChanged !== 1) throw new QueueServiceError("queue_transition_conflict");
          const taskChanged = this.db.run(
            `UPDATE tasks SET status='delivered', delivered_at=?1
              WHERE task_id=?2 AND network_id=?3 AND to_node_id=?4 AND status='acked'`,
            [new Date(now).toISOString(), row.task_id, principal.networkId, principal.nodeId],
          ).changes;
          if (taskChanged !== 1) throw new QueueServiceError("queue_transition_conflict");
        }
        this.audit(principal, "delivery_claimed", row.task_id, row.delivery_id, { epoch: row.epoch_text });
        leases.push({
          deliveryId: row.delivery_id,
          resourceKind: row.resource_kind,
          resourceId: row.resource_id,
          taskId: row.task_id,
          leaseId,
          epoch: row.epoch_text,
          expiresAt: new Date(expires).toISOString(),
        });
      }
      return leases;
    });
  }

  renew(principal: NodeConsumerPrincipal, input: { deliveryId: string; leaseId: string; epoch: string }): RenewResult {
    this.ensureAtomic();
    return this.transaction(principal, () => {
      if (!canonicalEpoch(input.epoch)) throw new QueueServiceError("lease_invalid_or_not_owned");
      const now = this.nowMs();
      const proposed = now + LEASE_TTL_MS;
      const changed = this.db.run(
        `UPDATE h1_queue_deliveries
            SET lease_expires_at_ms=CASE WHEN lease_expires_at_ms > ?1 THEN lease_expires_at_ms ELSE ?1 END,
                updated_at_ms=?2
          WHERE delivery_id=?3 AND network_id=?4 AND consumer_node_id=?5
            AND lease_owner_token_id=?6 AND lease_hash=?7
            AND CAST(epoch AS TEXT)=?8 AND state IN ('leased','running')
            AND lease_expires_at_ms > ?2
            AND ${EXACT_RESOURCE_TABLE}`,
        [proposed, now, input.deliveryId, principal.networkId, principal.nodeId,
          principal.tokenId, sha256(input.leaseId), input.epoch],
      ).changes;
      if (changed !== 1) throw new QueueServiceError("lease_invalid_or_not_owned");
      const row = this.db.get<{ expires: number; epoch_text: string }>(
        "SELECT lease_expires_at_ms AS expires, CAST(epoch AS TEXT) AS epoch_text FROM h1_queue_deliveries WHERE delivery_id=?1",
        input.deliveryId,
      );
      if (!row) throw new QueueServiceError("lease_invalid_or_not_owned");
      this.audit(principal, "lease_renewed", null, input.deliveryId, { epoch: row.epoch_text });
      return { deliveryId: input.deliveryId, epoch: row.epoch_text, expiresAt: new Date(row.expires).toISOString() };
    });
  }

  private deliveryById(deliveryId: string): DeliveryRow | null {
    return this.db.get<DeliveryRow>(
      `SELECT delivery_id, resource_kind, resource_id, task_id, network_id,
              consumer_node_id, producer_node_id, requires_response, state,
              CAST(epoch AS TEXT) AS epoch_text,
              CAST(assignment_generation AS TEXT) AS assignment_generation_text,
              lease_expires_at_ms
         FROM h1_queue_deliveries WHERE delivery_id=?1`,
      deliveryId,
    );
  }

  private activeLease(principal: NodeConsumerPrincipal, input: { deliveryId: string; leaseId: string; epoch: string }, allowed: readonly DeliveryState[]): DeliveryRow {
    if (!canonicalEpoch(input.epoch)) throw new QueueServiceError("lease_invalid_or_not_owned");
    const states = allowed.map((state) => `'${state}'`).join(",");
    const row = this.db.get<DeliveryRow>(
      `SELECT delivery_id, resource_kind, resource_id, task_id, network_id,
              consumer_node_id, producer_node_id, requires_response, state,
              CAST(epoch AS TEXT) AS epoch_text,
              CAST(assignment_generation AS TEXT) AS assignment_generation_text,
              lease_expires_at_ms
         FROM h1_queue_deliveries
        WHERE delivery_id=?1 AND network_id=?2 AND consumer_node_id=?3
          AND lease_owner_token_id=?4 AND lease_hash=?5 AND CAST(epoch AS TEXT)=?6
          AND state IN (${states}) AND lease_expires_at_ms > ?7
          AND ${EXACT_RESOURCE_TABLE}`,
      input.deliveryId, principal.networkId, principal.nodeId, principal.tokenId,
      sha256(input.leaseId), input.epoch, this.nowMs(),
    );
    if (!row) throw new QueueServiceError("lease_invalid_or_not_owned");
    return row;
  }

  acknowledge(principal: NodeConsumerPrincipal, input: { deliveryId: string; leaseId: string; epoch: string; operationId: string }): DeliveryMutationResult {
    this.ensureAtomic();
    const digest = this.requestDigest({ deliveryId: input.deliveryId, leaseHash: sha256(input.leaseId), epoch: input.epoch });
    return this.transaction(principal, () => {
      const replay = this.replay<DeliveryMutationResult>(principal, input.operationId, "acknowledge", digest);
      if (replay) return replay;
      const row = this.activeLease(principal, input, ["leased"]);
      const now = this.nowMs();
      const next: DeliveryState = row.resource_kind === "task" ? "running" : "consumed";
      const changed = this.db.run(
        `UPDATE h1_queue_deliveries
            SET state=?1,
                lease_hash=CASE WHEN ?1='consumed' THEN NULL ELSE lease_hash END,
                lease_owner_token_id=CASE WHEN ?1='consumed' THEN NULL ELSE lease_owner_token_id END,
                lease_expires_at_ms=CASE WHEN ?1='consumed' THEN NULL ELSE lease_expires_at_ms END,
                terminal_at_ms=CASE WHEN ?1='consumed' THEN ?2 ELSE NULL END,
                updated_at_ms=?2
          WHERE delivery_id=?3 AND state='leased' AND CAST(epoch AS TEXT)=?4`,
        [next, now, row.delivery_id, row.epoch_text],
      ).changes;
      if (changed !== 1) throw new QueueServiceError("lease_invalid_or_not_owned");
      this.fault("after_delivery");
      if (this.db.run(
        "UPDATE inbox SET acked=1 WHERE id=?1 AND node_id=?2 AND network_id=?3 AND acked=0",
        [row.resource_id, principal.nodeId, principal.networkId],
      ).changes !== 1) throw new QueueServiceError("queue_transition_conflict");
      if (row.task_id) {
        const taskChanged = this.db.run(
          `UPDATE tasks SET status='acked', started_at=?1
            WHERE task_id=?2 AND network_id=?3 AND to_node_id=?4 AND status='delivered'`,
          [new Date(now).toISOString(), row.task_id, principal.networkId, principal.nodeId],
        ).changes;
        if (taskChanged !== 1) throw new QueueServiceError("queue_transition_conflict");
        this.fault("after_task");
        this.db.run(
          "INSERT INTO task_events(task_id, from_status, to_status, actor, detail, network_id) VALUES (?1, 'delivered', 'acked', ?2, 'h1 lease ack', ?3)",
          [row.task_id, principal.nodeId, principal.networkId],
        );
        this.fault("after_event");
      }
      this.audit(principal, next === "consumed" ? "delivery_consumed" : "task_acknowledged", row.task_id, row.delivery_id);
      this.fault("after_audit");
      const result: DeliveryMutationResult = { deliveryId: row.delivery_id, taskId: row.task_id, state: next };
      this.storeReplay(principal, input.operationId, "acknowledge", digest, result, row.task_id, row.delivery_id);
      this.fault("after_idempotency");
      return result;
    });
  }

  reply(principal: NodeConsumerPrincipal, input: { deliveryId: string; leaseId: string; epoch: string; operationId: string; result: string }): DeliveryMutationResult {
    this.ensureAtomic();
    const digest = this.requestDigest({ deliveryId: input.deliveryId, leaseHash: sha256(input.leaseId), epoch: input.epoch, result: input.result });
    return this.transaction(principal, () => {
      const replay = this.replay<DeliveryMutationResult>(principal, input.operationId, "reply", digest);
      if (replay) return replay;
      const row = this.activeLease(principal, input, ["leased", "running"]);
      if (!row.task_id || row.resource_kind !== "task") throw new QueueServiceError("lease_invalid_or_not_owned");
      const now = this.nowMs();
      const fromStatus = row.state === "leased" ? "delivered" : "acked";
      const deliveryChanged = this.db.run(
        `UPDATE h1_queue_deliveries
            SET state='replied', lease_hash=NULL, lease_owner_token_id=NULL,
                lease_expires_at_ms=NULL, terminal_at_ms=?1, updated_at_ms=?1
          WHERE delivery_id=?2 AND state=?3 AND CAST(epoch AS TEXT)=?4`,
        [now, row.delivery_id, row.state, row.epoch_text],
      ).changes;
      if (deliveryChanged !== 1) throw new QueueServiceError("lease_invalid_or_not_owned");
      this.fault("after_delivery");
      if (row.state === "leased" && this.db.run(
        `UPDATE inbox SET acked=1
          WHERE id=?1 AND network_id=?2 AND node_id=?3
            AND type='task' AND requires_response='reply' AND acked=0`,
        [row.resource_id, principal.networkId, principal.nodeId],
      ).changes !== 1) throw new QueueServiceError("queue_transition_conflict");
      const taskChanged = this.db.run(
        `UPDATE tasks SET status='replied', result=?1, completed_at=?2
          WHERE task_id=?3 AND network_id=?4 AND to_node_id=?5 AND status=?6`,
        [input.result, new Date(now).toISOString(), row.task_id, principal.networkId, principal.nodeId, fromStatus],
      ).changes;
      if (taskChanged !== 1) throw new QueueServiceError("queue_transition_conflict");
      this.fault("after_task");

      const edge = this.db.get<{
        edge_id: string; parent_task_id: string; parent_delivery_id: string;
        parent_epoch_text: string; delegator_node_id: string;
      }>(
        `SELECT edge_id, parent_task_id, parent_delivery_id,
                CAST(parent_epoch AS TEXT) AS parent_epoch_text, delegator_node_id
           FROM h1_delegation_edges WHERE child_task_id=?1 AND network_id=?2`,
        row.task_id, principal.networkId,
      );
      if (edge) this.createAttachmentOrSuppress(principal, row, edge, input.result, now);
      else if (row.producer_node_id) this.createOrdinaryReply(principal, row, row.producer_node_id, input.result);
      this.fault("after_reply_resource");

      this.db.run(
        "INSERT INTO task_events(task_id, from_status, to_status, actor, detail, network_id) VALUES (?1, ?2, 'replied', ?3, 'h1 terminal reply', ?4)",
        [row.task_id, fromStatus, principal.nodeId, principal.networkId],
      );
      this.fault("after_event");
      this.audit(principal, "task_replied", row.task_id, row.delivery_id);
      this.fault("after_audit");
      const result: DeliveryMutationResult = { deliveryId: row.delivery_id, taskId: row.task_id, state: "replied" };
      this.storeReplay(principal, input.operationId, "reply", digest, result, row.task_id, row.delivery_id);
      this.fault("after_idempotency");
      this.fault("after_doorbell");
      return result;
    });
  }

  private createOrdinaryReply(principal: NodeConsumerPrincipal, source: DeliveryRow, targetNodeId: string, content: string): EnqueueResult | null {
    let target: TargetNode;
    try { target = this.targetNode(principal.networkId, targetNodeId); }
    catch (error) {
      if (error instanceof QueueServiceError && error.code === "target_node_unavailable") return null;
      throw error;
    }
    const result = this.enqueueNoResponseRows(principal, target, "reply", content, principal.nodeId);
    this.insertDoorbell(result.deliveryId, target.node_id, "0", "pending");
    return result;
  }

  private createAttachmentOrSuppress(
    principal: NodeConsumerPrincipal,
    child: DeliveryRow,
    edge: { edge_id: string; parent_task_id: string; parent_delivery_id: string; parent_epoch_text: string; delegator_node_id: string },
    content: string,
    now: number,
  ): void {
    const parent = this.db.get<{ delivery_id: string }>(
      `SELECT d.delivery_id
         FROM h1_queue_deliveries d
         JOIN tasks t ON t.task_id=?1 AND t.task_id=d.task_id AND t.network_id=d.network_id
        WHERE d.delivery_id=?2 AND d.network_id=?3
          AND d.consumer_node_id=?4 AND CAST(d.epoch AS TEXT)=?5
          AND d.state='running' AND d.lease_expires_at_ms > ?6
          AND t.status='acked' AND ${EXACT_RESOURCE_D}`,
      edge.parent_task_id, edge.parent_delivery_id, principal.networkId,
      edge.delegator_node_id, edge.parent_epoch_text, now,
    );
    if (!parent) {
      this.audit(principal, "attachment_suppressed_stale_parent", child.task_id, child.delivery_id, { edgeId: edge.edge_id });
      return;
    }
    const target = this.targetNode(principal.networkId, edge.delegator_node_id);
    const attachmentId = this.randomId("qattach");
    const result = this.enqueueNoResponseRows(principal, target, "reply", content, principal.nodeId);
    this.db.run(
      `INSERT INTO h1_reply_attachments
         (attachment_id, network_id, edge_id, child_task_id, child_terminal_delivery_id,
          parent_delivery_id, parent_epoch, delegator_node_id, attachment_delivery_id, created_at_ms)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, CAST(?7 AS INTEGER), ?8, ?9, ?10)`,
      [attachmentId, principal.networkId, edge.edge_id, child.task_id, child.delivery_id,
        edge.parent_delivery_id, edge.parent_epoch_text, edge.delegator_node_id, result.deliveryId, now],
    );
    this.insertDoorbell(result.deliveryId, target.node_id, "0", "pending");
  }

  deadLetter(principal: NodeConsumerPrincipal, input: { deliveryId: string; leaseId: string; epoch: string; operationId: string; reasonCode: string }): DeliveryMutationResult {
    this.ensureAtomic();
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(input.reasonCode)) {
      throw new QueueServiceError("invalid_queue_request", 400);
    }
    const digest = this.requestDigest({ deliveryId: input.deliveryId, leaseHash: sha256(input.leaseId), epoch: input.epoch, reasonCode: input.reasonCode });
    return this.transaction(principal, () => {
      const replay = this.replay<DeliveryMutationResult>(principal, input.operationId, "dead_letter", digest);
      if (replay) return replay;
      const row = this.activeLease(principal, input, ["leased", "running"]);
      const now = this.nowMs();
      const changed = this.db.run(
        `UPDATE h1_queue_deliveries SET state='dead_lettered', epoch=epoch+1,
          lease_hash=NULL, lease_owner_token_id=NULL, lease_expires_at_ms=NULL,
          terminal_at_ms=?1, updated_at_ms=?1
          WHERE delivery_id=?2 AND state IN ('leased','running') AND CAST(epoch AS TEXT)=?3
            AND epoch < 9223372036854775807`,
        [now, row.delivery_id, row.epoch_text],
      ).changes;
      if (changed !== 1) throw new QueueServiceError("lease_invalid_or_not_owned");
      if (row.task_id) {
        const task = this.db.run(
          `UPDATE tasks SET status='failed', result=?1, completed_at=?2
            WHERE task_id=?3 AND network_id=?4 AND status IN ('delivered','acked')`,
          [input.reasonCode, new Date(now).toISOString(), row.task_id, principal.networkId],
        ).changes;
        if (task !== 1) throw new QueueServiceError("queue_transition_conflict");
        this.db.run(
          "INSERT INTO task_events(task_id, from_status, to_status, actor, detail, network_id) VALUES (?1, ?2, 'failed', ?3, ?4, ?5)",
          [row.task_id, row.state === "running" ? "acked" : "delivered", principal.nodeId, input.reasonCode, principal.networkId],
        );
      }
      this.db.run("UPDATE inbox SET acked=1 WHERE id=?1 AND network_id=?2", [row.resource_id, principal.networkId]);
      this.audit(principal, "delivery_dead_lettered", row.task_id, row.delivery_id);
      const result: DeliveryMutationResult = { deliveryId: row.delivery_id, taskId: row.task_id, state: "dead_lettered" };
      this.storeReplay(principal, input.operationId, "dead_letter", digest, result, row.task_id, row.delivery_id);
      return result;
    });
  }

  cancel(principal: QueuePrincipal, input: { taskId: string; operationId: string }): DeliveryMutationResult {
    this.ensureAtomic();
    const digest = this.requestDigest({ taskId: input.taskId });
    return this.transaction(principal, () => {
      const replay = this.replay<DeliveryMutationResult>(principal, input.operationId, "cancel", digest);
      if (replay) return replay;
      const row = this.db.get<DeliveryRow>(
        `SELECT d.delivery_id, d.resource_kind, d.resource_id, d.task_id, d.network_id,
                d.consumer_node_id, d.producer_node_id, d.requires_response, d.state,
                CAST(d.epoch AS TEXT) AS epoch_text,
                CAST(d.assignment_generation AS TEXT) AS assignment_generation_text,
                d.lease_expires_at_ms
           FROM h1_queue_deliveries d
           JOIN tasks t ON t.task_id=d.task_id AND t.network_id=d.network_id
           JOIN h1_task_assignments a
             ON a.task_id=d.task_id AND a.network_id=d.network_id
            AND a.delivery_id=d.delivery_id AND a.consumer_node_id=d.consumer_node_id
            AND a.producer_node_id IS d.producer_node_id
          WHERE d.task_id=?1 AND d.network_id=?2 AND d.state IN ('pending','leased','running')
            AND ${EXACT_RESOURCE_D}`,
        input.taskId, principal.networkId,
      );
      if (!row || (principal.kind === "node_consumer" && row.producer_node_id !== principal.nodeId)) {
        throw new QueueServiceError("queue_transition_conflict");
      }
      const now = this.nowMs();
      if (this.db.run(
        `UPDATE h1_queue_deliveries SET state='cancelled', epoch=epoch+1,
          lease_hash=NULL, lease_owner_token_id=NULL, lease_expires_at_ms=NULL,
          terminal_at_ms=?1, updated_at_ms=?1
          WHERE delivery_id=?2 AND state IN ('pending','leased','running')
            AND epoch < 9223372036854775807`,
        [now, row.delivery_id],
      ).changes !== 1) throw new QueueServiceError("queue_transition_conflict");
      if (this.db.run("UPDATE inbox SET acked=1 WHERE id=?1", [row.resource_id]).changes !== 1) {
        throw new QueueServiceError("queue_transition_conflict");
      }
      if (this.db.run(
        `UPDATE tasks SET status='cancelled', completed_at=?1
          WHERE task_id=?2 AND network_id=?3 AND status IN ('delivered','acked','running')`,
        [new Date(now).toISOString(), input.taskId, principal.networkId],
      ).changes !== 1) throw new QueueServiceError("queue_transition_conflict");
      if (this.db.run(
        `UPDATE h1_task_assignments SET assignment_epoch=assignment_epoch+1, updated_at_ms=?1
          WHERE task_id=?2 AND network_id=?3 AND assignment_epoch < 9223372036854775807`,
        [now, input.taskId, principal.networkId],
      ).changes !== 1) throw new QueueServiceError("queue_transition_conflict");
      const cancelledGeneration = this.db.get<{ epoch_text: string }>(
        "SELECT CAST(assignment_epoch AS TEXT) AS epoch_text FROM h1_task_assignments WHERE task_id=?1",
        input.taskId,
      );
      if (!cancelledGeneration) throw new QueueServiceError("queue_transition_conflict");
      this.db.run(
        "UPDATE h1_queue_deliveries SET assignment_generation=CAST(?1 AS INTEGER) WHERE delivery_id=?2",
        [cancelledGeneration.epoch_text, row.delivery_id],
      );
      this.db.run(
        "INSERT INTO task_events(task_id, from_status, to_status, actor, detail, network_id) VALUES (?1, ?2, 'cancelled', ?3, 'h1 cancel', ?4)",
        [input.taskId, row.state === "running" ? "acked" : "delivered", this.principalId(principal), principal.networkId],
      );
      this.audit(principal, "task_cancelled", input.taskId, row.delivery_id);
      const result: DeliveryMutationResult = { deliveryId: row.delivery_id, taskId: input.taskId, state: "cancelled" };
      this.storeReplay(principal, input.operationId, "cancel", digest, result, input.taskId, row.delivery_id);
      return result;
    });
  }

  reassign(principal: QueueControlPrincipal, input: { taskId: string; targetNodeId: string; operationId: string }): EnqueueResult {
    this.ensureAtomic();
    const digest = this.requestDigest({ taskId: input.taskId, targetNodeId: input.targetNodeId });
    return this.transaction(principal, () => {
      const replay = this.replay<EnqueueResult>(principal, input.operationId, "reassign", digest);
      if (replay) return replay;
      const target = this.targetNode(principal.networkId, input.targetNodeId);
      const old = this.db.get<DeliveryRow>(
        `SELECT d.delivery_id, d.resource_kind, d.resource_id, d.task_id, d.network_id,
                d.consumer_node_id, d.producer_node_id, d.requires_response, d.state,
                CAST(d.epoch AS TEXT) AS epoch_text,
                CAST(d.assignment_generation AS TEXT) AS assignment_generation_text,
                d.lease_expires_at_ms
           FROM h1_queue_deliveries d
           JOIN h1_task_assignments a
             ON a.task_id=d.task_id AND a.network_id=d.network_id
            AND a.delivery_id=d.delivery_id AND a.consumer_node_id=d.consumer_node_id
            AND a.producer_node_id IS d.producer_node_id
          WHERE d.task_id=?1 AND d.network_id=?2 AND d.state IN ('pending','leased','running')
            AND ${EXACT_RESOURCE_D}`,
        input.taskId, principal.networkId,
      );
      if (!old) throw new QueueServiceError("queue_transition_conflict");
      const now = this.nowMs();
      if (this.db.run(
        `UPDATE h1_queue_deliveries SET state='superseded', epoch=epoch+1,
          lease_hash=NULL, lease_owner_token_id=NULL, lease_expires_at_ms=NULL,
          terminal_at_ms=?1, updated_at_ms=?1
          WHERE delivery_id=?2 AND epoch < 9223372036854775807`,
        [now, old.delivery_id],
      ).changes !== 1) throw new QueueServiceError("queue_transition_conflict");
      if (this.db.run("UPDATE inbox SET acked=1 WHERE id=?1", [old.resource_id]).changes !== 1) {
        throw new QueueServiceError("queue_transition_conflict");
      }
      const resourceId = this.randomId("qres");
      const task = this.db.get<{ content: string; priority: string; from_name: string }>(
        "SELECT content, priority, from_name FROM tasks WHERE task_id=?1 AND network_id=?2",
        input.taskId, principal.networkId,
      );
      if (!task) throw new QueueServiceError("queue_transition_conflict");
      this.db.run(
        `INSERT INTO inbox(id, session_name, node_id, type, priority, content, from_session, acked, requires_response, network_id, created_at)
         VALUES (?1, ?2, ?3, 'task', ?4, ?5, ?6, 0, 'reply', ?7, ?8)`,
        [resourceId, target.alias_snapshot, target.node_id, task.priority, task.content, task.from_name,
          principal.networkId, new Date(now).toISOString()],
      );
      const deliveryId = this.insertDelivery({ principal, target, kind: "task", resourceId, taskId: input.taskId, producerNodeId: old.producer_node_id });
      if (this.db.run(
        `UPDATE tasks SET to_node_id=?1, to_name=?2, status='delivered', delivered_at=?3
          WHERE task_id=?4 AND network_id=?5 AND status IN ('delivered','acked','running')`,
        [target.node_id, target.alias_snapshot, new Date(now).toISOString(), input.taskId, principal.networkId],
      ).changes !== 1) throw new QueueServiceError("queue_transition_conflict");
      if (this.db.run(
        `UPDATE h1_task_assignments SET consumer_node_id=?1, delivery_id=?2,
          assignment_epoch=assignment_epoch+1, updated_at_ms=?3
          WHERE task_id=?4 AND assignment_epoch < 9223372036854775807`,
        [target.node_id, deliveryId, now, input.taskId],
      ).changes !== 1) throw new QueueServiceError("queue_transition_conflict");
      const generation = this.db.get<{ epoch_text: string }>(
        "SELECT CAST(assignment_epoch AS TEXT) AS epoch_text FROM h1_task_assignments WHERE task_id=?1",
        input.taskId,
      );
      if (!generation) throw new QueueServiceError("queue_transition_conflict");
      this.db.run(
        "UPDATE h1_queue_deliveries SET assignment_generation=CAST(?1 AS INTEGER) WHERE delivery_id=?2",
        [generation.epoch_text, deliveryId],
      );
      const result: EnqueueResult = { resourceId, deliveryId, taskId: input.taskId };
      this.db.run(
        "INSERT INTO task_events(task_id, from_status, to_status, actor, detail, network_id) VALUES (?1, ?2, 'delivered', ?3, 'h1 reassign', ?4)",
        [input.taskId, old.state === "running" ? "acked" : "delivered", this.principalId(principal), principal.networkId],
      );
      this.audit(principal, "task_reassigned", input.taskId, deliveryId);
      this.storeReplay(principal, input.operationId, "reassign", digest, result, input.taskId, deliveryId);
      this.insertDoorbell(deliveryId, target.node_id, "0", "pending");
      return result;
    });
  }

  retry(principal: QueueControlPrincipal, input: { taskId: string; operationId: string; targetNodeId?: string }): EnqueueResult {
    this.ensureAtomic();
    const digest = this.requestDigest({ taskId: input.taskId, targetNodeId: input.targetNodeId ?? null });
    return this.transaction(principal, () => {
      const replay = this.replay<EnqueueResult>(principal, input.operationId, "retry", digest);
      if (replay) return replay;
      const old = this.db.get<{
        content: string; priority: string; to_node_id: string; status: string;
        producer_node_id: string | null; from_name: string;
      }>(
        `SELECT t.content, t.priority, t.to_node_id, t.status,
                a.producer_node_id, t.from_name
           FROM tasks t
           JOIN h1_task_assignments a
             ON a.task_id=t.task_id AND a.network_id=t.network_id
           JOIN h1_queue_deliveries d
             ON d.delivery_id=a.delivery_id AND d.task_id=t.task_id
            AND d.network_id=t.network_id AND d.consumer_node_id=a.consumer_node_id
            AND d.producer_node_id IS a.producer_node_id
          WHERE t.task_id=?1 AND t.network_id=?2
            AND ((t.status='failed' AND d.state='dead_lettered')
              OR (t.status='cancelled' AND d.state='cancelled')
              OR (t.status='expired' AND d.state='dead_lettered'))
            AND d.terminal_at_ms IS NOT NULL`,
        input.taskId, principal.networkId,
      );
      if (!old) throw new QueueServiceError("queue_transition_conflict");
      const target = this.targetNode(principal.networkId, input.targetNodeId ?? old.to_node_id);
      // Retry creates a new logical task. The original terminal task/result is immutable.
      const result = this.enqueueTaskRows(
        principal,
        target,
        old.content,
        old.priority,
        null,
        { nodeId: old.producer_node_id, alias: old.from_name },
      );
      this.audit(principal, "task_retried", result.taskId, result.deliveryId, { sourceTaskId: input.taskId });
      this.storeReplay(principal, input.operationId, "retry", digest, result, result.taskId, result.deliveryId);
      this.insertDoorbell(result.deliveryId, target.node_id, "0", "pending");
      return result;
    });
  }

  delegateTask(principal: NodeConsumerPrincipal, input: { parentDeliveryId: string; parentLeaseId: string; parentEpoch: string; operationId: string; targetNodeId: string; content: string }): DelegationResult {
    this.ensureAtomic();
    const digest = this.requestDigest({ parentDeliveryId: input.parentDeliveryId, parentLeaseHash: sha256(input.parentLeaseId), parentEpoch: input.parentEpoch, targetNodeId: input.targetNodeId, content: input.content });
    return this.transaction(principal, () => {
      const replay = this.replay<DelegationResult>(principal, input.operationId, "delegate_task", digest);
      if (replay) return replay;
      const parent = this.activeLease(principal, {
        deliveryId: input.parentDeliveryId, leaseId: input.parentLeaseId, epoch: input.parentEpoch,
      }, ["running"]);
      if (!parent.task_id || input.targetNodeId === principal.nodeId) throw new QueueServiceError("lineage_invalid");
      const target = this.targetNode(principal.networkId, input.targetNodeId);
      const ancestor = this.db.get<{ depth: number }>(
        "SELECT depth FROM h1_delegation_edges WHERE child_task_id=?1 AND network_id=?2",
        parent.task_id, principal.networkId,
      );
      const depth = (ancestor?.depth ?? 0) + 1;
      if (depth > 8) throw new QueueServiceError("lineage_invalid");
      const child = this.enqueueTaskRows(principal, target, input.content, "normal", null);
      const edgeId = this.randomId("qedge");
      this.db.run(
        `INSERT INTO h1_delegation_edges
          (edge_id, network_id, parent_task_id, parent_delivery_id, parent_epoch,
           delegator_node_id, child_task_id, child_consumer_node_id, depth, created_at_ms)
         VALUES (?1, ?2, ?3, ?4, CAST(?5 AS INTEGER), ?6, ?7, ?8, ?9, ?10)`,
        [edgeId, principal.networkId, parent.task_id, parent.delivery_id, parent.epoch_text,
          principal.nodeId, child.taskId, target.node_id, depth, this.nowMs()],
      );
      const result: DelegationResult = { edgeId, taskId: child.taskId!, deliveryId: child.deliveryId };
      this.audit(principal, "task_delegated", child.taskId, child.deliveryId, { edgeId });
      this.storeReplay(principal, input.operationId, "delegate_task", digest, result, child.taskId, child.deliveryId);
      this.insertDoorbell(child.deliveryId, target.node_id, "0", "pending");
      return result;
    });
  }

  /** Internal dispatcher seam: stale generation/state rows are suppressed transactionally. */
  listReadyDoorbells(limit = 100): ReadyDoorbell[] {
    this.ensureAtomic();
    return this.db.immediateTransaction(() => {
      const rows = this.db.all<{
        outbox_id: string; consumer_node_id: string; expected_delivery_id: string;
        expected_epoch_text: string; expected_state: DeliveryState; pending_count: number | null;
      }>(
        `SELECT outbox_id, consumer_node_id, expected_delivery_id,
                CAST(expected_epoch AS TEXT) AS expected_epoch_text,
                expected_state, pending_count
           FROM h1_queue_doorbell_outbox WHERE status='pending'
          ORDER BY created_at_ms, outbox_id LIMIT ?1`,
        limit,
      );
      const ready: ReadyDoorbell[] = [];
      for (const row of rows) {
        const valid = this.db.get<{ ok: number }>(
          `SELECT 1 AS ok FROM h1_queue_deliveries
            WHERE delivery_id=?1 AND consumer_node_id=?2
              AND CAST(epoch AS TEXT)=?3 AND state=?4
              AND ${EXACT_RESOURCE_TABLE}`,
          row.expected_delivery_id, row.consumer_node_id, row.expected_epoch_text, row.expected_state,
        );
        if (!valid) {
          this.db.run("UPDATE h1_queue_doorbell_outbox SET status='suppressed' WHERE outbox_id=?1 AND status='pending'", [row.outbox_id]);
          continue;
        }
        ready.push({
          outboxId: row.outbox_id,
          consumerNodeId: row.consumer_node_id,
          payload: row.pending_count === null ? { type: "queue_changed" } : { type: "queue_changed", count: row.pending_count },
        });
      }
      return ready;
    });
  }

  markDoorbellDispatched(outboxId: string): void {
    this.ensureAtomic();
    this.db.immediateTransaction(() => {
      this.db.run(
        "UPDATE h1_queue_doorbell_outbox SET status='dispatched', dispatched_at_ms=?1 WHERE outbox_id=?2 AND status='pending'",
        [this.nowMs(), outboxId],
      );
    });
  }
}

export const H1_QUEUE_TERMINAL_STATES = TERMINAL_STATES;
