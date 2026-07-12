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

  test("NODE_ENV=test + fake DATABASE_URL → refusal, PgAdapter banner NEVER printed", () => {
    const FAKE_PROD = "postgres://fake-prod-user:pw@prod.example:5432/commhub";

    // Note: we spawn `bun -e` (not `bun run`) so no package.json script
    // hooks interpose; the call graph is import → createAdapter →
    // resolveDatabaseTarget → assertSafeTestDatabaseEnv → throw.
    const script =
      "const m = require('./server/src/db-adapter.ts'); " +
      "try { m.createAdapter(); console.log('UNEXPECTED_NO_THROW'); process.exit(0); } " +
      "catch (e) { console.error(e.message); process.exit(2); }";

    // NB: strip the outer runner's DATABASE_URL to prove the child sees
    // exactly what we hand it. The child env is a new object, not a
    // spread of process.env.
    const child = spawnSync("bun", ["-e", script], {
      cwd: join(__dirname, "..", ".."),
      env: {
        PATH: process.env.PATH || "",
        HOME: tmpDir,
        NODE_ENV: "test",
        DATABASE_URL: FAKE_PROD,
        // COMMHUB_DB deliberately unset — proves the DATABASE_URL guard
        // fires ahead of the SQLite guard in this specific ordering
        // (which is the whole point of #435).
      },
      encoding: "utf8",
      timeout: 15_000,
    });

    // (a) Exit code — guard should have thrown, script's catch block
    // exits 2. Anything else means the guard didn't fire and the
    // process either resolved a real DB or hit a different error path.
    expect(child.status).toBe(2);

    // (b) The refusal message must be present verbatim (the operator
    // sees this in their terminal; changing it silently would break
    // muscle memory + docs cross-refs).
    expect(child.stderr).toMatch(/REFUSING to honor inherited DATABASE_URL/);

    // (c) The "database: PostgreSQL" banner is emitted by createAdapter()
    // ONLY after `resolveDatabaseTarget` returns { kind: "postgres" }.
    // Its absence in stderr+stdout is the seam-not-triggered proof —
    // if the guard order regressed and PgAdapter was constructed, the
    // banner would print, and this assertion would fire.
    expect(child.stdout + child.stderr).not.toContain("database: PostgreSQL");

    // (d) Similarly, the SQLite banner must not appear either — no
    // default SQLite open happened before the throw.
    expect(child.stdout + child.stderr).not.toMatch(/\[commhub\] database: [^P]/);

    // (e) Also assert we didn't accidentally get the "UNEXPECTED_NO_THROW"
    // sentinel from the script's else branch.
    expect(child.stdout).not.toContain("UNEXPECTED_NO_THROW");
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  L3 — syscall trace is 副指挥's independent Linux verification.
//  This suite intentionally does NOT wrap the L2 subprocess in strace
//  and claim "syscall proof PASS" — strace absence would downgrade to
//  false confidence. The manual gate is:
//
//    strace -ff -e trace=connect,openat \
//      env NODE_ENV=test DATABASE_URL='postgres://fake:pw@prod:5432/commhub' \
//        bun -e "require('./server/src/db-adapter.ts').createAdapter()" 2>&1 \
//      | grep -E 'connect\([^)]*:5432|openat.*\.commhub/commhub\.db'
//
//  Expected: zero matching lines. If any match appears, guard regressed.
// ═══════════════════════════════════════════════════════════════════════
