import type { DbAdapter } from "./db-adapter.js";

/**
 * Additive H1 schema. This deliberately creates no rows from legacy aliases,
 * api-token names, or historical node_id columns: provenance is established
 * only by the explicit server registration binding transaction.
 */
export function installH1QueueSchema(db: DbAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS h1_node_token_bindings (
      token_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      network_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      binding_generation INTEGER NOT NULL CHECK (binding_generation >= 1),
      provenance TEXT NOT NULL CHECK (provenance = 'server_registration'),
      bound_at_ms INTEGER NOT NULL CHECK (bound_at_ms >= 0),
      UNIQUE(network_id, node_id, token_id)
    );

    CREATE TABLE IF NOT EXISTS h1_queue_deliveries (
      delivery_id TEXT PRIMARY KEY CHECK (length(delivery_id) > 0),
      resource_kind TEXT NOT NULL CHECK (resource_kind IN ('task','message','broadcast','reply')),
      resource_id TEXT NOT NULL CHECK (length(resource_id) > 0),
      task_id TEXT,
      network_id TEXT NOT NULL CHECK (length(network_id) > 0),
      consumer_node_id TEXT NOT NULL CHECK (length(consumer_node_id) > 0),
      producer_node_id TEXT,
      requires_response INTEGER NOT NULL CHECK (requires_response IN (0,1)),
      state TEXT NOT NULL CHECK (state IN ('pending','leased','running','consumed','replied','dead_lettered','cancelled','superseded')),
      epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0 AND epoch <= 9223372036854775807),
      lease_hash TEXT,
      lease_owner_token_id TEXT,
      lease_expires_at_ms INTEGER,
      assignment_generation INTEGER NOT NULL DEFAULT 0 CHECK (assignment_generation >= 0),
      attempt_number INTEGER NOT NULL DEFAULT 0 CHECK (attempt_number >= 0),
      terminal_at_ms INTEGER,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      CHECK ((resource_kind = 'task' AND task_id IS NOT NULL AND requires_response = 1)
          OR (resource_kind != 'task' AND task_id IS NULL AND requires_response = 0)),
      CHECK ((lease_hash IS NULL AND lease_owner_token_id IS NULL AND lease_expires_at_ms IS NULL)
          OR (length(lease_hash) = 64 AND lease_owner_token_id IS NOT NULL AND lease_expires_at_ms IS NOT NULL)),
      CHECK ((state IN ('leased','running') AND lease_hash IS NOT NULL)
          OR (state NOT IN ('leased','running') AND lease_hash IS NULL)),
      UNIQUE(network_id, resource_kind, resource_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS h1_one_active_task_delivery
      ON h1_queue_deliveries(network_id, task_id)
      WHERE task_id IS NOT NULL AND state IN ('pending','leased','running');
    CREATE INDEX IF NOT EXISTS h1_delivery_claim
      ON h1_queue_deliveries(network_id, consumer_node_id, state, lease_expires_at_ms, created_at_ms);
    CREATE INDEX IF NOT EXISTS h1_delivery_lease_owner
      ON h1_queue_deliveries(network_id, consumer_node_id, lease_owner_token_id, state, lease_expires_at_ms);

    CREATE TABLE IF NOT EXISTS h1_task_assignments (
      task_id TEXT PRIMARY KEY,
      network_id TEXT NOT NULL,
      producer_node_id TEXT,
      consumer_node_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL UNIQUE,
      assignment_epoch INTEGER NOT NULL DEFAULT 0 CHECK (assignment_epoch >= 0 AND assignment_epoch <= 9223372036854775807),
      updated_at_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS h1_queue_idempotency (
      network_id TEXT NOT NULL,
      principal_kind TEXT NOT NULL CHECK (principal_kind IN ('node_consumer','queue_control')),
      principal_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      operation_id TEXT NOT NULL CHECK (length(operation_id) > 0),
      operation TEXT NOT NULL,
      request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
      result_json TEXT NOT NULL CHECK (length(result_json) <= 16384),
      task_id TEXT,
      delivery_id TEXT,
      created_at_ms INTEGER NOT NULL,
      PRIMARY KEY(network_id, principal_kind, principal_id, token_id, operation_id)
    );
    CREATE INDEX IF NOT EXISTS h1_idem_task ON h1_queue_idempotency(task_id);
    CREATE INDEX IF NOT EXISTS h1_idem_delivery ON h1_queue_idempotency(delivery_id);

    CREATE TABLE IF NOT EXISTS h1_queue_idempotency_refs (
      network_id TEXT NOT NULL,
      principal_kind TEXT NOT NULL CHECK (principal_kind IN ('node_consumer','queue_control')),
      principal_id TEXT NOT NULL,
      token_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      delivery_id TEXT NOT NULL,
      task_id TEXT,
      PRIMARY KEY(network_id, principal_kind, principal_id, token_id, operation_id, delivery_id)
    );
    CREATE INDEX IF NOT EXISTS h1_idem_ref_delivery ON h1_queue_idempotency_refs(delivery_id);
    CREATE INDEX IF NOT EXISTS h1_idem_ref_task ON h1_queue_idempotency_refs(task_id);

    CREATE TABLE IF NOT EXISTS h1_queue_security_audit (
      audit_id TEXT PRIMARY KEY,
      network_id TEXT NOT NULL,
      principal_kind TEXT NOT NULL CHECK (principal_kind IN ('node_consumer','queue_control','system')),
      principal_id TEXT NOT NULL,
      token_id TEXT,
      action TEXT NOT NULL,
      task_id TEXT,
      delivery_id TEXT,
      detail_json TEXT NOT NULL DEFAULT '{}' CHECK (length(detail_json) <= 4096),
      created_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS h1_audit_delivery ON h1_queue_security_audit(delivery_id, created_at_ms);
    CREATE INDEX IF NOT EXISTS h1_audit_task ON h1_queue_security_audit(task_id, created_at_ms);

    CREATE TABLE IF NOT EXISTS h1_queue_doorbell_outbox (
      outbox_id TEXT PRIMARY KEY,
      network_id TEXT NOT NULL,
      consumer_node_id TEXT NOT NULL,
      expected_delivery_id TEXT NOT NULL,
      expected_epoch INTEGER NOT NULL CHECK (expected_epoch >= 0),
      expected_state TEXT NOT NULL CHECK (expected_state IN ('pending','leased','running','consumed','replied','dead_lettered','cancelled','superseded')),
      pending_count INTEGER CHECK (pending_count IS NULL OR pending_count >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','dispatched','suppressed')),
      created_at_ms INTEGER NOT NULL,
      dispatched_at_ms INTEGER
    );
    CREATE INDEX IF NOT EXISTS h1_outbox_pending ON h1_queue_doorbell_outbox(status, created_at_ms);

    CREATE TABLE IF NOT EXISTS h1_delegation_edges (
      edge_id TEXT PRIMARY KEY,
      network_id TEXT NOT NULL,
      parent_task_id TEXT NOT NULL,
      parent_delivery_id TEXT NOT NULL,
      parent_epoch INTEGER NOT NULL CHECK (parent_epoch >= 0),
      delegator_node_id TEXT NOT NULL,
      child_task_id TEXT NOT NULL UNIQUE,
      child_consumer_node_id TEXT NOT NULL,
      depth INTEGER NOT NULL CHECK (depth >= 1 AND depth <= 8),
      created_at_ms INTEGER NOT NULL,
      UNIQUE(parent_delivery_id, child_task_id)
    );
    CREATE INDEX IF NOT EXISTS h1_edge_parent ON h1_delegation_edges(parent_task_id);

    CREATE TABLE IF NOT EXISTS h1_reply_attachments (
      attachment_id TEXT PRIMARY KEY,
      network_id TEXT NOT NULL,
      edge_id TEXT NOT NULL,
      child_task_id TEXT NOT NULL,
      child_terminal_delivery_id TEXT NOT NULL,
      parent_delivery_id TEXT NOT NULL,
      parent_epoch INTEGER NOT NULL CHECK (parent_epoch >= 0),
      delegator_node_id TEXT NOT NULL,
      attachment_delivery_id TEXT NOT NULL UNIQUE,
      created_at_ms INTEGER NOT NULL,
      UNIQUE(edge_id, child_terminal_delivery_id)
    );
    CREATE INDEX IF NOT EXISTS h1_attachment_parent ON h1_reply_attachments(parent_delivery_id);
  `);

  if (db.dialect === "sqlite") {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS h1_binding_immutable
      BEFORE UPDATE OF token_id, user_id, network_id, node_id, binding_generation, provenance, bound_at_ms
      ON h1_node_token_bindings
      BEGIN
        SELECT RAISE(ABORT, 'immutable_consumer_binding');
      END;
    `);
  }
}
