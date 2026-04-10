import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";

const DB_PATH = process.env.COMMHUB_DB || `${process.env.HOME}/.commhub/commhub.db`;
mkdirSync(dirname(DB_PATH), { recursive: true });

console.log(`[commhub] database: ${DB_PATH}`);
export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode=WAL");
db.exec("PRAGMA busy_timeout=5000");

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    resume_id     TEXT PRIMARY KEY,
    alias         TEXT UNIQUE,
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
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
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
    completed_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ── V2 schema migration (ALTER TABLE, safe to re-run) ──

// sessions: add node_id, session_id, config_path, channels, last_seen_at
for (const col of [
  { name: "node_id", def: "TEXT" },
  { name: "session_id", def: "TEXT" },
  { name: "config_path", def: "TEXT" },
  { name: "channels", def: "TEXT" },
  { name: "last_seen_at", def: "TEXT" },
]) {
  try { db.exec(`ALTER TABLE sessions ADD COLUMN ${col.name} ${col.def}`); } catch {}
}

// inbox: add in_reply_to, requires_response, expires_at, scope
for (const col of [
  { name: "in_reply_to", def: "TEXT" },
  { name: "requires_response", def: "TEXT DEFAULT 'reply'" },
  { name: "expires_at", def: "TEXT" },
  { name: "scope", def: "TEXT DEFAULT 'single'" },
]) {
  try { db.exec(`ALTER TABLE inbox ADD COLUMN ${col.name} ${col.def}`); } catch {}
}

// indexes for new columns
try { db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_type ON inbox(type)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_from ON inbox(from_session)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_inbox_reply ON inbox(in_reply_to)"); } catch {}
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
const existingLicense = db.query<any, []>("SELECT id FROM licenses LIMIT 1").get();
if (!existingLicense) {
  const trialId = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  db.run(
    "INSERT INTO licenses (id, license_key, type, expires_at) VALUES (?1, ?2, 'trial', datetime('now', '+14 days'))",
    [`lic_${trialId}`, `trial-${trialId}`]
  );
  console.log("[commhub] 🎉 14-day free trial started!");
}

// ── V3: add network_id to existing tables ──
for (const table of ["sessions", "nodes", "tasks", "inbox", "task_events"]) {
  try { db.exec(`ALTER TABLE ${table} ADD COLUMN network_id TEXT`); } catch {}
}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_network ON sessions(network_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_network ON tasks(network_id)"); } catch {}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_nodes_network ON nodes(network_id)"); } catch {}

// Helpers
export function uuidv4(): string {
  return crypto.randomUUID();
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

export function hashPassword(password: string): string {
  return new Bun.CryptoHasher("sha256").update(`anet:${password}`).digest("hex");
}

export function hashToken(token: string): string {
  return new Bun.CryptoHasher("sha256").update(token).digest("hex");
}

export function generateToken(): string {
  return `atok_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function logAudit(userId: string | null, username: string | null, action: string, targetType?: string, targetId?: string, detail?: string, ip?: string, networkId?: string) {
  try {
    db.run(
      "INSERT INTO audit_log (user_id, username, action, target_type, target_id, detail, ip, network_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      [userId, username, action, targetType ?? null, targetId ?? null, detail ?? null, ip ?? null, networkId ?? null]
    );
  } catch {}
}

export function logTaskEvent(taskId: string, fromStatus: string | null, toStatus: string, actor: string, detail?: string) {
  try {
    db.run(
      "INSERT INTO task_events (task_id, from_status, to_status, actor, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
      [taskId, fromStatus, toStatus, actor, detail ?? null]
    );
  } catch {}
}
