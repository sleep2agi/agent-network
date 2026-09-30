/**
 * Database Adapter — supports SQLite and PostgreSQL
 *
 * SQLite adapter: wraps bun:sqlite (sync)
 * PostgreSQL adapter: one Bun.SQL connection in a worker thread, bridged to the
 *   sync interface with Atomics.wait (pg-worker.ts)
 *
 * Key design: callers write SQLite-style SQL. PgAdapter auto-translates:
 *   - ?1, ?2  →  $1, $2
 *   - datetime('now'[, offset])  →  to_char(... AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
 *     (timestamps stay TEXT on both backends, RFC-039 §4.1)
 *   - BLOB  →  BYTEA
 *   - INTEGER PRIMARY KEY AUTOINCREMENT  →  BIGSERIAL PRIMARY KEY; INTEGER  →  BIGINT
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

  /** True when transaction() is all-or-nothing on one connection. */
  readonly atomicTransactions: boolean;

  /**
   * Why features that need atomic transactions (scheduler, runtime evidence,
   * side-thread command outbox) must stay off on this adapter, or null when
   * they may run. Gates refuse on anything but null, so an adapter that does
   * not implement this also refuses.
   */
  readonly transactionalFeaturesRefusal: string | null;
}

/** RFC-039: opt-in for PostgreSQL features whose PG tests do not exist yet (S4). */
export const PG_EXPERIMENTAL_ENV = "COMMHUB_PG_EXPERIMENTAL";

// ════════════════════════════════════════════
//  SQLite Adapter (bun:sqlite, sync)
// ════════════════════════════════════════════

export class SQLiteAdapter implements DbAdapter {
  readonly dialect = "sqlite" as const;
  readonly atomicTransactions = true;
  get transactionalFeaturesRefusal(): string | null {
    return this.atomicTransactions ? null : "transactions on this adapter are not atomic";
  }
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
  // INTEGER PRIMARY KEY AUTOINCREMENT → BIGSERIAL PRIMARY KEY
  s = s.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, "BIGSERIAL PRIMARY KEY");
  // INTEGER → BIGINT: SQLite integers are 64-bit, and the Hub stores epoch
  // milliseconds in INTEGER columns (a 32-bit PG integer overflows).
  s = s.replace(/\bINTEGER\b/gi, "BIGINT");
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
 * PostgreSQL adapter: synchronous facade over one long-lived worker thread
 * (RFC-039 S2b).
 *
 * The worker (pg-worker.ts) holds a single reserved Bun.SQL connection. Each
 * call posts one request and blocks on Atomics.wait until the worker answers,
 * so the DbAdapter interface stays synchronous — the same contract bun:sqlite
 * gives the rest of the Hub, including "nothing else runs while a transaction
 * is open". Because every statement uses the same backend connection,
 * BEGIN/COMMIT/ROLLBACK are real transactions.
 *
 * SQLite semantics kept on purpose:
 *   - a failed statement inside a transaction does not poison the transaction
 *     (each statement inside one runs under a savepoint);
 *   - nested transaction() calls become savepoints;
 *   - booleans bind as 1/0 and undefined as NULL.
 */
export class PgAdapter implements DbAdapter {
  readonly dialect = "postgres" as const;
  readonly atomicTransactions = true;
  /** Closed by default on PG even with real transactions: explicit opt-in only. */
  get transactionalFeaturesRefusal(): string | null {
    if (!this.atomicTransactions) return "transactions on this adapter are not atomic";
    if (process.env[PG_EXPERIMENTAL_ENV] === "1") return null;
    return `PostgreSQL support is experimental; set ${PG_EXPERIMENTAL_ENV}=1 to enable this feature on it (RFC-039)`;
  }
  private readonly port: MessagePort;
  private readonly flag: Int32Array;
  private readonly worker: import("node:worker_threads").Worker;
  private readonly waitMs: number;
  private txDepth = 0;

  constructor(connectionString: string) {
    const { Worker, MessageChannel } = require("node:worker_threads") as typeof import("node:worker_threads");
    const statementTimeoutMs = Number(process.env.COMMHUB_PG_STATEMENT_TIMEOUT_MS || 30_000);
    // The main thread waits a little longer than PG itself will run a statement.
    this.waitMs = statementTimeoutMs > 0 ? statementTimeoutMs + 5_000 : 300_000;
    const { port1, port2 } = new MessageChannel();
    this.port = port1 as unknown as MessagePort;
    this.flag = new Int32Array(new SharedArrayBuffer(4));
    this.worker = new Worker(new URL("./pg-worker.ts", import.meta.url), {
      workerData: { port: port2, flag: this.flag, url: connectionString, statementTimeoutMs },
      transferList: [port2 as any],
    });
    this.worker.unref();
    (port1 as any).unref?.();
    // Test connection on startup
    const test = this.request("SELECT 1 as ok");
    if (!test.rows?.[0]?.ok) throw new Error("PostgreSQL connection test failed");
    console.log("[commhub] PostgreSQL connection verified");
  }

  /** Send one already-translated statement to the worker and block for the answer. */
  private request(pgSql: string, params?: any[]): { rows: any[]; count: number } {
    const { receiveMessageOnPort } = require("node:worker_threads") as typeof import("node:worker_threads");
    const bound = (params ?? []).map(v => v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);
    Atomics.store(this.flag, 0, 0);
    (this.port as any).postMessage({ sql: pgSql, params: bound, guard: this.txDepth > 0 });
    if (Atomics.wait(this.flag, 0, 0, this.waitMs) === "timed-out") {
      throw new Error(`PG: no answer from the database worker within ${this.waitMs}ms`);
    }
    const reply = receiveMessageOnPort(this.port as any)?.message as any;
    if (!reply) throw new Error("PG: database worker signalled without a reply");
    if (!reply.ok) throw new Error(`PG: ${reply.error}`);
    return reply;
  }

  private querySync(sql: string, params?: any[]): { rows: any[]; count: number } {
    return this.request(sqliteToPostgres(sql), params);
  }

  run(sql: string, params?: any[]): QueryResult {
    if (sql.trim().toUpperCase().startsWith("PRAGMA")) return { changes: 0 };
    const result = this.querySync(sql, params);
    return { changes: result.count };
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
      try { this.request(stmt); } catch (e: any) {
        // Ignore "already exists" errors for CREATE TABLE/INDEX IF NOT EXISTS
        if (!/already exists/.test(e.message)) throw e;
      }
    }
  }

  transaction<T>(fn: () => T): T {
    const depth = this.txDepth;
    const savepoint = `anet_tx_${depth}`;
    // Control statements run unguarded: they are what the guard is made of.
    this.txDepth = 0;
    try { this.request(depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`); } finally { this.txDepth = depth; }
    this.txDepth = depth + 1;
    let result: T;
    try {
      result = fn();
    } catch (e) {
      this.txDepth = 0;
      try {
        if (depth === 0) this.request("ROLLBACK");
        else { this.request(`ROLLBACK TO SAVEPOINT ${savepoint}`); this.request(`RELEASE SAVEPOINT ${savepoint}`); }
      } catch {}
      this.txDepth = depth;
      throw e;
    }
    this.txDepth = 0;
    try { this.request(depth === 0 ? "COMMIT" : `RELEASE SAVEPOINT ${savepoint}`); } finally { this.txDepth = depth; }
    return result;
  }

  close(): void {
    this.worker.terminate();
  }
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
