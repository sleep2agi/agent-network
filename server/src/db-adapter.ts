/**
 * Database Adapter — sync interface, supports SQLite (now) and PostgreSQL (future)
 *
 * SQLite adapter wraps bun:sqlite. PostgreSQL adapter will be added when needed.
 * All callers go through DbAdapter — never touch raw bun:sqlite directly.
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

/** SQLite implementation using bun:sqlite */
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

/** SQL helpers for cross-dialect compatibility */
export function sqlNow(dialect: "sqlite" | "postgres"): string {
  return dialect === "postgres" ? "NOW()" : "datetime('now')";
}

export function sqlAddSeconds(dialect: "sqlite" | "postgres", seconds: number | string): string {
  return dialect === "postgres"
    ? `NOW() + INTERVAL '${seconds} seconds'`
    : `datetime('now', '+${seconds} seconds')`;
}

export function sqlPlaceholder(dialect: "sqlite" | "postgres", index: number): string {
  return dialect === "postgres" ? `$${index}` : `?${index}`;
}
