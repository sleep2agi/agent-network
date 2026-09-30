/**
 * Database Adapter — supports SQLite and PostgreSQL
 *
 * SQLite adapter: wraps bun:sqlite (sync)
 * PostgreSQL adapter: wraps pg Pool (async, bridged to sync interface via blocking)
 *
 * Key design: callers write SQLite-style SQL. PgAdapter auto-translates:
 *   - ?1, ?2  →  $1, $2
 *   - datetime('now'[, offset])  →  to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
 *     (timestamps stay TEXT on both backends, RFC-039 §4.1)
 *   - BLOB  →  BYTEA
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

  close(): void {
    this.rawDb.close();
  }
}

// ════════════════════════════════════════════
//  PostgreSQL Adapter (pg Pool, sync bridge)
// ════════════════════════════════════════════

/**
 * PostgreSQL expression for SQLite's `datetime(...)` text: UTC, `YYYY-MM-DD HH:MM:SS`.
 * Timestamps stay TEXT on both backends (RFC-039 §4.1), so a column written by
 * `datetime('now')` compares, sorts and serialises the same way on each.
 */
function pgUtcText(expr: string): string {
  return `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`;
}

/**
 * Translate SQLite-style SQL to PostgreSQL.
 * Called on every query — must be fast (simple regex, no parsing).
 */
export function sqliteToPostgres(sql: string): string {
  let s = sql;
  // ── datetime translations (before ?N→$N to handle datetime('now', ?N)) ──
  // datetime('now', ?N) → UTC text of NOW() + $N  (param contains "+3600 seconds").
  // The CAST gives PG a type for a parameter it could not otherwise infer.
  s = s.replace(/datetime\s*\(\s*'now'\s*,\s*\?(\d+)\s*\)/gi, (_, n) => {
    return pgUtcText(`NOW() + CAST($${n} AS TEXT)::INTERVAL`);
  });
  // datetime('now', '+N seconds') → UTC text of NOW() + INTERVAL 'N seconds'
  s = s.replace(/datetime\s*\(\s*'now'\s*,\s*'([^']+)'\s*\)/gi, (_, offset) => {
    return pgUtcText(`NOW() + INTERVAL '${offset.replace(/^\+/, "")}'`);
  });
  // datetime('now') → UTC text of NOW()
  s = s.replace(/datetime\s*\(\s*'now'\s*\)/gi, pgUtcText("NOW()"));
  // ── Parameter placeholders ──
  // ?1, ?2 → $1, $2  (positional params)
  s = s.replace(/\?(\d+)/g, (_, n) => `$${n}`);
  // Unindexed ? → $N (sequential)
  let idx = 0;
  s = s.replace(/\?(?!\d)/g, () => `$${++idx}`);
  // ── DDL translations ──
  // INTEGER PRIMARY KEY AUTOINCREMENT → SERIAL PRIMARY KEY
  s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "SERIAL PRIMARY KEY");
  // BLOB → BYTEA
  s = s.replace(/\bBLOB\b/gi, "BYTEA");
  return s;
}

/**
 * Split a multi-statement script on top-level `;`.
 *
 * A bare `split(";")` cut through SQL comments (db.ts has `;` inside `--`
 * comments) and through plpgsql `$$ … $$` bodies, so the Hub died on its
 * first schema block on PostgreSQL. This skips `--` and `/* *\/` comments
 * (dropping them) and keeps quoted strings, quoted identifiers and
 * dollar-quoted bodies intact.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
      cur += " ";
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (tag) {
        const close = sql.indexOf(tag[0], i + tag[0].length);
        const stop = close < 0 ? n : close + tag[0].length;
        cur += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (c === ";") {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
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
      const{Pool,types}=require('pg');
      types.setTypeParser(20,v=>{const n=Number(v);return Number.isSafeInteger(n)?n:v;});
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
    const stmts = splitSqlStatements(pgSql);
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

  close(): void {}
}

// ════════════════════════════════════════════
//  Factory
// ════════════════════════════════════════════

export type DbTarget =
  | { kind: "postgres"; url: string }
  | { kind: "sqlite"; path: string };

/**
 * Refuse every inherited DATABASE_URL under the Bun test environment before
 * adapter selection, logging, DNS, or construction. A test that intentionally
 * exercises PostgreSQL needs a separately reviewed isolated harness; accepting
 * a shell/CI DATABASE_URL here could connect a unit test to production.
 */
export function assertSafeTestDatabaseEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV === "test" && env.DATABASE_URL) {
    throw new Error(
      "[commhub] REFUSING to honor inherited DATABASE_URL under NODE_ENV=test.\n" +
      "  Tests must unset DATABASE_URL and set COMMHUB_DB to an isolated path.\n" +
      "  This guard is fail-closed and has no opt-in bypass."
    );
  }
}

/**
 * Pure target selection after the inherited-DATABASE_URL safety gate.
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
 * The production default path is a capability, not a generic fallback:
 * only canonical server entrypoints set COMMHUB_SERVER=1 before importing
 * the database graph. Tests, scripts, and `bun -e` probes must name an
 * explicit COMMHUB_DB (or a reviewed PostgreSQL DATABASE_URL), so forgetting
 * one fails before mkdir/open/write instead of touching the live Hub.
 */
function resolveDatabaseTargetAfterGuard(env: NodeJS.ProcessEnv): DbTarget {
  const dbUrl = env.DATABASE_URL;
  if (dbUrl && (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://"))) {
    return { kind: "postgres", url: dbUrl };
  }

  // Test-default-prod GUARD (see docblock above).
  if (env.NODE_ENV === "test" && !env.COMMHUB_DB) {
    throw new Error(
      "[commhub] REFUSING to open the default SQLite database under NODE_ENV=test.\n" +
      "  Tests must explicitly set COMMHUB_DB to a throwaway path so they don't\n" +
      "  pollute the production hub DB. Run tests via:\n" +
      "    COMMHUB_DB=/tmp/test-$$.db bun test src/\n" +
      "  (or use the `npm run test` script which sets this for you)."
    );
  }

  if (!env.COMMHUB_DB && env.COMMHUB_SERVER !== "1") {
    throw new Error(
      "[commhub] REFUSING to open the default production SQLite database from a non-server entrypoint.\n" +
      "  Scripts and probes must set an explicit COMMHUB_DB path. The canonical\n" +
      "  Hub entrypoints set COMMHUB_SERVER=1 before loading the database."
    );
  }

  return { kind: "sqlite", path: env.COMMHUB_DB || `${env.HOME}/.commhub/commhub.db` };
}

/** Pure public resolver used by tests without constructing an adapter. */
export function resolveDatabaseTarget(env: NodeJS.ProcessEnv = process.env): DbTarget {
  assertSafeTestDatabaseEnv(env);
  return resolveDatabaseTargetAfterGuard(env);
}

/**
 * Create the appropriate adapter based on environment.
 * The inherited-DATABASE_URL guard is deliberately the first executable line.
 */
export function createAdapter(): DbAdapter {
  assertSafeTestDatabaseEnv(process.env);
  const target = resolveDatabaseTargetAfterGuard(process.env);
  if (target.kind === "postgres") {
    console.log("[commhub] database: PostgreSQL");
    return new PgAdapter(target.url);
  }

  const { mkdirSync } = require("fs");
  const { dirname } = require("path");
  mkdirSync(dirname(target.path), { recursive: true });
  console.log(`[commhub] database: ${target.path}`);
  const rawDb = new Database(target.path);
  rawDb.exec("PRAGMA journal_mode=WAL");
  rawDb.exec("PRAGMA busy_timeout=5000");
  return new SQLiteAdapter(rawDb);
}
