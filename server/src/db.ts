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

// Helpers
export function uuidv4(): string {
  return crypto.randomUUID();
}
