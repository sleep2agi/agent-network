/**
 * Database Adapter — supports SQLite and PostgreSQL
 *
 * SQLite adapter: wraps bun:sqlite (sync)
 * PostgreSQL adapter: wraps pg Pool (async, bridged to sync interface via blocking)
 *
 * Key design: callers write SQLite-style SQL. PgAdapter auto-translates:
 *   - ?1, ?2  →  $1, $2
 *   - datetime('now')  →  NOW()
 *   - datetime('now', '+N seconds')  →  NOW() + INTERVAL 'N seconds'
 *   - INTEGER PRIMARY KEY AUTOINCREMENT  →  SERIAL PRIMARY KEY
 *   - ON CONFLICT(col) DO UPDATE SET  →  ON CONFLICT(col) DO UPDATE SET  (same syntax)
 */

import { Database } from "bun:sqlite";

export interface QueryResult {
  changes: number;
}

export interface DbAdapter {
  /** Execute a write query (INSERT/UPDATE/DELETE) */
  run(sql: string, params?: any[]): QueryResult;

  /** Query a single row */
  get<T = any>(sql: string, ...params: any[]): T | null;

  /** Query multiple rows */
  all<T = any>(sql: string, ...params: any[]): T[];

  /** Execute raw SQL (DDL) */
  exec(sql: string): void;

  /** Run a function inside a transaction */
  transaction<T>(fn: () => T): T;

  /** Close connection */
  close(): void;

  /** Dialect identifier */
  readonly dialect: "sqlite" | "postgres";
}

// ════════════════════════════════════════════
//  SQLite Adapter (bun:sqlite, sync)
// ════════════════════════════════════════════

export class SQLiteAdapter implements DbAdapter {
  readonly dialect = "sqlite" as const;
  constructor(private readonly rawDb: Database) {}

  run(sql: string, params?: any[]): QueryResult {
    return this.rawDb.run(sql, params as any);
  }

  get<T = any>(sql: string, ...params: any[]): T | null {
    return this.rawDb.query<T, any[]>(sql).get(...params) ?? null;
  }

  all<T = any>(sql: string, ...params: any[]): T[] {
    return this.rawDb.query<T, any[]>(sql).all(...params);
  }

  exec(sql: string): void {
    this.rawDb.exec(sql);
  }

  transaction<T>(fn: () => T): T {
    return this.rawDb.transaction(fn)();
  }

  close(): void {
    this.rawDb.close();
  }
}

// ════════════════════════════════════════════
//  PostgreSQL Adapter (pg Pool, sync bridge)
// ════════════════════════════════════════════

/**
 * Translate SQLite-style SQL to PostgreSQL.
 * Called on every query — must be fast (simple regex, no parsing).
 */
export function sqliteToPostgres(sql: string): string {
  let s = sql;
  // ── datetime translations (before ?N→$N to handle datetime('now', ?N)) ──
  // datetime('now', ?N) → NOW() + $N::INTERVAL  (param contains "+3600 seconds")
  s = s.replace(/datetime\s*\(\s*'now'\s*,\s*\?(\d+)\s*\)/gi, (_, n) => {
    return `NOW() + $${n}::INTERVAL`;
  });
  // datetime('now', '+N seconds') → NOW() + INTERVAL 'N seconds'
  s = s.replace(/datetime\s*\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, (_, offset) => {
    return `NOW() + INTERVAL '${offset.replace(/^\+/, "")}'`;
  });
  // datetime('now') → NOW()
  s = s.replace(/datetime\s*\(\s*'now'\s*\)/gi, "NOW()");
  // TEXT NOT NULL DEFAULT (datetime('now')) → TIMESTAMP NOT NULL DEFAULT NOW()
  s = s.replace(/TEXT\s+NOT\s+NULL\s+DEFAULT\s+\(NOW\(\)\)/gi, "TIMESTAMP NOT NULL DEFAULT NOW()");
  // ── Parameter placeholders ──
  // ?1, ?2 → $1, $2  (positional params)
  s = s.replace(/\?(\d+)/g, (_, n) => `$${n}`);
  // Unindexed ? → $N (sequential)
  let idx = 0;
  s = s.replace(/\?(?!\d)/g, () => `$${++idx}`);
  // ── DDL translations ──
  // INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
  s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "SERIAL PRIMARY KEY");
  return s;
}

/**
 * PostgreSQL adapter using pg Pool.
 *
 * Design: uses synchronous blocking via Bun's subprocess or
 * deasync-style approach. Since Bun MCP handlers are async,
 * we store a pool and use blocking queries via pg's synchronous mode.
 *
 * NOTE: This adapter uses `pg` npm package in synchronous mode.
 * For production, the interface should be async. This sync bridge
 * works for the current codebase where MCP handlers are async
 * but DB calls are sync within them.
 */
export class PgAdapter implements DbAdapter {
  readonly dialect = "postgres" as const;
  private pool: any; // pg.Pool
  private client: any; // dedicated sync client

  constructor(connectionString: string) {
    // Dynamic import of pg — only loaded when DATABASE_URL is set
    try {
      const pg = require("pg");
      this.pool = new pg.Pool({ connectionString, max: 10 });
      // Get a dedicated client for sync operations
      // We use execSync pattern for blocking
    } catch (e) {
      throw new Error(
        "PostgreSQL support requires 'pg' package. Install with: bun add pg\n" +
        `  Original error: ${(e as Error).message}`
      );
    }
  }

  /**
   * Execute a blocking query against PG.
   * Uses Bun's ability to block on promises in sync context.
   */
  private querySync(sql: string, params?: any[]): any {
    const pgSql = sqliteToPostgres(sql);
    // Bun supports top-level await and can block — use a shared promise pattern
    // For sync bridge, we use a worker or subprocess
    // Simplest approach: use pg's synchronous query via dedicated connection
    const result = this._blockingQuery(pgSql, params);
    return result;
  }

  private _blockingQuery(sql: string, params?: any[]): any {
    // Use Bun.spawnSync to run a node script that executes the query
    // This is a pragmatic sync bridge until we migrate to async interface
    const script = `
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL });
      pool.query(${JSON.stringify(sql)}, ${JSON.stringify(params || [])})
        .then(r => { process.stdout.write(JSON.stringify({ rows: r.rows, rowCount: r.rowCount })); pool.end(); })
        .catch(e => { process.stdout.write(JSON.stringify({ error: e.message })); pool.end(); process.exit(1); });
    `;
    const proc = Bun.spawnSync(["node", "-e", script], {
      env: { ...process.env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = proc.stdout.toString().trim();
    if (proc.exitCode !== 0) {
      const errOut = proc.stderr.toString().trim();
      throw new Error(`PG query failed: ${errOut || out}`);
    }
    return JSON.parse(out);
  }

  run(sql: string, params?: any[]): QueryResult {
    if (sql.trim().toUpperCase().startsWith("PRAGMA")) {
      return { changes: 0 }; // Skip SQLite PRAGMAs
    }
    const result = this.querySync(sql, params);
    return { changes: result.rowCount ?? 0 };
  }

  get<T = any>(sql: string, ...params: any[]): T | null {
    const result = this.querySync(sql, params.length > 0 ? params : undefined);
    return (result.rows?.[0] as T) ?? null;
  }

  all<T = any>(sql: string, ...params: any[]): T[] {
    const result = this.querySync(sql, params.length > 0 ? params : undefined);
    return (result.rows as T[]) ?? [];
  }

  exec(sql: string): void {
    if (sql.trim().toUpperCase().startsWith("PRAGMA")) return; // Skip
    // Split multiple statements and execute each
    const statements = sql.split(";").map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of statements) {
      this.querySync(stmt);
    }
  }

  transaction<T>(fn: () => T): T {
    this.querySync("BEGIN");
    try {
      const result = fn();
      this.querySync("COMMIT");
      return result;
    } catch (e) {
      try { this.querySync("ROLLBACK"); } catch {}
      throw e;
    }
  }

  close(): void {
    try { this.pool?.end(); } catch {}
  }
}

// ════════════════════════════════════════════
//  Factory
// ════════════════════════════════════════════

/**
 * Create the appropriate adapter based on environment.
 * - DATABASE_URL starts with "postgres://" → PgAdapter
 * - Otherwise → SQLiteAdapter with COMMHUB_DB or default path
 */
export function createAdapter(): DbAdapter {
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://"))) {
    console.log("[commhub] database: PostgreSQL");
    return new PgAdapter(dbUrl);
  }
  // Default: SQLite
  const { mkdirSync } = require("fs");
  const { dirname } = require("path");
  const dbPath = process.env.COMMHUB_DB || `${process.env.HOME}/.commhub/commhub.db`;
  mkdirSync(dirname(dbPath), { recursive: true });
  console.log(`[commhub] database: ${dbPath}`);
  const rawDb = new Database(dbPath);
  rawDb.exec("PRAGMA journal_mode=WAL");
  rawDb.exec("PRAGMA busy_timeout=5000");
  return new SQLiteAdapter(rawDb);
}
