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

export const ATOMIC_QUEUE_TRANSACTIONS_UNAVAILABLE =
  "atomic_queue_transactions_unavailable" as const;

/** Raised before queue SQL when the adapter cannot pin one immediate transaction. */
export class AtomicQueueTransactionsUnavailableError extends Error {
  readonly code = ATOMIC_QUEUE_TRANSACTIONS_UNAVAILABLE;
  readonly httpStatus = 503;

  constructor() {
    super(ATOMIC_QUEUE_TRANSACTIONS_UNAVAILABLE);
    this.name = "AtomicQueueTransactionsUnavailableError";
  }
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

  /** Queue mutations require this exact capability before their first SQL. */
  readonly atomicQueueTransactions: "same_connection_immediate" | "unavailable";

  /** Acquire the SQLite write lock before the transaction's first read. */
  immediateTransaction<T>(fn: () => T): T;

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
  readonly atomicQueueTransactions = "same_connection_immediate" as const;
  constructor(private readonly rawDb: Database) {}

  run(sql: string, params?: any[]): QueryResult {
    return params ? this.rawDb.run(sql, params as any) : this.rawDb.run(sql);
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

  immediateTransaction<T>(fn: () => T): T {
    return this.rawDb.transaction(fn).immediate();
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
 * PostgreSQL adapter using a synchronous subprocess bridge.
 *
 * TODO(P0-4): this is not transaction-safe. querySync currently starts a
 * fresh `node -e` process for every statement, so BEGIN/COMMIT/ROLLBACK do
 * not share one backend connection. PostgreSQL support is demoted behind
 * SQLite for now; before advertising it as production-ready, replace this
 * bridge with a long-lived worker or make DbAdapter async and use pg directly.
 */
export class PgAdapter implements DbAdapter {
  readonly dialect = "postgres" as const;
  readonly atomicQueueTransactions = "unavailable" as const;
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
    // Not atomic for PostgreSQL until P0-4 is implemented; see class TODO.
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

  immediateTransaction<T>(_fn: () => T): T {
    // The subprocess bridge uses a different PostgreSQL connection per query.
    // Refuse before invoking fn, hence before any queue SQL can occur.
    throw new AtomicQueueTransactionsUnavailableError();
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
 *
 * Test-default-prod GUARD: when `NODE_ENV === "test"` (set automatically by
 * `bun test`) AND `COMMHUB_DB` is unset, we REFUSE to fall through to the
 * default `~/.commhub/commhub.db` path. Several modules (notably
 * `server/src/auth.ts register()`) write into the configured database at
 * import-time-side-effect granularity; running their tests against the
 * production hub DB silently created spurious users / networks / tokens
 * on 2026-06-23 (4u / 4net / 8tok by one `bun -e` probe + an unknown
 * pre-existing history of test pollution in the same DB). The guard makes
 * the failure mode loud + actionable instead of silent + destructive.
 *
 * The guard does NOT fire when:
 *   - COMMHUB_DB is set (the test runner's documented contract); or
 *   - NODE_ENV is unset (production server) or any non-"test" value.
 *
 * Operators who run `bun -e` snippets that touch the DB are expected to
 * `COMMHUB_DB=/tmp/...` themselves — `bun -e` doesn't set NODE_ENV, so the
 * guard can't catch that case. The rule (never read or write the
 * production hub database) is documented in CLAUDE.md.
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

  // Test-default-prod GUARD (see docblock above).
  if (process.env.NODE_ENV === "test" && !process.env.COMMHUB_DB) {
    throw new Error(
      "[commhub] REFUSING to open the default SQLite database under NODE_ENV=test.\n" +
      "  Tests must explicitly set COMMHUB_DB to a throwaway path so they don't\n" +
      "  pollute the production hub DB. Run tests via:\n" +
      "    COMMHUB_DB=/tmp/test-$$.db bun test src/\n" +
      "  (or use the `npm run test` script which sets this for you)."
    );
  }

  const dbPath = process.env.COMMHUB_DB || `${process.env.HOME}/.commhub/commhub.db`;
  mkdirSync(dirname(dbPath), { recursive: true });
  console.log(`[commhub] database: ${dbPath}`);
  const rawDb = new Database(dbPath);
  rawDb.exec("PRAGMA journal_mode=WAL");
  rawDb.exec("PRAGMA busy_timeout=5000");
  return new SQLiteAdapter(rawDb);
}
