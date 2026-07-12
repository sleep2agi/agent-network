// RFC-030 Wave 1A P0.2 Commit 1 corrective — tui-child-launcher tests.

import { describe, expect, test } from "bun:test";
import {
  NoopTuiChildLauncher,
  TUI_BEARER_ENV_NAME,
  buildAllowlistEnv,
} from "./tui-child-launcher";

describe("buildAllowlistEnv — narrow typed allowlist", () => {
  test("happy path: bearer + PATH + HOME + TMPDIR + CODEX_HOME", () => {
    const env = buildAllowlistEnv("the-bearer", {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      TMPDIR: "/tmp",
      CODEX_HOME: "/tmp/codex-home",
    });
    expect(env[TUI_BEARER_ENV_NAME]).toBe("the-bearer");
    expect(env.PATH).toBe("/usr/bin");
    expect(Object.keys(env).sort()).toEqual([
      TUI_BEARER_ENV_NAME, "CODEX_HOME", "HOME", "PATH", "TMPDIR",
    ]);
  });

  test("empty bearer throws", () => {
    expect(() => buildAllowlistEnv("", {})).toThrow(/bearerValue/);
  });

  test("caller CANNOT smuggle CommHub token env slot via cast", () => {
    for (const bad of [
      "ANET_CODEX_COMMHUB_TOKEN",
      "COMMHUB_TOKEN",
      "COMMHUB_AUTH_TOKEN",
      "ANET_HUB_TOKEN",
      "DATABASE_URL",
      "AWS_ACCESS_KEY_ID",
      "NTOK_x1",
      "UTOK_admin",
    ]) {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        buildAllowlistEnv("b", { [bad]: "leak" } as any),
      ).toThrow(/not in the allowlist/);
    }
  });

  test("prototype-poison keys are refused (__proto__ / constructor / prototype)", () => {
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        buildAllowlistEnv("b", { [bad]: "leak" } as any),
      ).toThrow(/not allowed|not in the allowlist/);
    }
  });

  test("bearer key cannot be duplicated in the additional env", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildAllowlistEnv("b", { [TUI_BEARER_ENV_NAME]: "shadow" } as any),
    ).toThrow(/reserved/);
  });

  test("non-string additional value rejected", () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      buildAllowlistEnv("b", { PATH: 42 as unknown as string } as any),
    ).toThrow(/must be a string/);
  });

  test("frozen: cannot mutate result", () => {
    const env = buildAllowlistEnv("b", { PATH: "/usr/bin" });
    expect(() => {
      (env as Record<string, string>).EXTRA = "leak";
    }).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// NoopTuiChildLauncher — observation is redacted
// ─────────────────────────────────────────────────────────────────────

describe("NoopTuiChildLauncher — observation carries no plaintext", () => {
  test("launch records redacted observation only", async () => {
    const l = new NoopTuiChildLauncher();
    const bearer = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
    const env = buildAllowlistEnv(bearer, {
      PATH: "/usr/bin", CODEX_HOME: "/tmp/ch",
    });
    const out = await l.launch({ wsUrl: "ws://127.0.0.1:12345", env });
    expect(out.spawned).toBe(false);

    const obs = l.seenObservations();
    expect(obs).toHaveLength(1);
    // Neither plaintext nor complete digest appears.
    const dump = JSON.stringify(obs);
    expect(dump).not.toContain(bearer);
    // Only the four safe fields exist.
    expect(Object.keys(obs[0]).sort()).toEqual([
      "bearerFingerprint4", "bearerLen", "bearerPresent", "envKeys", "wsUrlHostPort",
    ]);
    expect(obs[0].bearerPresent).toBe(true);
    expect(obs[0].bearerLen).toBe(bearer.length);
    expect(obs[0].wsUrlHostPort).toBe("127.0.0.1:12345");
    // The 4-byte fingerprint is 6 base64url chars max, never the bearer.
    expect(obs[0].bearerFingerprint4.length).toBeLessThan(10);
    expect(obs[0].bearerFingerprint4).not.toBe(bearer);
  });

  test("two distinct bearers -> distinct fingerprints (defense-in-depth uniqueness)", async () => {
    const l = new NoopTuiChildLauncher();
    const env1 = buildAllowlistEnv("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    const env2 = buildAllowlistEnv("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    await l.launch({ wsUrl: "ws://127.0.0.1:1", env: env1 });
    await l.launch({ wsUrl: "ws://127.0.0.1:2", env: env2 });
    const obs = l.seenObservations();
    expect(obs[0].bearerFingerprint4).not.toBe(obs[1].bearerFingerprint4);
  });

  test("terminate is counted", async () => {
    const l = new NoopTuiChildLauncher();
    expect(l.terminatesObserved()).toBe(0);
    await l.terminate();
    await l.terminate();
    expect(l.terminatesObserved()).toBe(2);
  });
});
