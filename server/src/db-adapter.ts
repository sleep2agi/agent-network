/**
 * Database Adapter Interface — async-first, supports SQLite and PostgreSQL
 *
 * SQLite adapter: wraps bun:sqlite sync calls in Promise (zero overhead)
 * PostgreSQL adapter: uses bun:sql native async
 *
 * All callers use await — sync SQLite just resolves immediately.
 */

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
  readonly dialect: 'sqlite' | 'postgres';
}

/**
 * Phase 1 strategy:
 *
 * Current code is sync (bun:sqlite). We keep it sync for now.
 * All DB access goes through the adapter interface above.
 *
 * When we add PostgreSQL (Phase 2), the adapter interface
 * will change to async. At that point we'll update callers
 * in a single pass. The unified call sites from Phase 1
 * make that pass mechanical rather than archaeological.
 *
 * Why not async-first now?
 * - bun:sqlite is sync, wrapping in Promise adds noise
 * - All MCP tool handlers are already async, so the future
 *   migration is: db.run() → await db.run(), straightforward
 * - 750+ lines of tools.ts would need gratuitous await for zero benefit today
 *
 * The contract: every DB call goes through adapter methods,
 * never through raw db.query() or db.run() on the bun:sqlite object.
 * This is what makes Phase 2 feasible.
 */

/** SQL helpers for cross-dialect compatibility */
export function sqlNow(dialect: 'sqlite' | 'postgres'): string {
  return dialect === 'postgres' ? 'NOW()' : "datetime('now')";
}

export function sqlAddSeconds(dialect: 'sqlite' | 'postgres', seconds: number | string): string {
  return dialect === 'postgres'
    ? `NOW() + INTERVAL '${seconds} seconds'`
    : `datetime('now', '+${seconds} seconds')`;
}

export function sqlPlaceholder(dialect: 'sqlite' | 'postgres', index: number): string {
  return dialect === 'postgres' ? `$${index}` : `?${index}`;
}
