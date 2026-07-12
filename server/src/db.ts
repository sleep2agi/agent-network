import { createAdapter, type DbAdapter } from "./db-adapter";

export const db: DbAdapter = createAdapter();

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    resume_id     TEXT PRIMARY KEY,
    alias         TEXT,
    tmux_name     TEXT,
    server        TEXT DEFAULT 'unknown',
    ip            TEXT,
    hostname      TEXT,
    agent         TEXT,
    project_dir   TEXT,
    version       TEXT,
    status        TEXT DEFAULT 'offline',
    task          TEXT,
    output        TEXT,
    progress      INTEGER DEFAULT 0,
    score         REAL,
    cpu_load_1min REAL,
    cpu_cores     INTEGER,
    mem_total_gb  REAL,
    mem_used_gb   REAL,
    mem_avail_gb  REAL,
    disk_total_gb REAL,
    disk_used_gb  REAL,
    disk_avail_gb REAL,
    process_rss_bytes INTEGER,
    process_rss_mb REAL,
    process_cpu_pct REAL,
    process_uptime_seconds REAL,
    process_in_flight_count INTEGER,
    network_id    TEXT NOT NULL DEFAULT 'default',
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (network_id, alias)
  );

  CREATE TABLE IF NOT EXISTS inbox (
    id            TEXT PRIMARY KEY,
    session_name  TEXT NOT NULL,
    type          TEXT DEFAULT 'task',
    priority      TEXT DEFAULT 'normal',
    content       TEXT NOT NULL,
    context       TEXT,
    from_session  TEXT DEFAULT 'hub',
    acked         INTEGER DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_inbox_pending
    ON inbox(session_name, acked) WHERE acked = 0;

  CREATE TABLE IF NOT EXISTS completions (
    id               TEXT PRIMARY KEY,
    session_name     TEXT NOT NULL,
    task             TEXT NOT NULL,
    result           TEXT NOT NULL,
    artifacts        TEXT,
    score            REAL,
    duration_minutes REAL,
    network_id       TEXT,
    completed_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── V2 schema migration (ALTER TABLE, safe to re-run) ──

// sessions: add node_id, session_id, config_path, channels, last_seen_at, model, host telemetry
for (const col of [
  { name: "node_id", def: "TEXT" },
  { name: "session_id", def: "TEXT" },
  { name: "config_path", def: "TEXT" },
  { name: "channels", def: "TEXT" },
  { name: "last_seen_at", def: "TEXT" },
  { name: "model", def: "TEXT" },
  { name: "cpu_load_1min", def: "REAL" },
  { name: "cpu_cores", def: "INTEGER" },
  { name: "mem_total_gb", def: "REAL" },
  { name: "mem_used_gb", def: "REAL" },
  { name: "mem_avail_gb", def: "REAL" },
  { name: "disk_total_gb", def: "REAL" },
  { name: "disk_used_gb", def: "REAL" },
  { name: "disk_avail_gb", def: "REAL" },
  { name: "process_rss_bytes", def: "INTEGER" },
  { name: "process_rss_mb", def: "REAL" },
  { name: "process_cpu_pct", def: "REAL" },
  { name: "process_uptime_seconds", def: "REAL" },
  { name: "process_in_flight_count", def: "INTEGER" },
]) {
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col.name} ${col.def}`); } catch {}
}

db.exec(`
  CREATE TABLE IF NOT EXISTS agent_telemetry (
    id                      TEXT PRIMARY KEY,
    network_id              TEXT NOT NULL DEFAULT 'default',
    resume_id               TEXT,
    alias                   TEXT,
    hostname                TEXT,
    ip                      TEXT,
    cpu_load_1min           REAL,
    cpu_cores               INTEGER,
    mem_total_gb            REAL,
    mem_used_gb             REAL,
    mem_avail_gb            REAL,
    disk_total_gb           REAL,
    disk_used_gb            REAL,
    disk_avail_gb           REAL,
    process_rss_bytes       INTEGER,
    process_rss_mb          REAL,
    process_cpu_pct         REAL,
    process_uptime_seconds  REAL,
    process_in_flight_count INTEGER,
    created_at              TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_agent_telemetry_alias_time
    ON agent_telemetry(network_id, alias, created_at);
`);

// Round-2/4 review ② — server-health index split.
//
// The /api/server-health/:host query (index.ts) filters
//   WHERE (hostname = ?1 OR ip = ?2) AND created_at >= ?3
// The old combined index (network_id, hostname, ip, created_at) only
// covers an equality on hostname AND ip (not OR), so SQLite couldn't
// use it for the disjunction and fell back to a full scan of
// agent_telemetry on every server-health page load. At a 30s heartbeat
// × N agents, the table grows fast and the scan dominates.
//
// Split into two narrow indexes so SQLite's OR optimizer can run an
// index UNION on (hostname-path ∪ ip-path), each path covered by an
// index that also lets the created_at range be range-scanned.
//
// **Honest trade-off** (corrected after reviewer flag): secondary
// index count goes from 2 (host_time + alias_time) to 3 (hostname_time
// + ip_time + alias_time). Every agent_telemetry insert now maintains
// ONE MORE B-tree, so per-insert write-amp is +50%. The trade-off is
// deliberate: write-amp is bounded by the heartbeat cadence (30s ×
// N agents) and is small in absolute terms, while the read-path win
// is going from O(n) full-scan-per-dashboard-poll to O(log n) two-
// branch index union. For the public-facing hub's expected load
// shape (many readers, few writers), that's a clear net gain.
try { db.exec("DROP INDEX IF EXISTS idx_agent_telemetry_host_time"); } catch {}
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_telemetry_hostname_time
           ON agent_telemetry(network_id, hostname, created_at)`);
} catch {}
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_agent_telemetry_ip_time
           ON agent_telemetry(network_id, ip, created_at)`);
} catch {}

// inbox: add in_reply_to, requires_response, expires_at, scope, node identity
for (const col of [
  { name: "in_reply_to", def: "TEXT" },
  { name: "requires_response", def: "TEXT DEFAULT 'reply'" },
  { name: "expires_at", def: "TEXT" },
  { name: "scope", def: "TEXT DEFAULT 'single'" },
  { name: "meta_json", def: "TEXT" },
  { name: "node_id", def: "TEXT" },
  // RFC-030 Wave 1B principal stamp (approved <2h scope exception):
  // server-stamped sender principal, resolved from the caller's auth
  // context (api_tokens row), NEVER from client-supplied fields. Nullable
  // + additive: legacy rows and non-token senders stay null; ONLY the
  // codex gateway treats null as refuse — every other consumer of
  // get_inbox is unaffected.
  { name: "sender_token_id", def: "TEXT" },
  { name: "sender_role", def: "TEXT" },
]) {
  try { db.exec(`ALTER TABLE inbox ADD COLUMN ${col.name} ${col.def}`); } catch {}
}

// indexes for new columns
try { db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_type ON inbox(type)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_from ON inbox(from_session)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_reply ON inbox(in_reply_to)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_node ON inbox(node_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_node ON sessions(node_id)"); } catch {}

// tasks table (V2)
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    task_id           TEXT PRIMARY KEY,
    from_node_id      TEXT,
    from_name         TEXT NOT NULL DEFAULT 'hub',
    to_node_id        TEXT,
    to_name           TEXT NOT NULL,
    priority          TEXT NOT NULL DEFAULT 'normal',
    status            TEXT NOT NULL DEFAULT 'created',
    content           TEXT NOT NULL,
    result            TEXT,
    in_reply_to       TEXT,
    requires_response TEXT DEFAULT 'reply',
    scope             TEXT DEFAULT 'single',
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    delivered_at      TEXT,
    started_at        TEXT,
    completed_at      TEXT,
    expires_at        TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_to ON tasks(to_name);
  CREATE INDEX IF NOT EXISTS idx_tasks_from ON tasks(from_name);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
  -- #248 — composite index for the dashboard chat-panel history query
  -- (/api/tasks?to_name=X&limit=30 ORDER BY created_at DESC). Without it
  -- SQLite walks every row for the alias via idx_tasks_to and sorts in
  -- memory; on an active node with thousands of tasks that's O(N log N)
  -- per panel open. The composite ordered DESC lets the planner stop
  -- after LIMIT rows — O(log N + LIMIT). Idempotent migration; safe to
  -- ship — existing single-column idx_tasks_to is kept (other paths
  -- use it and we don't need the risk of dropping it).
  CREATE INDEX IF NOT EXISTS idx_tasks_to_created ON tasks(to_name, created_at DESC);
`);

// nodes table (V2 Sprint 2) — persistent node identity, separate from runtime sessions
db.exec(`
  CREATE TABLE IF NOT EXISTS nodes (
    node_id       TEXT PRIMARY KEY,
    node_name     TEXT NOT NULL,
    alias         TEXT,
    runtime       TEXT,
    model         TEXT,
    config_path   TEXT,
    channels      TEXT,
    server        TEXT,
    hostname      TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(node_name);
  CREATE INDEX IF NOT EXISTS idx_nodes_alias ON nodes(alias);
`);

// task_events table (V2 Sprint 2) — audit log for task state changes
db.exec(`
  CREATE TABLE IF NOT EXISTS task_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id       TEXT NOT NULL,
    from_status   TEXT,
    to_status     TEXT NOT NULL,
    actor         TEXT NOT NULL DEFAULT 'system',
    detail        TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_task_events_task_time ON task_events(task_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_task_events_created ON task_events(created_at);
`);

// ── V3: users table ──
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    user_id       TEXT PRIMARY KEY,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    email         TEXT,
    display_name  TEXT,
    role          TEXT DEFAULT 'user',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
`);

// #261 P0-2 (2026-06-28): must_change_password flag. Added via ALTER
// (not in the CREATE block above) so it's a no-op on fresh DBs that
// already get the column via the CREATE path's full definition AND a
// pure additive migration on existing prod DBs — column defaults 0
// for every existing row, so old `admin/anethub` deployments are NOT
// locked or nudged on upgrade (back-compat per 通信龙 spec). Wrapped
// in try/catch because SQLite throws "duplicate column" if the column
// already exists on subsequent restarts (no IF NOT EXISTS syntax for
// ALTER ADD COLUMN until SQLite 3.35+, can't assume that everywhere).
try {
  db.exec(`ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0`);
} catch (e: any) {
  if (!/duplicate column|already exists/i.test(e?.message || "")) throw e;
}

// RFC-024 (2026-06-28): node config-apply foundation.
//
// `nodes` table gains two columns:
//   - `config_revision`: monotonically-incrementing per-node revision
//     that gates write conflicts (dashboard sends base_revision, hub
//     rejects 409 if it doesn't match current). Promoted by hub when
//     the node ACKs `applied` from a successful apply.
//   - `config_snapshot`: masked JSON of the node's current effective
//     config, posted by the node via report_status. Dashboard reads
//     this for the GET snapshot path (never touches per-node files).
//
// Both ALTERs wrapped in try/catch for the same reason as
// must_change_password above (no IF NOT EXISTS on SQLite < 3.35).
try {
  db.exec(`ALTER TABLE nodes ADD COLUMN config_revision INTEGER DEFAULT 0`);
} catch (e: any) {
  if (!/duplicate column|already exists/i.test(e?.message || "")) throw e;
}
try {
  db.exec(`ALTER TABLE nodes ADD COLUMN config_snapshot TEXT`);
} catch (e: any) {
  if (!/duplicate column|already exists/i.test(e?.message || "")) throw e;
}

// RFC-026 §9 / #338 PR2 — daemon self-declare fields promoted from
// config_snapshot to first-class indexable columns. The hub
// `list_host_supervisors` MCP tool reads these directly without parsing
// the snapshot JSON on every list call.
//
// Both fields are JSON arrays of strings:
//   runtimes_supported    e.g. ["claude-agent-sdk","codex-sdk","grok-build-acp"]
//   allowed_secret_keys   e.g. ["ANTHROPIC_API_KEY","OPENAI_API_KEY"]
//
// Stored as TEXT (JSON-encoded) — SQLite has no native array type and
// the wrapper code is small. Both nullable for pre-PR2 daemons; the
// list endpoint falls back to [] when null.
try {
  db.exec(`ALTER TABLE nodes ADD COLUMN runtimes_supported TEXT`);
} catch (e: any) {
  if (!/duplicate column|already exists/i.test(e?.message || "")) throw e;
}
try {
  db.exec(`ALTER TABLE nodes ADD COLUMN allowed_secret_keys TEXT`);
} catch (e: any) {
  if (!/duplicate column|already exists/i.test(e?.message || "")) throw e;
}

// RFC-027 §2.3 — state machine for stop/delete (D5). 'active' default
// matches pre-RFC behavior for every existing row. Transitions:
//   active → stopping → stopped → (back to active via restart_node)
//   active → deleting → (row gone)
//   stopped → deleting → (row gone)
// Used as the inbox-enqueue gate per §2.3 race-free invariant:
// pushEvent / INSERT INTO inbox must refuse a non-active target so the
// SIGTERM-in-flight window never gets a new task.
try {
  db.exec(`ALTER TABLE nodes ADD COLUMN lifecycle_state TEXT DEFAULT 'active'`);
} catch (e: any) {
  if (!/duplicate column|already exists/i.test(e?.message || "")) throw e;
}

// RFC-027 §2 — stop/delete request envelope. Mirrors
// node_create_requests structure so the daemon-side pull/ack pattern
// is symmetric with create_node. action='stop'|'delete' picks which
// branch (delete adds backup_path + revokes ntok on ack).
db.exec(`
  CREATE TABLE IF NOT EXISTS node_stop_requests (
    request_id TEXT PRIMARY KEY,
    network_id TEXT NOT NULL,
    daemon_node_id TEXT NOT NULL,
    child_node_id TEXT NOT NULL,
    child_alias TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('stop', 'delete')),
    delete_config INTEGER NOT NULL DEFAULT 1,
    grace_seconds INTEGER NOT NULL DEFAULT 10,
    force INTEGER NOT NULL DEFAULT 0,
    in_flight_at_dispatch INTEGER NOT NULL DEFAULT 0,
    created_by_token TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT,
    backup_path TEXT,
    exit_signal TEXT,
    created_at INTEGER NOT NULL,
    delivered_at INTEGER,
    acked_at INTEGER
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_stop_req_daemon ON node_stop_requests(daemon_node_id, status)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_stop_req_child ON node_stop_requests(child_node_id)`);

// `node_config_updates` — pending + history. One row per dashboard write.
// At most one row per node may be in a non-terminal state at a time
// (single-flight enforced at the tool layer; this table just stores).
//
// network_id is denormalized from nodes(network_id) at insert time so
// queries don't need to JOIN through nodes every time + so a node
// deletion doesn't orphan the history (audit retention).
db.exec(`
  CREATE TABLE IF NOT EXISTS node_config_updates (
    update_id        TEXT PRIMARY KEY,
    node_id          TEXT NOT NULL,
    network_id       TEXT NOT NULL,
    patch_json       TEXT NOT NULL,
    apply_mode       TEXT NOT NULL,
    base_revision    INTEGER NOT NULL,
    status           TEXT NOT NULL,
    error            TEXT,
    created_at       INTEGER NOT NULL,
    created_by_token TEXT NOT NULL,
    acked_at         INTEGER,
    new_revision     INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_ncu_node_status ON node_config_updates(node_id, status);
  CREATE INDEX IF NOT EXISTS idx_ncu_network ON node_config_updates(network_id);
`);

// F-C (CHANGE_REQ): partial unique index on non-terminal rows. The
// single-flight check in tools.ts is an app-level check-then-INSERT —
// safe under single-process Bun, but two hub workers could race and
// double-insert. This index makes that race impossible at the DB
// layer regardless of process count. Wrapped in try/catch because
// SQLite < 3.8.0 doesn't support partial indexes (rare on modern
// systems; if missing, app-level check is the fallback).
try {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_ncu_node_inflight ON node_config_updates(node_id) WHERE status IN ('pending', 'restarting')`);
} catch (e: any) {
  // Older SQLite — fall back to app-level single-flight only.
  console.warn(`[commhub] partial unique index uniq_ncu_node_inflight skipped: ${e?.message || e}`);
}

// ── V3: networks table ──
db.exec(`
  CREATE TABLE IF NOT EXISTS networks (
    network_id    TEXT PRIMARY KEY,
    network_name  TEXT NOT NULL,
    owner_id      TEXT NOT NULL,
    description   TEXT,
    settings      TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(owner_id, network_name)
  );

  CREATE INDEX IF NOT EXISTS idx_networks_owner ON networks(owner_id);
`);

// ── V3: api_tokens table ──
db.exec(`
  CREATE TABLE IF NOT EXISTS api_tokens (
    token_id      TEXT PRIMARY KEY,
    token_hash    TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    network_id    TEXT,
    name          TEXT NOT NULL DEFAULT 'default',
    scope         TEXT DEFAULT 'full',
    expires_at    TEXT,
    last_used_at  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tokens_hash ON api_tokens(token_hash);
  CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
`);

// RFC-026 v4 §4.4.8 C4 — api_tokens metadata so sweeper can revoke
// orphan child-ntoks without ever touching plaintext tokens. ALTER in
// try/catch (idempotent for already-migrated DBs).
//   request_id  — links a child token to the create_node request that
//                 minted it; sweeper joins on this
//   revoked_at  — explicit revoke; resolveToken treats non-NULL as
//                 invalid even before expiry
for (const ddl of [
  "ALTER TABLE api_tokens ADD COLUMN request_id TEXT",
  "ALTER TABLE api_tokens ADD COLUMN revoked_at TEXT",
  "ALTER TABLE api_tokens ADD COLUMN role TEXT",
]) {
  try { db.exec(ddl); }
  catch (e: any) {
    if (!/duplicate column|already exists/i.test(e?.message || "")) throw e;
  }
}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_tokens_request ON api_tokens(request_id)`); }
catch (e: any) { /* index may already exist */ void e; }

// RFC-026 v4 §2.5 + §4.4 — node_create_requests. Metadata only;
// env_blob NEVER lives in this table (F1 mint-stream-evict — secret
// blob is in-memory Map keyed by request_id, drained on daemon get,
// TTL 60s GC).
//
// env_keys is a JSON array of secret KEY NAMES only (for audit). The
// actual values flow through pendingEnvBlobs Map and never touch
// disk.
db.exec(`
  CREATE TABLE IF NOT EXISTS node_create_requests (
    request_id        TEXT PRIMARY KEY,
    daemon_node_id    TEXT NOT NULL,
    child_name        TEXT NOT NULL,
    network_id        TEXT NOT NULL,
    runtime           TEXT NOT NULL,
    model             TEXT NOT NULL,
    flags_json        TEXT NOT NULL,
    env_keys          TEXT NOT NULL,
    status            TEXT NOT NULL,
    error             TEXT,
    child_token_id    TEXT,
    created_at        INTEGER NOT NULL,
    created_by_token  TEXT NOT NULL,
    delivered_at      INTEGER,
    acked_at          INTEGER,
    child_node_id     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_ncr_daemon_status ON node_create_requests(daemon_node_id, status);
  CREATE INDEX IF NOT EXISTS idx_ncr_network ON node_create_requests(network_id);
  CREATE INDEX IF NOT EXISTS idx_ncr_child_name ON node_create_requests(child_name);
`);
try {
  // Single-flight per (daemon, child_name) — prevents racing dashboard
  // create on same name. Mirrors RFC-024 uniq_ncu_node_inflight.
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_ncr_inflight ON node_create_requests(daemon_node_id, child_name) WHERE status IN ('pending', 'delivered')`);
} catch (e: any) {
  console.warn(`[commhub] partial unique index uniq_ncr_inflight skipped: ${e?.message || e}`);
}

// RFC-028 P1 v4 §2.2 — providers + provider_models + network_secrets +
// probe_results. All 4 tables idempotent CREATE TABLE IF NOT EXISTS. F2
// lazy gate: tables created on hub boot regardless; vault master key
// (ANET_HUB_SECRET_VAULT_KEY env) only required when these tables get
// their first non-empty row (lazy in vault.ts). Empty tables = hub
// boots fine without env (critical for existing prod hub升级 不 brick).
db.exec(`
  CREATE TABLE IF NOT EXISTS providers (
    provider_id     TEXT PRIMARY KEY,
    network_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    vendor          TEXT NOT NULL,
    base_url        TEXT NOT NULL,
    secret_key_ref  TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    created_by      TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    UNIQUE(network_id, name)
  );
  CREATE INDEX IF NOT EXISTS idx_providers_network ON providers(network_id);
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS provider_models (
    model_id        TEXT PRIMARY KEY,
    provider_id     TEXT NOT NULL,
    model_name      TEXT NOT NULL,
    display_name    TEXT,
    context_window  INTEGER,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    UNIQUE(provider_id, model_name)
  );
  CREATE INDEX IF NOT EXISTS idx_models_provider ON provider_models(provider_id);
`);
// network_secrets — encrypted-at-rest vault. ciphertext + iv + tag are
// AES-GCM output; plaintext NEVER touches this table. master key from
// ANET_HUB_SECRET_VAULT_KEY env (lazy gate in vault.ts).
db.exec(`
  CREATE TABLE IF NOT EXISTS network_secrets (
    network_id   TEXT NOT NULL,
    key          TEXT NOT NULL,
    ciphertext   BLOB NOT NULL,
    iv           BLOB NOT NULL,
    tag          BLOB NOT NULL,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    PRIMARY KEY (network_id, key)
  );
`);
// probe_results — connectivity matrix history. v3 R3 lock: error_label
// is HUB-DERIVED ONLY from (status, raw_status_code) — daemon CANNOT
// submit arbitrary error string. status enum mirrors ProbeAckPayload.
db.exec(`
  CREATE TABLE IF NOT EXISTS probe_results (
    probe_id        TEXT PRIMARY KEY,
    provider_id     TEXT NOT NULL,
    model_name      TEXT NOT NULL,
    daemon_node_id  TEXT NOT NULL,
    network_id      TEXT NOT NULL,
    status          TEXT NOT NULL,
    latency_ms      INTEGER,
    error_label     TEXT,
    probed_at       INTEGER NOT NULL,
    probed_by_user  TEXT,
    raw_status_code INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_probe_matrix ON probe_results(network_id, provider_id, model_name, daemon_node_id, probed_at DESC);
`);

// ── V3: audit_log table ──
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       TEXT,
    username      TEXT,
    action        TEXT NOT NULL,
    target_type   TEXT,
    target_id     TEXT,
    detail        TEXT,
    ip            TEXT,
    network_id    TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id);
  CREATE INDEX IF NOT EXISTS idx_audit_network ON audit_log(network_id);
`);

// ── V3: licenses table ──
db.exec(`
  CREATE TABLE IF NOT EXISTS licenses (
    id            TEXT PRIMARY KEY,
    license_key   TEXT UNIQUE NOT NULL,
    type          TEXT DEFAULT 'trial',
    max_agents    INTEGER DEFAULT 5,
    max_networks  INTEGER DEFAULT 3,
    max_tasks_day INTEGER DEFAULT 500,
    activated_at  TEXT,
    expires_at    TEXT,
    owner_id      TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Auto-create trial license on first run
const existingLicense = db.get<any>("SELECT id FROM licenses LIMIT 1");
if (!existingLicense) {
  const trialId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  db.run(
    "INSERT INTO licenses (id, license_key, type, expires_at) VALUES (?1, ?2, 'trial', datetime('now', '+14 days'))",
    [`lic_${trialId}`, `trial-${trialId}`]
  );
  console.log("[commhub] 🎉 14-day free trial started!");
}

// ── V3.13: network_members table (user ↔ network many-to-many) ──
db.exec(`
  CREATE TABLE IF NOT EXISTS network_members (
    network_id  TEXT NOT NULL,
    user_id     TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',
    invited_by  TEXT,
    joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (network_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_netmem_user ON network_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_netmem_network ON network_members(network_id);
`);

// ── V3.13: network_invites table ──
db.exec(`
  CREATE TABLE IF NOT EXISTS network_invites (
    invite_code TEXT PRIMARY KEY,
    network_id  TEXT NOT NULL,
    role        TEXT NOT NULL DEFAULT 'member',
    created_by  TEXT NOT NULL,
    max_uses    INTEGER DEFAULT 1,
    used_count  INTEGER DEFAULT 0,
    expires_at  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── #84: node rename — rename_txn table (RFC-010 §4) ──
// Single isolated table holding the rename 2PC transaction state. It doubles
// as the alias_rename_log (RFC §4 risk #5): the audit log of completed renames
// is just `SELECT * FROM rename_txn WHERE status = 'committed'`. Kept out of
// the sessions table so a prepared (in-flight) new-alias never shows up in
// get_all_status / node listings. status: prepared → committed | aborted.
db.exec(`
  CREATE TABLE IF NOT EXISTS rename_txn (
    txn_id        TEXT PRIMARY KEY,
    network_id    TEXT NOT NULL,
    old_alias     TEXT NOT NULL,
    new_alias     TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'prepared',
    prepared_at   TEXT NOT NULL DEFAULT (datetime('now')),
    committed_at  TEXT,
    aborted_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_rename_txn_new ON rename_txn(network_id, new_alias);
  CREATE INDEX IF NOT EXISTS idx_rename_txn_old ON rename_txn(network_id, old_alias);
  CREATE INDEX IF NOT EXISTS idx_rename_txn_status ON rename_txn(status);
`);

// ── V3.13: networks visibility + max_members ──
try { db.exec("ALTER TABLE networks ADD COLUMN visibility TEXT DEFAULT 'private'"); } catch {}
try { db.exec("ALTER TABLE networks ADD COLUMN max_members INTEGER DEFAULT 50"); } catch {}

// ── V3.13: users plan field ──
try { db.exec("ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free'"); } catch {}

// ── V3.13: migrate existing networks → network_members (owner) ──
try {
  const networks = db.all<any>("SELECT network_id, owner_id FROM networks");
  for (const net of networks) {
    const exists = db.get<any>("SELECT 1 FROM network_members WHERE network_id = ?1 AND user_id = ?2", net.network_id, net.owner_id);
    if (!exists) {
      db.run("INSERT INTO network_members (network_id, user_id, role) VALUES (?1, ?2, 'owner')", [net.network_id, net.owner_id]);
    }
  }
} catch {}

// ── V3.13: first registered user → admin ──
try {
  const firstUser = db.get<any>("SELECT user_id, role FROM users ORDER BY created_at LIMIT 1");
  if (firstUser && firstUser.role !== "admin") {
    db.run("UPDATE users SET role = 'admin' WHERE user_id = ?1", [firstUser.user_id]);
  }
} catch {}

// ── V3: add network_id to existing tables ──
for (const table of ["sessions", "nodes", "tasks", "inbox", "task_events", "completions"]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN network_id TEXT`); } catch {}
}

// PR-1 (#146): durable node identity on historical inbox/tasks rows. Some
// existing databases created `tasks` before from_node_id/to_node_id were in the
// CREATE TABLE statement, so keep these ALTERs explicit and idempotent.
for (const col of [
  { table: "tasks", name: "from_node_id", def: "TEXT" },
  { table: "tasks", name: "to_node_id", def: "TEXT" },
  { table: "inbox", name: "node_id", def: "TEXT" },
]) {
  try { db.exec(`ALTER TABLE ${col.table} ADD COLUMN ${col.name} ${col.def}`); } catch {}
}

try { db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_from_node ON tasks(from_node_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_to_node ON tasks(to_node_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_node ON inbox(node_id)"); } catch {}

function backfillMessageNodeIds() {
  let inboxDirect = 0;
  let inboxRenamed = 0;
  let tasksToDirect = 0;
  let tasksToRenamed = 0;
  let tasksFromDirect = 0;
  let tasksFromRenamed = 0;

  try {
    inboxDirect = db.run(`
      UPDATE inbox
      SET node_id = (
        SELECT s.node_id FROM sessions s
        WHERE s.node_id IS NOT NULL
          AND s.alias = inbox.session_name
          AND COALESCE(s.network_id, 'default') = COALESCE(inbox.network_id, 'default')
        ORDER BY s.updated_at DESC
        LIMIT 1
      )
      WHERE node_id IS NULL
        AND EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.node_id IS NOT NULL
            AND s.alias = inbox.session_name
            AND COALESCE(s.network_id, 'default') = COALESCE(inbox.network_id, 'default')
        )
    `).changes;
  } catch {}

  try {
    inboxRenamed = db.run(`
      UPDATE inbox
      SET node_id = (
        SELECT s.node_id FROM rename_txn r
        JOIN sessions s
          ON s.alias = r.new_alias
         AND COALESCE(s.network_id, 'default') = COALESCE(r.network_id, 'default')
        WHERE s.node_id IS NOT NULL
          AND r.status = 'committed'
          AND r.old_alias = inbox.session_name
          AND COALESCE(r.network_id, 'default') = COALESCE(inbox.network_id, 'default')
        ORDER BY r.committed_at DESC
        LIMIT 1
      )
      WHERE node_id IS NULL
        AND EXISTS (
          SELECT 1 FROM rename_txn r
          JOIN sessions s
            ON s.alias = r.new_alias
           AND COALESCE(s.network_id, 'default') = COALESCE(r.network_id, 'default')
          WHERE s.node_id IS NOT NULL
            AND r.status = 'committed'
            AND r.old_alias = inbox.session_name
            AND COALESCE(r.network_id, 'default') = COALESCE(inbox.network_id, 'default')
        )
    `).changes;
  } catch {}

  try {
    tasksToDirect = db.run(`
      UPDATE tasks
      SET to_node_id = (
        SELECT s.node_id FROM sessions s
        WHERE s.node_id IS NOT NULL
          AND s.alias = tasks.to_name
          AND COALESCE(s.network_id, 'default') = COALESCE(tasks.network_id, 'default')
        ORDER BY s.updated_at DESC
        LIMIT 1
      )
      WHERE to_node_id IS NULL
        AND EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.node_id IS NOT NULL
            AND s.alias = tasks.to_name
            AND COALESCE(s.network_id, 'default') = COALESCE(tasks.network_id, 'default')
        )
    `).changes;
  } catch {}

  try {
    tasksToRenamed = db.run(`
      UPDATE tasks
      SET to_node_id = (
        SELECT s.node_id FROM rename_txn r
        JOIN sessions s
          ON s.alias = r.new_alias
         AND COALESCE(s.network_id, 'default') = COALESCE(r.network_id, 'default')
        WHERE s.node_id IS NOT NULL
          AND r.status = 'committed'
          AND r.old_alias = tasks.to_name
          AND COALESCE(r.network_id, 'default') = COALESCE(tasks.network_id, 'default')
        ORDER BY r.committed_at DESC
        LIMIT 1
      )
      WHERE to_node_id IS NULL
        AND EXISTS (
          SELECT 1 FROM rename_txn r
          JOIN sessions s
            ON s.alias = r.new_alias
           AND COALESCE(s.network_id, 'default') = COALESCE(r.network_id, 'default')
          WHERE s.node_id IS NOT NULL
            AND r.status = 'committed'
            AND r.old_alias = tasks.to_name
            AND COALESCE(r.network_id, 'default') = COALESCE(tasks.network_id, 'default')
        )
    `).changes;
  } catch {}

  try {
    tasksFromDirect = db.run(`
      UPDATE tasks
      SET from_node_id = (
        SELECT s.node_id FROM sessions s
        WHERE s.node_id IS NOT NULL
          AND s.alias = tasks.from_name
          AND COALESCE(s.network_id, 'default') = COALESCE(tasks.network_id, 'default')
        ORDER BY s.updated_at DESC
        LIMIT 1
      )
      WHERE from_node_id IS NULL
        AND EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.node_id IS NOT NULL
            AND s.alias = tasks.from_name
            AND COALESCE(s.network_id, 'default') = COALESCE(tasks.network_id, 'default')
        )
    `).changes;
  } catch {}

  try {
    tasksFromRenamed = db.run(`
      UPDATE tasks
      SET from_node_id = (
        SELECT s.node_id FROM rename_txn r
        JOIN sessions s
          ON s.alias = r.new_alias
         AND COALESCE(s.network_id, 'default') = COALESCE(r.network_id, 'default')
        WHERE s.node_id IS NOT NULL
          AND r.status = 'committed'
          AND r.old_alias = tasks.from_name
          AND COALESCE(r.network_id, 'default') = COALESCE(tasks.network_id, 'default')
        ORDER BY r.committed_at DESC
        LIMIT 1
      )
      WHERE from_node_id IS NULL
        AND EXISTS (
          SELECT 1 FROM rename_txn r
          JOIN sessions s
            ON s.alias = r.new_alias
           AND COALESCE(s.network_id, 'default') = COALESCE(r.network_id, 'default')
          WHERE s.node_id IS NOT NULL
            AND r.status = 'committed'
            AND r.old_alias = tasks.from_name
            AND COALESCE(r.network_id, 'default') = COALESCE(tasks.network_id, 'default')
        )
    `).changes;
  } catch {}

  const total = inboxDirect + inboxRenamed + tasksToDirect + tasksToRenamed + tasksFromDirect + tasksFromRenamed;
  console.log(`[commhub] node_id backfill: inbox=${inboxDirect + inboxRenamed}, tasks.to=${tasksToDirect + tasksToRenamed}, tasks.from=${tasksFromDirect + tasksFromRenamed}, total=${total}`);
}

backfillMessageNodeIds();

// ── P0: sessions alias uniqueness is network-scoped.
// Older SQLite databases created `alias TEXT UNIQUE`, which prevents the same
// agent alias from existing in two networks. SQLite cannot drop a UNIQUE
// constraint in place, so rebuild the table once with UNIQUE(network_id, alias).
function migrateSessionsNetworkAliasUnique() {
  try {
    db.run("UPDATE sessions SET network_id = 'default' WHERE network_id IS NULL OR network_id = ''");
  } catch {}

  if (db.dialect === "postgres") {
    try { db.exec("ALTER TABLE sessions ALTER COLUMN network_id SET DEFAULT 'default'"); } catch {}
    try { db.exec("UPDATE sessions SET network_id = 'default' WHERE network_id IS NULL OR network_id = ''"); } catch {}
    try { db.exec("ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_alias_key"); } catch {}
    try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_network_alias_unique ON sessions(network_id, alias)"); } catch {}
    return;
  }

  let needsRebuild = true;
  try {
    const createSql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'");
    needsRebuild = !!createSql?.sql && !/UNIQUE\s*\(\s*network_id\s*,\s*alias\s*\)/i.test(createSql.sql);
  } catch {}
  if (!needsRebuild) return;

  db.transaction(() => {
    db.exec("DROP TABLE IF EXISTS sessions_migrated");
    db.exec(`
      CREATE TABLE sessions_migrated (
        resume_id     TEXT PRIMARY KEY,
        alias         TEXT,
        tmux_name     TEXT,
        server        TEXT DEFAULT 'unknown',
        ip            TEXT,
        hostname      TEXT,
        agent         TEXT,
        project_dir   TEXT,
        version       TEXT,
        status        TEXT DEFAULT 'offline',
        task          TEXT,
        output        TEXT,
        progress      INTEGER DEFAULT 0,
        score         REAL,
        registered_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
        node_id       TEXT,
        session_id    TEXT,
        config_path   TEXT,
        channels      TEXT,
        last_seen_at  TEXT,
        model         TEXT,
        cpu_load_1min REAL,
        cpu_cores     INTEGER,
        mem_total_gb  REAL,
        mem_used_gb   REAL,
        mem_avail_gb  REAL,
        disk_total_gb REAL,
        disk_used_gb  REAL,
        disk_avail_gb REAL,
        process_rss_bytes INTEGER,
        process_rss_mb REAL,
        process_cpu_pct REAL,
        process_uptime_seconds REAL,
        process_in_flight_count INTEGER,
        network_id    TEXT NOT NULL DEFAULT 'default',
        UNIQUE (network_id, alias)
      )
    `);
    db.exec(`
      INSERT OR REPLACE INTO sessions_migrated (
        resume_id, alias, tmux_name, server, ip, hostname, agent, project_dir, version,
        status, task, output, progress, score, registered_at, updated_at, node_id,
        session_id, config_path, channels, last_seen_at, model, cpu_load_1min,
        cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb, disk_total_gb,
        disk_used_gb, disk_avail_gb, process_rss_bytes, process_rss_mb, process_cpu_pct,
        process_uptime_seconds, process_in_flight_count, network_id
      )
      SELECT
        resume_id, alias, tmux_name, server, ip, hostname, agent, project_dir, version,
        status, task, output, progress, score, registered_at, updated_at, node_id,
        session_id, config_path, channels, last_seen_at, model, cpu_load_1min,
        cpu_cores, mem_total_gb, mem_used_gb, mem_avail_gb, disk_total_gb,
        disk_used_gb, disk_avail_gb, process_rss_bytes, process_rss_mb, process_cpu_pct,
        process_uptime_seconds, process_in_flight_count,
        COALESCE(NULLIF(network_id, ''), 'default')
      FROM sessions
      ORDER BY updated_at
    `);
    db.exec("DROP TABLE sessions");
    db.exec("ALTER TABLE sessions_migrated RENAME TO sessions");
  });
}
migrateSessionsNetworkAliasUnique();

try { db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_network ON sessions(network_id)"); } catch {}
try { db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_network_alias_unique ON sessions(network_id, alias)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_network ON tasks(network_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_network ON nodes(network_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_network ON inbox(network_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_task_events_network ON task_events(network_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_completions_network ON completions(network_id)"); } catch {}

// ── Task lineage: parent_task_id for auto-chaining sub-task replies up the chain.
// When 主编 (child) replies to a task that 指挥室 sent on behalf of admin, we want
// admin to see the answer even if 指挥室's own session has died. The hub forwards
// the reply up the chain via parent_task_id.
try { db.exec("ALTER TABLE tasks ADD COLUMN parent_task_id TEXT"); } catch {}
try { db.exec("ALTER TABLE tasks ADD COLUMN meta_json TEXT"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)"); } catch {}

// Helpers
export function uuidv4(): string {
  return crypto.randomUUID();
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// ──────────────────────────────────────────────────────────────────
// Round-6 A1 — Password hashing: salted scrypt with lazy migration
//
// Format: `scrypt$<N>$<salt-b64>$<hash-b64>`
//   N        = log2(cost). E.g. 14 → 2^14 = 16384 (~50ms on modern hw).
//   salt-b64 = base64 of 16 random bytes.
//   hash-b64 = base64 of 64-byte scrypt output.
//
// Why scrypt: Node built-in crypto.scryptSync — zero new deps.
//   Memory-hard, ASIC-resistant. Better than bcrypt under modern GPU
//   attack. argon2id would be marginally better but pulls a native
//   dep (argon2 npm package) we don't want on the hub.
//
// Why "$" delimiter: legacy hashes are bare hex (0-9a-f only). Any
//   "$" in stored hash means new format. Trivial detect with zero
//   false-positives.
//
// Lazy migration:
//   - register/bootstrap/changePassword/resetUserPassword always
//     write the new format.
//   - login + changePassword (old-verify) accept BOTH formats.
//   - on successful login against a legacy hash, the caller rehashes
//     in place. Zero downtime, no forced password change.
//
// See feedback_assume_unit_before_threshold.md: explicit-set
// crypto parameters; don't rely on library defaults.
// ──────────────────────────────────────────────────────────────────

import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";

// Default cost parameter (N = 2^14 = 16384). Tunable via env for
// test suites that don't want to spend ~50ms per scrypt call.
//   N=10 → 2^10 = 1024 iter, ~5ms (test-only)
//   N=14 → 2^14 = 16384 iter, ~50ms (production)
//   N=15 → 2^15 = 32768 iter, ~100ms (if hw improves and ops want headroom)
const DEFAULT_SCRYPT_N = 14;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;
// Bun's scrypt defaults maxmem to ~32 MiB which is too tight for
// N ≥ 14 (128 * r * 2^N = ~16 MiB at r=8, N=14; default has no
// headroom for the internal buffers). Set explicitly so a higher-N
// upgrade later doesn't suddenly throw at runtime.
const SCRYPT_MAXMEM = 128 * 1024 * 1024; // 128 MiB

function getScryptN(): number {
  const raw = process.env.COMMHUB_SCRYPT_N;
  if (!raw) return DEFAULT_SCRYPT_N;
  const n = parseInt(raw, 10);
  // Bound: 8 (way-too-weak, only for unit tests) — 20 (DoS risk).
  if (!Number.isFinite(n) || n < 8 || n > 20) return DEFAULT_SCRYPT_N;
  return n;
}

export function hashPassword(plain: string): string {
  const N = getScryptN();
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(plain, salt, SCRYPT_KEYLEN, {
    N: 1 << N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
  return `scrypt$${N}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

/**
 * Verify a plaintext password against the stored hash. Accepts BOTH
 * the new scrypt format and the legacy bare-hex SHA-256 format
 * (back-compat for pre-A1 deployments).
 *
 * Returns:
 *   ok           — true iff the password matches.
 *   needsRehash  — true iff the stored hash was legacy format AND the
 *                  password matched. The caller MUST rehash and write
 *                  the new format back to disk so the legacy hash
 *                  stops existing. Returned false for already-new
 *                  hashes (no rehash needed even on N upgrade —
 *                  follow-up if/when we bump default N).
 */
export function verifyPassword(plain: string, stored: string): { ok: boolean; needsRehash: boolean } {
  // Format detection: new format always contains "$". Legacy bare
  // sha256 hex never does (0-9a-f only).
  if (stored.includes("$")) {
    const parts = stored.split("$");
    if (parts.length !== 4 || parts[0] !== "scrypt") {
      // Unknown new-style scheme — be conservative, reject.
      return { ok: false, needsRehash: false };
    }
    const N = parseInt(parts[1], 10);
    if (!Number.isFinite(N) || N < 8 || N > 20) return { ok: false, needsRehash: false };
    let saltBuf: Buffer;
    let expectedBuf: Buffer;
    try {
      saltBuf = Buffer.from(parts[2], "base64");
      expectedBuf = Buffer.from(parts[3], "base64");
    } catch {
      return { ok: false, needsRehash: false };
    }
    if (expectedBuf.length === 0) return { ok: false, needsRehash: false };
    let actualBuf: Buffer;
    try {
      actualBuf = scryptSync(plain, saltBuf, expectedBuf.length, {
        N: 1 << N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM,
      });
    } catch {
      return { ok: false, needsRehash: false };
    }
    // timingSafeEqual requires equal-length buffers; we sized actual
    // to expected.length above so this is safe.
    const ok = timingSafeEqual(actualBuf, expectedBuf);
    return { ok, needsRehash: false };
  }

  // Legacy bare-hex SHA-256 format (pre-A1).
  const legacy = new Bun.CryptoHasher("sha256").update(`anet:${plain}`).digest("hex");
  // Use timingSafeEqual on byte buffers (hex strings would be
  // compared via JS === which is variable-time on first-differing
  // char — the timing leak is tiny for fixed-format hex but pin the
  // habit). Both are exactly 64 hex chars when sha256 produced.
  if (stored.length !== legacy.length) {
    // Length mismatch is itself indistinguishable from a parse miss
    // — but we still pay the scrypt to keep this branch's timing
    // peer to the verify branches below.
    burnEqualTimeScrypt(plain);
    return { ok: false, needsRehash: false };
  }
  let ok = false;
  try {
    ok = timingSafeEqual(Buffer.from(stored, "hex"), Buffer.from(legacy, "hex"));
  } catch {
    burnEqualTimeScrypt(plain);
    return { ok: false, needsRehash: false };
  }
  // Timing-oracle close (round-6 round-2 — independent reviewer flag):
  // legacy-OK   path callers (auth.ts:login) do `hashPassword(password)`
  //             immediately after to rehash → one scrypt cost on top of
  //             this function's return. ~50ms.
  // legacy-WRONG path callers reject and return → ZERO additional cost.
  //
  // That asymmetry leaks "is this user on the legacy hash" via wall-
  // clock difference (sub-ms wrong vs ~50ms ok). To close it, burn an
  // equal-time scrypt on the wrong-password branch too. Now both
  // legacy paths cost SHA-256 + one scrypt, matching new-format paths
  // and the missing-user dummy-scrypt path.
  if (!ok) {
    burnEqualTimeScrypt(plain);
  }
  return { ok, needsRehash: ok };
}

// Round-6 round-2 hardening — throwaway scrypt to equalize timing on
// failure paths. Burns the same wall-clock cost as a real
// hashPassword() call. Result discarded; salt is a fresh random so
// the work is real (not optimised away). Cost ~N=14 → 50ms,
// COMMHUB_SCRYPT_N controlled like the real path.
function burnEqualTimeScrypt(plain: string): void {
  try {
    const N = getScryptN();
    scryptSync(plain, randomBytes(SCRYPT_SALT_BYTES), SCRYPT_KEYLEN, {
      N: 1 << N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: SCRYPT_MAXMEM,
    });
  } catch {
    // Even on failure to scrypt (shouldn't happen), don't surface —
    // this is a timing pacer, not a correctness path.
  }
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return `atok_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function generateUserToken(): string {
  return `utok_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function generateNetworkToken(): string {
  return `ntok_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function logAudit(userId: string | null, username: string | null, action: string, targetType?: string, targetId?: string, detail?: string, ip?: string, networkId?: string) {
  try {
    db.run(
      "INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, ip, network_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [userId, username, action, targetType ?? null, targetId ?? null, detail ?? null, ip ?? null, networkId ?? null]
    );
  } catch {}
}

// Auto-chain a sub-task's reply up to the parent task lineage so the original
// requester sees the final answer even if the intermediate session timed out.
//
// Why: 链路 admin → 指挥室 → 主编. 主编 finishes 5min later, but 指挥室's
// session has already ended (replied with 'still working'). Without lineage,
// 主编's reply just sits in 指挥室's inbox unread and admin never gets the
// answer.
//
// What we do: when a child task with parent_task_id reaches a terminal state,
// append the child reply to the parent task's result, bump parent status to
// 'replied' if it's still open, and post an inbox notification to the parent's
// originator (so an upstream agent or the dashboard sees the chained answer).
// Recurse up the chain (in case of N hops).
/**
 * Auto-chain a sub-task reply up to the parent task lineage.
 *
 * `callerNetId` (round5 F2 fix): the network the *caller* (send_reply
 * / report_completion) is operating in. When supplied, the chain
 * refuses to traverse into a parent whose `network_id` doesn't match —
 * blocks cross-tenant write where network B replies to a task they've
 * named as parent but which actually lives in network A.
 *
 * Callers that legitimately need the legacy network-blind behavior
 * (e.g. server-internal bookkeeping that doesn't have a tenant
 * context) can omit `callerNetId`, but every MCP tool path MUST
 * supply it.
 *
 * Returns `{ chained, stoppedReason? }` so the caller can gate its
 * follow-up SSE push on whether the chain actually wrote (round-2
 * fix per #275 follow-up, 通信牛 catch): even when the WRITE was
 * refused, callers were still running `SELECT parent.from_name;
 * pushEvent(parent.from_name, { parent_task_id }, callerNetId)` —
 * leaking the foreign parent's task_id into the caller's network
 * via the SSE payload. Now the caller checks `result.chained` before
 * pushing the chained_reply event.
 */
export type ChainReplyResult = {
  /** True iff this call actually wrote into at least one parent row.
   *  When false, callers MUST NOT push SSE events for parent
   *  listeners — the chain would otherwise leak the foreign parent's
   *  identifiers into the caller's network. */
  chained: boolean;
  /** Optional reason the chain stopped short. Today the only enforced
   *  reason is `cross_network`; future reasons (max-depth, parent-
   *  archived, etc.) can land here without breaking callers. */
  stoppedReason?: "cross_network";
};

export function chainReplyToParent(
  childTaskId: string,
  replyText: string,
  replyStatus: "replied" | "failed" | "cancelled" = "replied",
  maxDepth = 5,
  callerNetId?: string | null,
): ChainReplyResult {
  let currentChildId: string | null = childTaskId;
  let currentReply = replyText;
  let depth = 0;
  let chained = false;
  // Normalize so undefined ("don't enforce") stays distinct from
  // null ("explicit default network"). Caller passes undefined to
  // opt out of the cross-tenant check; null to require the parent
  // also live in the default (null) network.
  const enforce = callerNetId !== undefined;
  const callerNorm = callerNetId ?? null;

  while (currentChildId && depth < maxDepth) {
    depth++;
    type ChildRow = { parent_task_id: string | null; to_name: string; from_name: string; content: string };
    type ParentRow = { task_id: string; from_name: string; to_name: string; status: string; result: string | null; network_id: string | null; parent_task_id: string | null };
    const child: ChildRow | null = db.get<ChildRow>(
      "SELECT parent_task_id, to_name, from_name, content FROM tasks WHERE task_id = ?1",
      currentChildId
    );
    if (!child?.parent_task_id) return { chained };
    const parent: ParentRow | null = db.get<ParentRow>(
      "SELECT task_id, from_name, to_name, status, result, network_id, parent_task_id FROM tasks WHERE task_id = ?1",
      child.parent_task_id
    );
    if (!parent) return { chained };

    // round5 F2 fix: refuse to write into a parent that lives in a
    // different network than the caller. Stops chain-reply being a
    // cross-tenant write primitive. Logs once per attempt so ops can
    // see the rejection in the access log.
    if (enforce) {
      const parentNet = parent.network_id ?? null;
      if (parentNet !== callerNorm) {
        console.log(`[commhub] 🚫 chainReplyToParent cross-network blocked: parent=${parent.task_id.slice(0, 8)} parent-net=${parentNet ?? "null"} caller-net=${callerNorm ?? "null"}`);
        return { chained, stoppedReason: "cross_network" };
      }
    }

    const childAlias = child.to_name;
    const marker = `\n\n[via ${childAlias} 子任务结果]\n${currentReply}`;
    const newResult = parent.result ? parent.result + marker : `[via ${childAlias} 子任务结果]\n${currentReply}`;

    // Bump parent status to replied if still open. If it was already replied
    // (e.g. 指挥室 sent an early status update), we still want to update the
    // result so the dashboard can render the final chained answer — but keep
    // status as replied (it was already terminal).
    if (parent.status === "delivered" || parent.status === "acked" || parent.status === "running" || parent.status === "created") {
      db.run(
        "UPDATE tasks SET status = ?1, result = ?2, completed_at = datetime('now') WHERE task_id = ?3",
        [replyStatus, newResult.slice(0, 8000), parent.task_id]
      );
      logTaskEvent(parent.task_id, parent.status, replyStatus, "auto-chain", `from ${childAlias}`);
    } else {
      db.run(
        "UPDATE tasks SET result = ?1, completed_at = datetime('now') WHERE task_id = ?2",
        [newResult.slice(0, 8000), parent.task_id]
      );
      logTaskEvent(parent.task_id, parent.status, parent.status, "auto-chain-append", `from ${childAlias}`);
    }

    if (parent.from_name && parent.from_name !== "hub" && parent.from_name !== "api") {
      try {
        const notifyId = `chain_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
        const notifyNode = db.get<{ node_id: string | null }>(
          "SELECT node_id FROM sessions WHERE alias = ?1 AND COALESCE(network_id, 'default') = COALESCE(?2, 'default') ORDER BY updated_at DESC LIMIT 1",
          [parent.from_name, parent.network_id ?? null]
        );
        db.run(
          `INSERT INTO inbox (id, session_name, node_id, type, priority, content, from_session, in_reply_to, requires_response, network_id)
           VALUES (?1, ?2, ?3, 'reply', 'normal', ?4, ?5, ?6, 'none', ?7)`,
          [notifyId, parent.from_name, notifyNode?.node_id ?? null, `[${childAlias} 子任务完成]\n${currentReply.slice(0, 4000)}`, parent.to_name, parent.task_id, parent.network_id ?? null]
        );
      } catch {}
    }

    // This iteration actually wrote a parent row (and possibly an
    // inbox notification). Record that so the caller can gate its
    // SSE push on a real chain.
    chained = true;

    // Recurse up the chain.
    currentChildId = parent.task_id;
    currentReply = newResult;
  }
  return { chained };
}

export function logTaskEvent(taskId: string, fromStatus: string | null, toStatus: string, actor: string, detail?: string) {
  try {
    db.run(
      `INSERT INTO task_events (task_id, from_status, to_status, actor, detail, network_id)
       VALUES (?1, ?2, ?3, ?4, ?5, (SELECT network_id FROM tasks WHERE task_id = ?1))`,
      [taskId, fromStatus, toStatus, actor, detail ?? null]
    );
  } catch {}
}
