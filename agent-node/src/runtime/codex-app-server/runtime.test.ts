// RFC-030 — unit tests for the owned codex app-server argv builder + the
// Wave-1B spawn-env scrubber.
//
// Wave 1B (dispatch item 5) REMOVED the CommHub MCP token injection from
// the production path: no `mcp_servers.commhub.*` argv, no token env var.
// These tests lock the new posture — argv carries only approval/sandbox
// overrides, and scrubSpawnEnv strips every piece of anet token material
// before a codex process is spawned.

import { describe, expect, test } from "bun:test";
import {
  buildOwnedAppServerArgs,
  scrubSpawnEnv,
  SENSITIVE_ENV_PATTERN,
} from "./runtime";

const URL = "ws://127.0.0.1:24555";

describe("buildOwnedAppServerArgs", () => {
  test("no opts → EXPLICIT Phase-1 pins (never inherit codex config.toml defaults)", () => {
    // 副指挥 P0: argv is always explicit. An unset field pins to the
    // Phase-1 profile instead of whatever the host config.toml says.
    expect(buildOwnedAppServerArgs(URL)).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=read-only",
      "--listen", URL,
    ]);
  });

  test("approval_policy set → sandbox still explicitly pinned", () => {
    expect(buildOwnedAppServerArgs(URL, { approvalPolicy: "never" })).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=read-only",
      "--listen", URL,
    ]);
  });

  test("sandbox_mode set → approval still explicitly pinned (builder is pure; the RUNTIME gate refuses non-Phase-1 values)", () => {
    expect(buildOwnedAppServerArgs(URL, { sandboxMode: "workspace-write" })).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=workspace-write",
      "--listen", URL,
    ]);
  });

  test("both overrides → stable order (policy first), --listen last", () => {
    expect(
      buildOwnedAppServerArgs(URL, { approvalPolicy: "never", sandboxMode: "read-only" }),
    ).toEqual([
      "app-server",
      "-c", "approval_policy=never",
      "-c", "sandbox_mode=read-only",
      "--listen", URL,
    ]);
  });

  test("Wave 1B: argv NEVER contains CommHub MCP wiring or token material", () => {
    const args = buildOwnedAppServerArgs(URL, {
      approvalPolicy: "never",
      sandboxMode: "read-only",
    });
    const joined = args.join(" ");
    expect(joined).not.toContain("mcp_servers.commhub");
    expect(joined).not.toContain("bearer_token");
    expect(joined).not.toMatch(/ntok_|utok_|Bearer /);
  });
});

describe("scrubSpawnEnv — Wave 1B token isolation", () => {
  test("token-named keys are dropped, benign keys survive", () => {
    const clean = scrubSpawnEnv({
      PATH: "/usr/bin",
      ANET_CODEX_COMMHUB_TOKEN: "ntok_x1",
      COMMHUB_TOKEN: "ntok_x2",
      NTOK: "anything",
      LANG: "en_US.UTF-8",
    });
    expect(clean.PATH).toBe("/usr/bin");
    expect(clean.LANG).toBe("en_US.UTF-8");
    expect(clean.ANET_CODEX_COMMHUB_TOKEN).toBeUndefined();
    expect(clean.COMMHUB_TOKEN).toBeUndefined();
    expect(clean.NTOK).toBeUndefined();
  });

  test("values containing an ntok_ literal are dropped even under benign names", () => {
    const clean = scrubSpawnEnv({ TOTALLY_FINE: "see ntok_cafe01 here", OK: "yes" });
    expect(clean.TOTALLY_FINE).toBeUndefined();
    expect(clean.OK).toBe("yes");
  });

  test("pattern matches historical injection var names", () => {
    for (const k of ["ANET_CODEX_COMMHUB_TOKEN", "COMMHUB_MCP_TOKEN", "NTOK", "ANET_TOKEN"]) {
      expect(SENSITIVE_ENV_PATTERN.test(k)).toBe(true);
    }
    for (const k of ["PATH", "HOME", "TERM", "NODE_ENV"]) {
      expect(SENSITIVE_ENV_PATTERN.test(k)).toBe(false);
    }
  });
});
