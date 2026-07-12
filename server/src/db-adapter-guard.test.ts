// Issue #435 — reject inherited DATABASE_URL under NODE_ENV=test.
//
// Layered proof:
//
//   L1 — Pure-helper unit tests (in-process, deterministic).
//        - `assertSafeTestDatabaseEnv(env)` throws for test+DATABASE_URL,
//          silent for every other combination.
//        - `resolveDatabaseTarget(env)` returns a `postgres` discriminant
//          for production+DATABASE_URL — proving the branch selection
//          works WITHOUT constructing PgAdapter or touching the network
//          (per #435 acceptance: "no real external database endpoint is
//          contacted during tests").
//        - `resolveDatabaseTarget(env)` returns a `sqlite` discriminant
//          with a mkdtemp path for legitimate production+COMMHUB_DB.
//
//   L2 — Subprocess negative test (single case).
//        - Spawn `bun -e "…createAdapter()…"` with `NODE_ENV=test` and a
//          FAKE-PROD `DATABASE_URL` that MUST NEVER resolve or be dialed.
//          Assert: exit != 0, stderr contains the actionable refusal
//          message, stderr does NOT contain the `database: PostgreSQL`
//          banner (which the caller-side `console.log` emits only after
//          the guard passes — the seam-not-triggered proof).
//
//   L3 — syscall trace (independent verification).
//        - `strace -e connect,openat` around the L2 subprocess is left
//          to 副指挥's Linux verifier; this suite prints the strace log
//          when `strace` is available but does NOT claim "syscall proof
//          PASS" (per #435 constraint — strace absence downgrades the
//          gate to "functional stderr proof only, syscall verification
//          pending").

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  assertSafeTestDatabaseEnv,
  resolveDatabaseTarget,
} from "./db-adapter";

// Base env used to construct scenario envs — deliberately EXCLUDES the
// caller's real `process.env` so leaked shell variables cannot flip a
// test outcome. Individual tests spread the fields they need.
const BASE_ENV: NodeJS.ProcessEnv = { HOME: "/nonexistent" };

// ═══════════════════════════════════════════════════════════════════════
//  L1 — Pure-helper tests
// ═══════════════════════════════════════════════════════════════════════

describe("assertSafeTestDatabaseEnv — fail-closed test guard", () => {
  test("throws under NODE_ENV=test + DATABASE_URL=postgres://…", () => {
    const env = {
      ...BASE_ENV,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://leaked-prod-user:pw@prod.example:5432/commhub",
    };
    expect(() => assertSafeTestDatabaseEnv(env)).toThrow(
      /REFUSING to honor inherited DATABASE_URL/
    );
  });

  test("throws under NODE_ENV=test + DATABASE_URL=postgresql://…", () => {
    const env = {
      ...BASE_ENV,
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/anything",
    };
    expect(() => assertSafeTestDatabaseEnv(env)).toThrow(
      /REFUSING to honor inherited DATABASE_URL/
    );
  });

  test("throws under NODE_ENV=test + DATABASE_URL that ISN'T postgres (no bypass by scheme)", () => {
    // Even a nonsense DATABASE_URL under NODE_ENV=test must refuse — the
    // guard is fail-closed on the ENV being present, not on it being a
    // postgres URL. This closes the "sqlite://…" / "junk" bypass class.
    const env = {
      ...BASE_ENV,
      NODE_ENV: "test",
      DATABASE_URL: "sqlite:///tmp/whatever",
    };
    expect(() => assertSafeTestDatabaseEnv(env)).toThrow(
      /REFUSING to honor inherited DATABASE_URL/
    );
  });

  test("silent under NODE_ENV=test with both DB envs unset (SQLite guard covers this later)", () => {
    const env = { ...BASE_ENV, NODE_ENV: "test" };
    expect(() => assertSafeTestDatabaseEnv(env)).not.toThrow();
  });

  test("silent under NODE_ENV=production with DATABASE_URL set", () => {
    // Production runtime must be unaffected — the whole point of the
    // ordering fix is that the guard sits BEFORE branch selection but
    // only fires when NODE_ENV=test.
    const env = {
      ...BASE_ENV,
      NODE_ENV: "production",
      DATABASE_URL: "postgres://prod-user:pw@prod.example:5432/commhub",
    };
    expect(() => assertSafeTestDatabaseEnv(env)).not.toThrow();
  });

  test("silent under NODE_ENV unset with DATABASE_URL set", () => {
    // "NODE_ENV unset" is the normal server-boot case (index.ts doesn't
    // set it). Must not trip the guard.
    const env = { ...BASE_ENV, DATABASE_URL: "postgres://…" };
    expect(() => assertSafeTestDatabaseEnv(env)).not.toThrow();
  });

  test("silent under NODE_ENV=development with DATABASE_URL", () => {
    const env = { ...BASE_ENV, NODE_ENV: "development", DATABASE_URL: "postgres://…" };
    expect(() => assertSafeTestDatabaseEnv(env)).not.toThrow();
  });
});

describe("resolveDatabaseTarget — pure branch decision, no construction", () => {
  test("production + DATABASE_URL=postgres://… → { kind: postgres, url } (no connection)", () => {
    // This is the production-mode regression proof. The pure function
    // returns the discriminant; no PgAdapter is ever constructed, no
    // socket is dialed, no packet leaves. Production dispatch is
    // covered end-to-end at the branch level — that's the entire point
    // of extracting the pure resolver.
    const url = "postgres://prod-user:pw@prod.example:5432/commhub";
    const env = { ...BASE_ENV, NODE_ENV: "production", DATABASE_URL: url };
    const target = resolveDatabaseTarget(env);
    expect(target).toEqual({ kind: "postgres", url });
  });

  test("production + DATABASE_URL=postgresql://… → { kind: postgres, url }", () => {
    const url = "postgresql://user:pw@host:5432/db";
    const env = { ...BASE_ENV, NODE_ENV: "production", DATABASE_URL: url };
    expect(resolveDatabaseTarget(env)).toEqual({ kind: "postgres", url });
  });

  test("NODE_ENV unset + DATABASE_URL=postgres://… → { kind: postgres, url }", () => {
    // Server boot in the wild — index.ts doesn't set NODE_ENV. The
    // resolver must still route to the postgres discriminant.
    const url = "postgres://u:p@h:5432/d";
    const env = { ...BASE_ENV, DATABASE_URL: url };
    expect(resolveDatabaseTarget(env)).toEqual({ kind: "postgres", url });
  });

  test("production + COMMHUB_DB set → { kind: sqlite, path: COMMHUB_DB }", () => {
    // No side effects — mkdtempSync only, target should echo the path.
    const dir = mkdtempSync(join(tmpdir(), "anet-435-sqlite-prod-"));
    const dbPath = join(dir, "commhub.db");
    try {
      const env = { ...BASE_ENV, NODE_ENV: "production", COMMHUB_DB: dbPath };
      expect(resolveDatabaseTarget(env)).toEqual({ kind: "sqlite", path: dbPath });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("test + COMMHUB_DB set → { kind: sqlite, path } (SQLite guard silent when path supplied)", () => {
    const dir = mkdtempSync(join(tmpdir(), "anet-435-sqlite-test-"));
    const dbPath = join(dir, "commhub.db");
    try {
      const env = { ...BASE_ENV, NODE_ENV: "test", COMMHUB_DB: dbPath };
      expect(resolveDatabaseTarget(env)).toEqual({ kind: "sqlite", path: dbPath });
    } finally {
      // Case 4 cleanup: nothing was written (pure resolver returned only),
      // but tidy anyway.
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("test + all DB envs unset → SQLite guard throws (existing behavior preserved)", () => {
    const env = { ...BASE_ENV, NODE_ENV: "test" };
    expect(() => resolveDatabaseTarget(env)).toThrow(
      /REFUSING to open the default SQLite database under NODE_ENV=test/
    );
  });

  test("test + DATABASE_URL set → DATABASE_URL guard fires FIRST (before SQLite guard)", () => {
    // The whole ordering fix: the DATABASE_URL guard must be reached
    // ahead of any SQLite guard so an inherited prod URL can't slip
    // past by "the SQLite guard would have caught missing COMMHUB_DB".
    // Assert the DATABASE_URL message, not the SQLite one.
    const env = {
      ...BASE_ENV,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://leaked:pw@prod:5432/commhub",
      // COMMHUB_DB deliberately unset — if the DATABASE_URL guard is
      // reordered wrong, we'd get the SQLite refusal instead.
    };
    expect(() => resolveDatabaseTarget(env)).toThrow(
      /REFUSING to honor inherited DATABASE_URL/
    );
  });

  test("test + BOTH DATABASE_URL AND COMMHUB_DB set → DATABASE_URL guard still fires FIRST", () => {
    // Anti-drift guard for future reorderings. Even when COMMHUB_DB is
    // provided (which would satisfy the SQLite guard), the DATABASE_URL
    // guard must still short-circuit under NODE_ENV=test — there is no
    // "you had a safe SQLite path so I'll ignore the DATABASE_URL leak"
    // branch. Only the DATABASE_URL refusal message is acceptable here.
    const env = {
      ...BASE_ENV,
      NODE_ENV: "test",
      DATABASE_URL: "postgres://leaked:pw@prod:5432/commhub",
      COMMHUB_DB: "/tmp/anet-435-order-drift-canary.db",
    };
    expect(() => resolveDatabaseTarget(env)).toThrow(
      /REFUSING to honor inherited DATABASE_URL/
    );
    // Cross-check: it must NOT throw the SQLite guard message either
    // (which would imply the DATABASE_URL guard was reordered after the
    // SQLite one and this test is passing by wrong-message accident).
    let thrown: Error | null = null;
    try { resolveDatabaseTarget(env); } catch (e) { thrown = e as Error; }
    expect(thrown).not.toBeNull();
    expect(thrown!.message).not.toMatch(/REFUSING to open the default SQLite database/);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  L2 — Subprocess negative test (single case, real spawn)
// ═══════════════════════════════════════════════════════════════════════
//
// Per #435: "subprocess test with NODE_ENV=test + fake DATABASE_URL gets
// a stable actionable refusal". Only the fake-prod URL case is exercised
// via subprocess — production regression stays pure-helper (no external
// endpoint contacted).

describe("L2 subprocess proof — createAdapter() refuses in a real Bun runtime", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "anet-435-l2-"));
  });

  afterEach(() => {
    // Case 4 cleanup: db + WAL + SHM, then the dir itself. rmSync with
    // recursive:true handles the leftover shape regardless of what got
    // touched (guard should have short-circuited before any file open,
    // but we tidy in either direction so a false-positive can't leak a
    // half-created file into /tmp).
    for (const suffix of ["", "-wal", "-shm"]) {
      const p = join(tmpDir, `commhub.db${suffix}`);
      if (existsSync(p)) rmSync(p, { force: true });
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // The `bun -e` script drives the call graph:
  //   import → createAdapter → resolveDatabaseTarget →
  //   assertSafeTestDatabaseEnv (or SQLite guard) → throw.
  // The wrapping try/catch is required — bun -e's top-level throw
  // semantics don't reliably surface as a non-zero exit code otherwise.
  const CHILD_SCRIPT =
    "const m = require('./server/src/db-adapter.ts'); " +
    "try { m.createAdapter(); console.log('UNEXPECTED_NO_THROW'); process.exit(0); } " +
    "catch (e) { console.error(e.message); process.exit(2); }";

  test("NODE_ENV=test + fake DATABASE_URL → DATABASE_URL guard refusal, no banners, no seam trigger", () => {
    const FAKE_PROD = "postgres://fake-prod-user:pw@prod.example:5432/commhub";

    // NB: env is a new object, not a spread of process.env — we strip
    // the outer runner's DATABASE_URL so the child sees exactly what
    // we hand it.
    const child = spawnSync("bun", ["-e", CHILD_SCRIPT], {
      cwd: join(__dirname, "..", ".."),
      env: {
        PATH: process.env.PATH || "",
        HOME: tmpDir,
        NODE_ENV: "test",
        DATABASE_URL: FAKE_PROD,
        // COMMHUB_DB deliberately unset — proves the DATABASE_URL guard
        // fires ahead of the SQLite guard in this specific ordering
        // (the whole point of #435).
      },
      encoding: "utf8",
      timeout: 15_000,
    });

    // Exit + refusal + banner-absence assertions.
    expect(child.status).toBe(2);
    expect(child.stderr).toMatch(/REFUSING to honor inherited DATABASE_URL/);
    // The "database: PostgreSQL" banner runs only after
    // resolveDatabaseTarget returns { kind: "postgres" }. Absence =
    // constructor seam not triggered.
    expect(child.stdout + child.stderr).not.toContain("database: PostgreSQL");
    // No default-SQLite banner either — no path calc, no mkdir, no
    // Database() open happened before the throw.
    expect(child.stdout + child.stderr).not.toMatch(/\[commhub\] database: [^P]/);
    // Sentinel from the script's else branch must NOT appear.
    expect(child.stdout).not.toContain("UNEXPECTED_NO_THROW");
  });

  // #435 acceptance verbatim:
  //   "subprocess test with both DB variables unset still proves the
  //    existing SQLite refusal"
  test("NODE_ENV=test + BOTH DATABASE_URL and COMMHUB_DB unset → SQLite refusal (real subprocess)", () => {
    const child = spawnSync("bun", ["-e", CHILD_SCRIPT], {
      cwd: join(__dirname, "..", ".."),
      env: {
        PATH: process.env.PATH || "",
        HOME: tmpDir,
        NODE_ENV: "test",
        // BOTH DB vars deliberately absent (no key = no inheritance
        // either, since env is a fresh object).
      },
      encoding: "utf8",
      timeout: 15_000,
    });

    // Exit + refusal message + banner absence.
    expect(child.status).toBe(2);
    // Must be the SQLite guard message (the DATABASE_URL guard could
    // not have fired here — DATABASE_URL wasn't set).
    expect(child.stderr).toMatch(
      /REFUSING to open the default SQLite database under NODE_ENV=test/,
    );
    // The DATABASE_URL guard's message must NOT be present — it would
    // mean either a bug in the guard predicate or DATABASE_URL leaked
    // into the child env from somewhere.
    expect(child.stderr).not.toContain("REFUSING to honor inherited DATABASE_URL");
    // No banners at all — nothing opened, nothing constructed.
    expect(child.stdout + child.stderr).not.toContain("database: PostgreSQL");
    expect(child.stdout + child.stderr).not.toMatch(/\[commhub\] database: [^P]/);
    expect(child.stdout).not.toContain("UNEXPECTED_NO_THROW");
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  L3 — syscall trace is 副指挥's independent Linux verification.
//  This suite intentionally does NOT wrap the L2 subprocess in strace
//  and claim "syscall proof PASS" — strace absence would downgrade to
//  false confidence. The manual gate (run from repo root):
//
//    strace -f -o /tmp/strace-435.log -e trace=connect,openat \
//      env -u COMMHUB_DB NODE_ENV=test \
//        DATABASE_URL='postgres://fake:pw@prod:5432/commhub' \
//        bun -e "const m = require('./server/src/db-adapter.ts'); \
//                try { m.createAdapter(); process.exit(0); } \
//                catch(e) { console.error(e.message); process.exit(2); }"
//
//    # (1) authoritative negative — ALL connect() during refusal
//    #     path must be zero:
//    grep -c 'connect(' /tmp/strace-435.log
//
//    # (2) diagnostic scope to PG port (sin_port field, not a naked
//    #     :5432 substring — strace prints ports inside
//    #     `sin_port=htons(5432)`):
//    grep -Ec 'connect\([^)]*sin_port=htons\(5432\)' /tmp/strace-435.log
//
//    # (3) default SQLite path open — zero:
//    grep -Ec 'openat\([^)]*\.commhub/commhub\.db' /tmp/strace-435.log
//
//  Expected: (1) 0, (2) 0, (3) 0. Naked `:5432` regex would
//  false-negative on typical strace output — do not rely on it.
// ═══════════════════════════════════════════════════════════════════════
