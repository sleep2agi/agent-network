import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  buildBootstrapPasswordUpdateInvocation,
  resolveBootstrapDatabasePath,
} from "./bootstrap-password-db";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "anet-661-"));
  roots.push(root);
  return root;
}

function seedUser(dbPath: string, userId = "user-661"): void {
  mkdirSync(join(dbPath, ".."), { recursive: true });
  const db = new Database(dbPath);
  db.exec("CREATE TABLE users (user_id TEXT PRIMARY KEY, must_change_password INTEGER NOT NULL DEFAULT 0)");
  db.query("INSERT INTO users (user_id) VALUES (?1)").run(userId);
  db.close();
}

function mustChange(dbPath: string, userId = "user-661"): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.query<{ must_change_password: number }, [string]>(
    "SELECT must_change_password FROM users WHERE user_id = ?1",
  ).get(userId);
  db.close();
  return row?.must_change_password ?? -1;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bootstrap password database binding", () => {
  test("turns the local default into an explicit absolute path", () => {
    const home = tempRoot();
    expect(resolveBootstrapDatabasePath({}, home, "/work")).toBe(
      join(home, ".commhub", "commhub.db"),
    );
  });

  test("anchors a relative COMMHUB_DB to the hub launch cwd", () => {
    const home = tempRoot();
    expect(resolveBootstrapDatabasePath({ COMMHUB_DB: "state/hub.db" }, home, "/srv/anet")).toBe(
      "/srv/anet/state/hub.db",
    );
  });

  test("rejects an unusable default before opening a database", () => {
    expect(() => resolveBootstrapDatabasePath({}, "~", "/work")).toThrow(/absolute HOME/);
    expect(() => resolveBootstrapDatabasePath({ COMMHUB_DB: "bad\0path" }, "/home/test", "/work"))
      .toThrow(/NUL/);
  });

  test("does not invent a SQLite target for a PostgreSQL Hub", () => {
    const home = tempRoot();
    expect(() => resolveBootstrapDatabasePath(
      { DATABASE_URL: "postgresql://db.example/commhub" },
      home,
      "/work",
    )).toThrow(/PostgreSQL Hub/);
  });

  test("updates only the explicitly resolved database, never ambient HOME", () => {
    const root = tempRoot();
    const explicitDb = join(root, "explicit", "hub.db");
    const decoyHome = join(root, "decoy-home");
    const decoyDb = join(decoyHome, ".commhub", "commhub.db");
    seedUser(explicitDb);
    seedUser(decoyDb);

    const invocation = buildBootstrapPasswordUpdateInvocation("user-661", explicitDb, {
      ...process.env,
      HOME: decoyHome,
    });
    expect(invocation.argv.slice(0, 2)).toEqual(["bun", "-e"]);
    expect(invocation.env.ANET_BOOTSTRAP_DB_PATH).toBe(explicitDb);
    expect(invocation.script).not.toContain(".commhub/commhub.db");
    expect(invocation.script).not.toContain("process.env.HOME");

    const proc = Bun.spawnSync(invocation.argv, {
      env: invocation.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).toBe(0);
    expect(mustChange(explicitDb)).toBe(1);
    expect(mustChange(decoyDb)).toBe(0);
  });

  test("child refuses a missing explicit path without falling back to HOME", () => {
    const root = tempRoot();
    const decoyHome = join(root, "decoy-home");
    const decoyDb = join(decoyHome, ".commhub", "commhub.db");
    seedUser(decoyDb);

    const invocation = buildBootstrapPasswordUpdateInvocation("user-661", join(root, "unused.db"), {
      ...process.env,
      HOME: decoyHome,
    });
    delete invocation.env.ANET_BOOTSTRAP_DB_PATH;
    const proc = Bun.spawnSync(invocation.argv, {
      env: invocation.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode).not.toBe(0);
    expect(proc.stderr.toString()).toContain("explicit absolute database path");
    expect(mustChange(decoyDb)).toBe(0);
  });
});
