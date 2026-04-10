/**
 * Database Adapter Interface — supports SQLite and PostgreSQL
 *
 * Usage:
 *   const adapter = createAdapter(process.env.COMMHUB_DB || 'sqlite:~/.commhub/commhub.db');
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

  /** Run a transaction */
  transaction<T>(fn: () => T): T;

  /** SQL dialect helpers */
  readonly dialect: 'sqlite' | 'postgres';

  /** Close connection */
  close(): void;
}

/** SQL template helpers for cross-database compatibility */
export function sqlHelpers(dialect: 'sqlite' | 'postgres') {
  return {
    now: dialect === 'postgres' ? 'NOW()' : "datetime('now')",

    addInterval(seconds: number): string {
      return dialect === 'postgres'
        ? `NOW() + INTERVAL '${seconds} seconds'`
        : `datetime('now', '+${seconds} seconds')`;
    },

    autoIncrement: dialect === 'postgres'
      ? 'SERIAL PRIMARY KEY'
      : 'INTEGER PRIMARY KEY AUTOINCREMENT',
  };
}
