import {
  AtomicQueueTransactionsUnavailableError,
  type DbAdapter,
} from "./db-adapter.js";
import {
  QueueServiceError,
  type NodeConsumerPrincipal,
  type QueueControlPrincipal,
} from "./hub-440-queue-types.js";

export type VerifiedNodeRegistration = Readonly<{
  kind: "verified_node_registration";
  tokenId: string;
  userId: string;
  networkId: string;
  nodeId: string;
}>;

type NodePrincipalRow = {
  token_id: string;
  user_id: string;
  network_id: string;
  node_id: string;
  alias_snapshot: string;
};

function ensureQueueTransaction(db: DbAdapter): void {
  if (db.atomicQueueTransactions !== "same_connection_immediate") {
    throw new AtomicQueueTransactionsUnavailableError();
  }
}

function nodePrincipalRow(db: DbAdapter, tokenId: string): NodePrincipalRow | null {
  return db.get<NodePrincipalRow>(
    `SELECT t.token_id, t.user_id, t.network_id, b.node_id,
            COALESCE(n.alias, n.node_name) AS alias_snapshot
       FROM api_tokens t
       JOIN h1_node_token_bindings b
         ON b.token_id = t.token_id
        AND b.user_id = t.user_id
        AND b.network_id = t.network_id
       JOIN network_members m
         ON m.network_id = t.network_id
        AND m.user_id = t.user_id
       JOIN nodes n
         ON n.node_id = b.node_id
        AND n.network_id = b.network_id
      WHERE t.token_id = ?1
        AND t.scope = 'network'
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
        AND COALESCE(n.lifecycle_state, 'active') = 'active'
      LIMIT 1`,
    tokenId,
  );
}

function toNodePrincipal(row: NodePrincipalRow): NodeConsumerPrincipal {
  return Object.freeze({
    kind: "node_consumer" as const,
    userId: row.user_id,
    networkId: row.network_id,
    nodeId: row.node_id,
    tokenId: row.token_id,
    aliasSnapshot: row.alias_snapshot,
  });
}

export function bindNodeConsumerToken(db: DbAdapter, registration: VerifiedNodeRegistration): NodeConsumerPrincipal {
  ensureQueueTransaction(db);
  return db.immediateTransaction(() => {
    const eligible = db.get<{ alias_snapshot: string }>(
      `SELECT COALESCE(n.alias, n.node_name) AS alias_snapshot
         FROM api_tokens t
         JOIN network_members m
           ON m.network_id = t.network_id AND m.user_id = t.user_id
         JOIN nodes n
           ON n.node_id = ?4 AND n.network_id = t.network_id
        WHERE t.token_id = ?1
          AND t.user_id = ?2
          AND t.network_id = ?3
          AND t.scope = 'network'
          AND t.revoked_at IS NULL
          AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
          AND COALESCE(n.lifecycle_state, 'active') = 'active'
        LIMIT 1`,
      registration.tokenId,
      registration.userId,
      registration.networkId,
      registration.nodeId,
    );
    if (!eligible) throw new QueueServiceError("consumer_principal_invalid", 401);

    const existing = db.get<{ user_id: string; network_id: string; node_id: string }>(
      "SELECT user_id, network_id, node_id FROM h1_node_token_bindings WHERE token_id = ?1",
      registration.tokenId,
    );
    if (existing) {
      if (
        existing.user_id !== registration.userId ||
        existing.network_id !== registration.networkId ||
        existing.node_id !== registration.nodeId
      ) {
        throw new QueueServiceError("consumer_principal_invalid", 401);
      }
    } else {
      db.run(
        `INSERT INTO h1_node_token_bindings
           (token_id, user_id, network_id, node_id, binding_generation, provenance, bound_at_ms)
         VALUES (?1, ?2, ?3, ?4, 1, 'server_registration', ?5)`,
        [registration.tokenId, registration.userId, registration.networkId, registration.nodeId, Date.now()],
      );
    }

    const row = nodePrincipalRow(db, registration.tokenId);
    if (!row) throw new QueueServiceError("consumer_principal_invalid", 401);
    return toNodePrincipal(row);
  });
}

export function resolveNodeConsumerPrincipal(db: DbAdapter, tokenId: string): NodeConsumerPrincipal {
  const row = nodePrincipalRow(db, tokenId);
  if (!row) throw new QueueServiceError("consumer_principal_invalid", 401);
  return toNodePrincipal(row);
}

export function resolveQueueControlPrincipal(
  db: DbAdapter,
  tokenId: string,
  networkId: string,
): QueueControlPrincipal {
  const row = db.get<{ token_id: string; user_id: string; role: "owner" | "admin" }>(
    `SELECT t.token_id, t.user_id, m.role
       FROM api_tokens t
       JOIN network_members m ON m.user_id = t.user_id AND m.network_id = ?2
      WHERE t.token_id = ?1
        AND t.scope = 'user'
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > datetime('now'))
        AND m.role IN ('owner', 'admin')
        AND (t.network_id IS NULL OR t.network_id = ?2)
      LIMIT 1`,
    tokenId,
    networkId,
  );
  if (!row) throw new QueueServiceError("queue_control_principal_invalid", 403);
  return Object.freeze({
    kind: "queue_control" as const,
    userId: row.user_id,
    networkId,
    role: row.role,
    tokenId: row.token_id,
  });
}

/** Revalidation used as the first SQL inside every node mutation transaction. */
export function revalidateNodeConsumerPrincipal(db: DbAdapter, principal: NodeConsumerPrincipal): void {
  const row = nodePrincipalRow(db, principal.tokenId);
  if (
    !row ||
    row.user_id !== principal.userId ||
    row.network_id !== principal.networkId ||
    row.node_id !== principal.nodeId
  ) {
    throw new QueueServiceError("consumer_principal_invalid", 401);
  }
}

/** Revalidation used as the first SQL inside every control mutation transaction. */
export function revalidateQueueControlPrincipal(db: DbAdapter, principal: QueueControlPrincipal): void {
  const resolved = resolveQueueControlPrincipal(db, principal.tokenId, principal.networkId);
  if (resolved.userId !== principal.userId || resolved.role !== principal.role) {
    throw new QueueServiceError("queue_control_principal_invalid", 403);
  }
}
