import { describe, expect, test } from "bun:test";
import {
  assertSafeTestDatabaseEnv,
  redactPgUrl,
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

  test("non-server callers cannot silently fall through to the production default SQLite path", () => {
    for (const NODE_ENV of [undefined, "development", "production"]) {
      expect(() => resolveDatabaseTarget({ ...BASE_ENV, NODE_ENV }))
        .toThrow(/explicit COMMHUB_DB|COMMHUB_SERVER=1/);
    }
  });

  test("the explicit server boot capability permits the canonical default SQLite path", () => {
    expect(resolveDatabaseTarget({
      ...BASE_ENV,
      NODE_ENV: "production",
      COMMHUB_SERVER: "1",
    })).toEqual({ kind: "sqlite", path: "/nonexistent/.commhub/commhub.db" });
  });

  test("lookalike server capability values fail closed", () => {
    for (const COMMHUB_SERVER of ["", "true", "yes", "01", " 1"] ) {
      expect(() => resolveDatabaseTarget({ ...BASE_ENV, COMMHUB_SERVER }))
        .toThrow(/COMMHUB_SERVER=1/);
    }
  });
});

describe("RFC-039 §9 COMMHUB_TEST_PG_URL (test-only PostgreSQL)", () => {
  const TEST = { ...BASE_ENV, NODE_ENV: "test" };
  const ok = (url: string) => expect(resolveDatabaseTarget({ ...TEST, COMMHUB_TEST_PG_URL: url })).toEqual({ kind: "postgres", url });
  const refused = (url: string, why: RegExp) => {
    let message = "";
    try { resolveDatabaseTarget({ ...TEST, COMMHUB_TEST_PG_URL: url }); } catch (e: any) { message = String(e?.message ?? e); }
    expect(message).toMatch(/REFUSING COMMHUB_TEST_PG_URL/);
    expect(message).toMatch(why);
    // Credentials never reach an error message.
    expect(message).not.toContain("s3cret");
    expect(message).not.toContain("tester");
  };

  test("loopback host + anet_*_test database is accepted under NODE_ENV=test", () => {
    ok("postgres://tester:s3cret@127.0.0.1:5432/anet_sched_test");
    ok("postgresql://tester:s3cret@localhost/anet_side_thread_test");
    ok("postgres://tester:s3cret@[::1]:6543/anet_x_test?connect_timeout=2&sslmode=disable");
  });

  test("ignored outside NODE_ENV=test", () => {
    expect(resolveDatabaseTarget({ ...BASE_ENV, NODE_ENV: "production", COMMHUB_DB: "/tmp/i.db", COMMHUB_TEST_PG_URL: "postgres://tester:s3cret@127.0.0.1/anet_x_test" }))
      .toEqual({ kind: "sqlite", path: "/tmp/i.db" });
  });

  test("inherited DATABASE_URL still refuses even when COMMHUB_TEST_PG_URL is set", () => {
    expect(() => resolveDatabaseTarget({
      ...TEST,
      DATABASE_URL: "postgres://user:pw@prod.example:5432/commhub",
      COMMHUB_TEST_PG_URL: "postgres://tester:s3cret@127.0.0.1/anet_x_test",
    })).toThrow(/REFUSING to honor inherited DATABASE_URL/);
  });

  test("refuses a value that is not a URL or not postgres", () => {
    refused("not a url", /not a URL/);
    refused("mysql://tester:s3cret@127.0.0.1/anet_x_test", /scheme/);
  });

  test("refuses every host that is not literally loopback", () => {
    for (const host of ["10.0.0.5", "db.internal", "localhost.evil.example", "127.0.0.2", "127.0.0.1,evil.example", "LOCALHOST", "%2Ftmp"]) {
      refused(`postgres://tester:s3cret@${host}/anet_x_test`, /host must be/);
    }
  });

  test("refuses database names outside /^anet_[a-z0-9_]*_test$/", () => {
    for (const name of ["commhub", "anet_x", "anet_x_test2", "ANET_X_TEST", "anet-x_test", "anet_x_test/extra", ""]) {
      refused(`postgres://tester:s3cret@127.0.0.1/${name}`, /database name/);
    }
  });

  test("refuses connection-steering query parameters", () => {
    refused("postgres://tester:s3cret@127.0.0.1/anet_x_test?host=db.internal", /"host" is not allowed/);
    refused("postgres://tester:s3cret@127.0.0.1/anet_x_test?options=-csearch_path%3Dprod", /"options" is not allowed/);
  });

  test("redactPgUrl drops user and password", () => {
    const out = redactPgUrl("postgres://tester:s3cret@127.0.0.1:5432/anet_x_test");
    expect(out).not.toContain("tester");
    expect(out).not.toContain("s3cret");
    expect(out).toContain("127.0.0.1:5432/anet_x_test");
  });
});
