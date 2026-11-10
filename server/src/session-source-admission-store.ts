// One durable association per user/network intent AND per evidence request.
// A lost/failed check is not reusable: a new grant cannot bypass this journal.
export const sessionSourceAdmissionSchema = `CREATE TABLE IF NOT EXISTS session_source_admission_intents (
  user_id TEXT NOT NULL, network_id TEXT NOT NULL, intent_id TEXT NOT NULL,
  evidence_request_id TEXT NOT NULL UNIQUE, requester_token_id TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE, recheck_request_id TEXT NOT NULL UNIQUE,
  authorized_until INTEGER NOT NULL,
  execution_guard TEXT NOT NULL CHECK(execution_guard='daemon_recheck_in_execution_context_required'),
  child_name TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('checking','reserved','refused')),
  source_ref TEXT UNIQUE, create_request_id TEXT UNIQUE,
  PRIMARY KEY(user_id,network_id,intent_id)
);`;

export const sessionSourceExecutionSchema = `CREATE TABLE IF NOT EXISTS session_source_executions (
  execution_id TEXT PRIMARY KEY, admission_request_id TEXT NOT NULL UNIQUE,
  task_json TEXT NOT NULL, user_id TEXT NOT NULL, requester_token_id TEXT NOT NULL, daemon_token_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','claimed','session_ready','refused','unknown')),
  session_id TEXT, result_json TEXT
);`;

export const sessionSourceDeliverySchema = `CREATE TABLE IF NOT EXISTS session_source_node_deliveries (
  delivery_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE, child_node_id TEXT NOT NULL UNIQUE,
  child_name TEXT NOT NULL, token_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','delivered','registered','unknown'))
);`;

export const sessionSourceTransportSchema = `CREATE TABLE IF NOT EXISTS session_source_transports (
  request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, requester_token_id TEXT NOT NULL,
  network_id TEXT NOT NULL, intent_id TEXT NOT NULL, source_node_id TEXT NOT NULL,
  daemon_node_id TEXT NOT NULL, daemon_token_id TEXT NOT NULL, daemon_instance_id TEXT NOT NULL, session_id TEXT NOT NULL,
  child_name TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL,
  evidence_id TEXT NOT NULL, execution_id TEXT, delivery_id TEXT, child_node_id TEXT, child_session_id TEXT,
  UNIQUE(user_id,network_id,intent_id)
);`;

// Project-new is not a managed-source admission and has no source_ref. This
// durable intent/name reservation is never an ordinary create outbox.
export const sessionProjectCreateSchema = `CREATE TABLE IF NOT EXISTS session_project_creates (
  request_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, requester_token_id TEXT NOT NULL,
  network_id TEXT NOT NULL, source_node_id TEXT NOT NULL, daemon_node_id TEXT NOT NULL,
  daemon_token_id TEXT NOT NULL, daemon_instance_id TEXT NOT NULL, intent_id TEXT NOT NULL,
  selection_scope TEXT NOT NULL, snapshot_id TEXT NOT NULL, project_id TEXT NOT NULL, child_name TEXT NOT NULL,
  accepted_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL,
  session_id TEXT, child_node_id TEXT, child_token_id TEXT, credential_expires_at INTEGER,
  UNIQUE(user_id,network_id,intent_id), UNIQUE(network_id,child_name)
);`;

/** Idempotent additive migration, including databases created before attach. */
export function migrateProjectOperationJournal(db: { dialect: string; all: Function; exec: Function }) {
  if (db.dialect !== "sqlite") {
    db.exec("ALTER TABLE session_project_creates ADD COLUMN IF NOT EXISTS operation_kind TEXT NOT NULL DEFAULT 'project_new_session'");
    db.exec("ALTER TABLE session_project_creates ADD COLUMN IF NOT EXISTS selected_session_id TEXT");
    return;
  }
  const columns = new Set(db.all("PRAGMA table_info(session_project_creates)").map((c: any) => c.name));
  if (!columns.has("operation_kind")) db.exec("ALTER TABLE session_project_creates ADD COLUMN operation_kind TEXT NOT NULL DEFAULT 'project_new_session'");
  if (!columns.has("selected_session_id")) db.exec("ALTER TABLE session_project_creates ADD COLUMN selected_session_id TEXT");
}
