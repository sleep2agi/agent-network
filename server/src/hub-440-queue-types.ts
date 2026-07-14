export type DeliveryResourceKind = "task" | "message" | "broadcast" | "reply";

export type DeliveryState =
  | "pending"
  | "leased"
  | "running"
  | "consumed"
  | "replied"
  | "dead_lettered"
  | "cancelled"
  | "superseded";

export type NodeConsumerPrincipal = Readonly<{
  kind: "node_consumer";
  userId: string;
  networkId: string;
  nodeId: string;
  tokenId: string;
  aliasSnapshot: string;
}>;

export type QueueControlPrincipal = Readonly<{
  kind: "queue_control";
  userId: string;
  networkId: string;
  role: "owner" | "admin";
  tokenId: string;
}>;

export type QueuePrincipal = NodeConsumerPrincipal | QueueControlPrincipal;

export type ConsumerLease = Readonly<{
  deliveryId: string;
  resourceKind: DeliveryResourceKind;
  resourceId: string;
  taskId: string | null;
  leaseId: string;
  epoch: string;
  expiresAt: string;
}>;

export type EnqueueResult = Readonly<{
  resourceId: string;
  deliveryId: string;
  taskId: string | null;
}>;

export type DeliveryMutationResult = Readonly<{
  deliveryId: string;
  taskId: string | null;
  state: DeliveryState;
}>;

export type RenewResult = Readonly<{
  deliveryId: string;
  epoch: string;
  expiresAt: string;
}>;

export type DelegationResult = Readonly<{
  edgeId: string;
  taskId: string;
  deliveryId: string;
}>;

export type QueueFailureCode =
  | "atomic_queue_transactions_unavailable"
  | "consumer_principal_invalid"
  | "queue_control_principal_invalid"
  | "target_node_unavailable"
  | "lease_invalid_or_not_owned"
  | "consumer_inflight_limit"
  | "operation_conflict"
  | "queue_transition_conflict"
  | "invalid_queue_request"
  | "lineage_invalid";

export class QueueServiceError extends Error {
  readonly httpStatus: number;

  constructor(readonly code: QueueFailureCode, httpStatus = 409) {
    super(code);
    this.name = "QueueServiceError";
    this.httpStatus = httpStatus;
  }
}

export type QueueFaultStage =
  | "after_delivery"
  | "after_task"
  | "after_reply_resource"
  | "after_event"
  | "after_audit"
  | "after_idempotency"
  | "after_doorbell"
  | "retention_after_first_delete";

export type QueueServiceOptions = Readonly<{
  nowMs?: () => number;
  randomId?: (prefix: string) => string;
  leaseSecret?: () => string;
  faultAt?: (stage: QueueFaultStage) => void;
}>;
