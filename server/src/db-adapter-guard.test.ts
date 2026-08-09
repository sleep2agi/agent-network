import { describe, expect, test } from "bun:test";
import {
  assertSafeTestDatabaseEnv,
  resolveDatabaseTarget,
} from "./db-adapter";

const BASE_ENV: NodeJS.ProcessEnv = { HOME: "/nonexistent" };

describe("#435 inherited DATABASE_URL guard", () => {
  for (const databaseUrl of [
    "postgres://user:pw@prod.example:5432/commhub",
    "postgresql://user:pw@prod.example:5432/commhub",
    "sqlite:///tmp/not-an-escape",
  ]) {
    test(`NODE_ENV=test rejects ${databaseUrl.split(":", 1)[0]} DATABASE_URL`, () => {
      expect(() => assertSafeTestDatabaseEnv({
        ...BASE_ENV,
        NODE_ENV: "test",
        DATABASE_URL: databaseUrl,
      })).toThrow(/REFUSING to honor inherited DATABASE_URL/);
    });
  }

  test("test without DATABASE_URL leaves the existing SQLite guard in charge", () => {
    expect(() => assertSafeTestDatabaseEnv({ ...BASE_ENV, NODE_ENV: "test" })).not.toThrow();
    expect(() => resolveDatabaseTarget({ ...BASE_ENV, NODE_ENV: "test" }))
      .toThrow(/REFUSING to open the default SQLite database/);
  });

  test("DATABASE_URL refusal wins even when COMMHUB_DB is also set", () => {
    expect(() => resolveDatabaseTarget({
      ...BASE_ENV,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://user:pw@prod.example:5432/commhub",
      COMMHUB_DB: "/tmp/isolated.db",
    })).toThrow(/REFUSING to honor inherited DATABASE_URL/);
  });

  test("production postgres branch remains unchanged without constructing it", () => {
    const url = "postgres://user:pw@prod.example:5432/commhub";
    expect(resolveDatabaseTarget({
      ...BASE_ENV,
      NODE_ENV: "production",
      DATABASE_URL: url,
    })).toEqual({ kind: "postgres", url });
  });

  test("unset NODE_ENV still selects postgres", () => {
    const url = "postgresql://user:pw@prod.example:5432/commhub";
    expect(resolveDatabaseTarget({ ...BASE_ENV, DATABASE_URL: url }))
      .toEqual({ kind: "postgres", url });
  });

  test("explicit SQLite targets remain unchanged in test and production", () => {
    for (const NODE_ENV of ["test", "production"]) {
      expect(resolveDatabaseTarget({
        ...BASE_ENV,
        NODE_ENV,
        COMMHUB_DB: "/tmp/isolated.db",
      })).toEqual({ kind: "sqlite", path: "/tmp/isolated.db" });
    }
  });
});
