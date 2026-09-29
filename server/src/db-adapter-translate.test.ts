import { describe, expect, test } from "bun:test";
import { splitSqlStatements, sqliteToPostgres } from "./db-adapter";

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

  test("BLOB → BYTEA, identifiers containing blob untouched", () => {
    expect(sqliteToPostgres("iv BLOB NOT NULL, blob_ref TEXT")).toBe("iv BYTEA NOT NULL, blob_ref TEXT");
  });

  test("placeholders and AUTOINCREMENT unchanged in behaviour", () => {
    expect(sqliteToPostgres("SELECT * FROM t WHERE a = ?1 AND b = ?2")).toBe("SELECT * FROM t WHERE a = $1 AND b = $2");
    expect(sqliteToPostgres("a = ? AND b = ?")).toBe("a = $1 AND b = $2");
    expect(sqliteToPostgres("id INTEGER PRIMARY KEY AUTOINCREMENT")).toBe("id SERIAL PRIMARY KEY");
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
