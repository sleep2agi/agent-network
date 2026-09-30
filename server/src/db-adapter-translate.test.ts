import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { PG_EXPERIMENTAL_ENV, PgAdapter, SQLiteAdapter, splitSqlStatements, sqliteToPostgres } from "./db-adapter";

const UTC_NOW = "to_char((NOW()) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')";

describe("RFC-039 S2a sqliteToPostgres", () => {
  test("datetime('now') stays SQLite-format UTC text", () => {
    expect(sqliteToPostgres("SELECT datetime('now')")).toBe(`SELECT ${UTC_NOW}`);
  });

  test("DEFAULT (datetime('now')) keeps the column TEXT", () => {
    const out = sqliteToPostgres("created_at TEXT NOT NULL DEFAULT (datetime('now'))");
    expect(out).toBe(`created_at TEXT NOT NULL DEFAULT (${UTC_NOW})`);
    expect(out).not.toContain("TIMESTAMP");
  });

  test("strftime with milliseconds keeps SQLite's %f shape", () => {
    expect(sqliteToPostgres("VALUES (strftime('%Y-%m-%d %H:%M:%f', 'now'))")).toBe(
      "VALUES (to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.MS'))",
    );
  });

  test("literal offset", () => {
    expect(sqliteToPostgres("x < datetime('now', '+14 days')")).toBe(
      "x < to_char((NOW() + INTERVAL '14 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')",
    );
  });

  test("parameter offset is cast so PG can infer its type", () => {
    expect(sqliteToPostgres("x < datetime('now', ?2)")).toBe(
      "x < to_char((NOW() + CAST($2 AS TEXT)::INTERVAL) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')",
    );
  });

  test("INTEGER → BIGINT (epoch-ms columns), identifiers containing integer untouched", () => {
    expect(sqliteToPostgres("created_at INTEGER NOT NULL, integer_ref TEXT")).toBe("created_at BIGINT NOT NULL, integer_ref TEXT");
    expect(sqliteToPostgres("CAST(x AS INTEGER)")).toBe("CAST(x AS BIGINT)");
  });

  test("BLOB → BYTEA, identifiers containing blob untouched", () => {
    expect(sqliteToPostgres("iv BLOB NOT NULL, blob_ref TEXT")).toBe("iv BYTEA NOT NULL, blob_ref TEXT");
  });

  test("placeholders and AUTOINCREMENT unchanged in behaviour", () => {
    expect(sqliteToPostgres("SELECT * FROM t WHERE a = ?1 AND b = ?2")).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    expect(sqliteToPostgres("a = ? AND b = ?")).toBe("a = $1 AND b = $2");
    expect(sqliteToPostgres("id INTEGER PRIMARY KEY AUTOINCREMENT")).toBe("id BIGSERIAL PRIMARY KEY");
  });
});

describe("RFC-039 S2a splitSqlStatements", () => {
  test("a `;` inside a -- comment does not split (db.ts first schema block)", () => {
    expect(splitSqlStatements("CREATE TABLE a (x TEXT);\n-- note; more words\nCREATE TABLE b (y TEXT);")).toEqual([
      "CREATE TABLE a (x TEXT)",
      "CREATE TABLE b (y TEXT)",
    ]);
  });

  test("block comments are dropped", () => {
    expect(splitSqlStatements("SELECT 1 /* a; b */ ; SELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("quoted strings and identifiers keep their `;` and doubled quotes", () => {
    expect(splitSqlStatements(`INSERT INTO t VALUES ('a;b', 'it''s;'); SELECT "c;d" FROM t`)).toEqual([
      `INSERT INTO t VALUES ('a;b', 'it''s;')`,
      `SELECT "c;d" FROM t`,
    ]);
  });

  test("a plpgsql $$ body stays one statement", () => {
    const fn = "CREATE FUNCTION f() RETURNS trigger AS $$\nBEGIN\n  INSERT INTO t VALUES (1);\n  RETURN NEW;\nEND;\n$$ LANGUAGE plpgsql";
    expect(splitSqlStatements(`${fn};\nDROP TRIGGER IF EXISTS x ON t;`)).toEqual([fn, "DROP TRIGGER IF EXISTS x ON t"]);
  });

  test("tagged dollar quotes; $1 placeholders are not dollar quotes", () => {
    expect(splitSqlStatements("SELECT $body$a;b$body$; UPDATE t SET a = $1 WHERE b = $2")).toEqual([
      "SELECT $body$a;b$body$",
      "UPDATE t SET a = $1 WHERE b = $2",
    ]);
  });

  test("empty statements are dropped", () => {
    expect(splitSqlStatements(" ; ;\n SELECT 1 ;; ")).toEqual(["SELECT 1"]);
  });
});

describe("RFC-039 transactional feature gates", () => {
  // A PgAdapter without its constructor: no worker, no connection.
  function pgWith(atomic: boolean) {
    const pg = Object.create(PgAdapter.prototype);
    Object.defineProperty(pg, "atomicTransactions", { value: atomic });
    return pg as PgAdapter;
  }
  function withFlag<T>(value: string | undefined, fn: () => T): T {
    const saved = process.env[PG_EXPERIMENTAL_ENV];
    if (value === undefined) delete process.env[PG_EXPERIMENTAL_ENV];
    else process.env[PG_EXPERIMENTAL_ENV] = value;
    try { return fn(); } finally {
      if (saved === undefined) delete process.env[PG_EXPERIMENTAL_ENV];
      else process.env[PG_EXPERIMENTAL_ENV] = saved;
    }
  }

  test("SQLite: open, flag irrelevant", () => {
    const sqlite = new SQLiteAdapter(new Database(":memory:"));
    expect(withFlag(undefined, () => sqlite.transactionalFeaturesRefusal)).toBeNull();
    expect(withFlag("1", () => sqlite.transactionalFeaturesRefusal)).toBeNull();
    sqlite.close();
  });

  test("PostgreSQL with real transactions: closed by default, message names the variable", () => {
    const refusal = withFlag(undefined, () => pgWith(true).transactionalFeaturesRefusal);
    expect(refusal).toContain(`${PG_EXPERIMENTAL_ENV}=1`);
    expect(refusal).toContain("experimental");
    expect(withFlag("true", () => pgWith(true).transactionalFeaturesRefusal)).not.toBeNull();
  });

  test("PostgreSQL: opens only with atomic transactions AND the opt-in", () => {
    expect(withFlag("1", () => pgWith(true).transactionalFeaturesRefusal)).toBeNull();
    expect(withFlag("1", () => pgWith(false).transactionalFeaturesRefusal)).toContain("not atomic");
  });
});
