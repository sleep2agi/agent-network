// RFC-030 Wave 1A P0.2 — tui-child-launcher.ts tests.

import { describe, expect, test } from "bun:test";
import {
  NoopTuiChildLauncher,
  buildAllowlistEnv,
} from "./tui-child-launcher";

describe("NoopTuiChildLauncher — interface-level fake", () => {
  test("launch records the request; never spawns", async () => {
    const l = new NoopTuiChildLauncher();
    const req = {
      wsUrl: "ws://127.0.0.1:12345",
      bearerEnvName: "ANET_CODEX_TUI_BEARER",
      env: { ANET_CODEX_TUI_BEARER: "abc" },
    };
    const out = await l.launch(req);
    expect(out.spawned).toBe(false);
    expect(l.seenRequests).toHaveLength(1);
    expect(l.seenRequests[0]).toBe(req);
  });

  test("terminate() count observable", async () => {
    const l = new NoopTuiChildLauncher();
    expect(l.terminatesObserved()).toBe(0);
    await l.terminate();
    await l.terminate();
    expect(l.terminatesObserved()).toBe(2);
  });
});

describe("buildAllowlistEnv — explicit allowlist enforcement", () => {
  test("happy path: adds bearer under the named env var", () => {
    const env = buildAllowlistEnv("ANET_CODEX_TUI_BEARER", "the-bearer-value");
    expect(env.ANET_CODEX_TUI_BEARER).toBe("the-bearer-value");
    expect(Object.keys(env).sort()).toEqual(["ANET_CODEX_TUI_BEARER"]);
  });

  test("frozen result: cannot be mutated after construction", () => {
    const env = buildAllowlistEnv("BEARER_NAME", "v");
    // Casting to Record so the runtime attempt is visible.
    expect(() => {
      (env as Record<string, string>).EXTRA = "leak";
    }).toThrow();
  });

  test("empty bearerEnvName throws", () => {
    expect(() => buildAllowlistEnv("", "v")).toThrow(/bearerEnvName/);
  });

  test("empty bearerValue throws", () => {
    expect(() => buildAllowlistEnv("BEARER_NAME", "")).toThrow(/bearerValue/);
  });

  test("additional key on CommHub denylist throws", () => {
    for (const bad of [
      "ANET_CODEX_COMMHUB_TOKEN",
      "COMMHUB_MCP_TOKEN",
      "ANET_TOKEN",
      "COMMHUB_ADMIN_TOKEN",
    ]) {
      expect(() =>
        buildAllowlistEnv("BEARER_NAME", "v", { [bad]: "leak" }),
      ).toThrow(/denylist/);
    }
  });

  test("additional key matching CommHub prefix pattern throws", () => {
    for (const bad of ["NTOK_abc", "UTOK_something", "NTOK", "ANET_COMMHUB_FOO"]) {
      expect(() =>
        buildAllowlistEnv("BEARER_NAME", "v", { [bad]: "leak" }),
      ).toThrow(/denylist/);
    }
  });

  test("legitimate additional keys pass through (e.g. CODEX_HOME)", () => {
    const env = buildAllowlistEnv("BEARER_NAME", "v", {
      CODEX_HOME: "/tmp/codex-tmp",
      PATH: "/usr/bin:/bin",
    });
    expect(env.CODEX_HOME).toBe("/tmp/codex-tmp");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.BEARER_NAME).toBe("v");
  });
});
