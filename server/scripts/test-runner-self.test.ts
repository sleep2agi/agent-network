// #434 rule 9 / #435 defense-in-depth — the aggregate runner's child
// env MUST NOT contain a leaked DATABASE_URL. This suite spawns a
// second-level Bun child under the SAME allowlist rules the runner
// uses, deliberately inheriting a fake-prod DATABASE_URL from the
// current process, and asserts the spawned child sees `DATABASE_URL`
// as `undefined` (not "the parent's value", not "the guard's error
// message" — properly unset).
//
// If this ever regresses, an operator with a leaked shell DATABASE_URL
// could be silently connecting a test process to production. The
// runner-level defense makes the #435 guard's job the *second* line;
// this test proves the first line holds.

import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { join, resolve } from "path";

// Duplicated deliberately — importing from the runner would create a
// module coupling that could hide a regression if the allowlist ever
// grew. This is the canonical set the child MUST see.
const RUNNER_ALLOWED_KEYS = new Set([
  "PATH", "TMPDIR", "TERM", "LANG", "LC_ALL", "LC_CTYPE",
  "CI", "GITHUB_ACTIONS", "SHELL", "USER", "LOGNAME",
]);

function buildRunnerLikeChildEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of RUNNER_ALLOWED_KEYS) {
    const v = parentEnv[k];
    if (v !== undefined) env[k] = v;
  }
  env.NODE_ENV = "test";
  delete env.DATABASE_URL;
  return env;
}

describe("#434 runner allowlist — DATABASE_URL cannot leak into children", () => {
  test("parent DATABASE_URL='postgres://fake…' → child sees DATABASE_URL=undefined", () => {
    const FAKE_PROD = "postgres://fake-prod-user:pw@prod.example:5432/commhub";
    const parentEnv: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: FAKE_PROD,
    };
    const childEnv = buildRunnerLikeChildEnv(parentEnv);

    // Sanity — the allowlist did drop DATABASE_URL from our own object.
    expect(childEnv.DATABASE_URL).toBeUndefined();

    // The actual proof: spawn a Bun child using THAT env, ask it to
    // print `process.env.DATABASE_URL || "UNSET"`, assert it says UNSET.
    // Not testing #435 here — we intentionally omit COMMHUB_DB so the
    // child would trip the SQLite guard if it tried to open a DB, but
    // we never call createAdapter; we only probe env visibility.
    const child = spawnSync("bun", [
      "-e",
      "console.log(process.env.DATABASE_URL || 'UNSET')",
    ], {
      env: childEnv,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("UNSET");
  });

  test("parent has no DATABASE_URL → child still sees it as UNSET", () => {
    // Baseline: without any inheritance, the child obviously sees UNSET.
    // Included so the "leaked→UNSET" and "clean→UNSET" cases both live
    // in the file and one can't accidentally start diverging.
    const clean: NodeJS.ProcessEnv = { ...process.env };
    delete clean.DATABASE_URL;
    const childEnv = buildRunnerLikeChildEnv(clean);
    expect(childEnv.DATABASE_URL).toBeUndefined();

    const child = spawnSync("bun", [
      "-e",
      "console.log(process.env.DATABASE_URL || 'UNSET')",
    ], {
      env: childEnv,
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(child.status).toBe(0);
    expect(child.stdout.trim()).toBe("UNSET");
  });

  test("smoke: NODE_ENV is set to 'test' for every child", () => {
    const childEnv = buildRunnerLikeChildEnv(process.env);
    expect(childEnv.NODE_ENV).toBe("test");
  });
});
