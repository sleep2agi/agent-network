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
        network_id    TEXT NOT NULL DEFAULT 'default',
        UNIQUE (network_id, alias)
      )
    `);
    db.exec(`
      INSERT OR REPLACE INTO sessions_migrated (
        resume_id, alias, tmux_name, server, ip, hostname, agent, project_dir, version,
        status, task, output, progress, score, registered_at, updated_at, node_id,
        session_id, config_path, channels, last_seen_at, network_id
      )
      SELECT
        resume_id, alias, tmux_name, server, ip, hostname, agent, project_dir, version,
        status, task, output, progress, score, registered_at, updated_at, node_id,
        session_id, config_path, channels, last_seen_at,
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
try { db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)"); } catch {}

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
export function chainReplyToParent(childTaskId: string, replyText: string, replyStatus: "replied" | "failed" | "cancelled" = "replied", maxDepth = 5): void {
  let currentChildId: string | null = childTaskId;
  let currentReply = replyText;
  let depth = 0;
  while (currentChildId && depth < maxDepth) {
    depth++;
    type ChildRow = { parent_task_id: string | null; to_name: string; from_name: string; content: string };
    type ParentRow = { task_id: string; from_name: string; to_name: string; status: string; result: string | null; network_id: string | null; parent_task_id: string | null };
    const child: ChildRow | null = db.get<ChildRow>(
      "SELECT parent_task_id, to_name, from_name, content FROM tasks WHERE task_id = ?1",
      currentChildId
    );
    if (!child?.parent_task_id) return;
    const parent: ParentRow | null = db.get<ParentRow>(
      "SELECT task_id, from_name, to_name, status, result, network_id, parent_task_id FROM tasks WHERE task_id = ?1",
      child.parent_task_id
    );
    if (!parent) return;

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
        db.run(
          `INSERT INTO inbox (id, session_name, type, priority, content, from_session, in_reply_to, requires_response, network_id)
           VALUES (?1, ?2, 'reply', 'normal', ?3, ?4, ?5, 'none', ?6)`,
          [notifyId, parent.from_name, `[${childAlias} 子任务完成]\n${currentReply.slice(0, 4000)}`, parent.to_name, parent.task_id, parent.network_id ?? null]
        );
      } catch {}
    }

    // Recurse up the chain.
    currentChildId = parent.task_id;
    currentReply = newResult;
  }
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
