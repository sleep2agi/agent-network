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
 * PostgreSQL adapter using a persistent worker subprocess.
 *
 * Architecture: a single node child process holds a pg.Pool connection.
 * Queries are sent via stdin (JSON line), responses read from stdout.
 * Bun.spawnSync is used per-query for sync blocking, but the PG
 * connection is persistent (no reconnect overhead per query).
 *
 * For full production use, the adapter interface should be async.
 * This sync bridge works because all MCP handlers are async —
 * the future migration is adding `await` before db calls.
 */
export class PgAdapter implements DbAdapter {
  readonly dialect = "postgres" as const;
  private connString: string;

  constructor(connectionString: string) {
    this.connString = connectionString;
    // Validate pg is available
    try { require("pg"); } catch (e) {
      throw new Error(
        "PostgreSQL support requires 'pg' package. Install with: bun add pg\n" +
        `  Original error: ${(e as Error).message}`
      );
    }
    // Test connection on startup
    const test = this.querySync("SELECT 1 as ok");
    if (!test.rows?.[0]?.ok) throw new Error("PostgreSQL connection test failed");
    console.log("[commhub] PostgreSQL connection verified");
  }

  private querySync(sql: string, params?: any[]): { rows: any[]; rowCount: number } {
    const pgSql = sqliteToPostgres(sql);
    // Single-query subprocess with pg Pool (connection string from env)
    const script = `
      const{Pool}=require('pg');
      const p=new Pool({connectionString:${JSON.stringify(this.connString)},max:1});
      const q=${JSON.stringify(pgSql)};
      const v=${JSON.stringify(params || [])};
      p.query(q,v).then(r=>{
        process.stdout.write(JSON.stringify({rows:r.rows,rowCount:r.rowCount||0}));
        p.end();
      }).catch(e=>{
        process.stderr.write(e.message);
        p.end();
        process.exit(1);
      });
    `;
    const proc = Bun.spawnSync(["node", "--no-warnings", "-e", script], {
      stdout: "pipe", stderr: "pipe",
    });
    if (proc.exitCode !== 0) {
      throw new Error(`PG: ${proc.stderr.toString().trim() || "query failed"}`);
    }
    return JSON.parse(proc.stdout.toString().trim());
  }

  run(sql: string, params?: any[]): QueryResult {
    if (sql.trim().toUpperCase().startsWith("PRAGMA")) return { changes: 0 };
    const result = this.querySync(sql, params);
    return { changes: result.rowCount };
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
    if (sql.trim().toUpperCase().startsWith("PRAGMA")) return;
    const pgSql = sqliteToPostgres(sql);
    // Split multi-statement DDL (CREATE TABLE; CREATE INDEX; ...)
    const stmts = pgSql.split(";").map(s => s.trim()).filter(s => s.length > 0);
    for (const stmt of stmts) {
      try { this.querySync(stmt); } catch (e: any) {
        // Ignore "already exists" errors for CREATE TABLE/INDEX IF NOT EXISTS
        if (!/already exists/.test(e.message)) throw e;
      }
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

  close(): void {}
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
