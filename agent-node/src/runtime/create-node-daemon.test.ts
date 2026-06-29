import { describe, expect, test } from "bun:test";
import {
  validateFlagValueDaemon,
  buildAnetArgsDaemon,
  minimalEnv,
  loadAndVerifyAnetBin,
} from "./create-node-daemon.js";
import { writeFileSync, mkdirSync, symlinkSync, chmodSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

describe("§4.2.2 daemon-side flag VALUE validator (BLOCKER #2 — defense in depth)", () => {
  test("permissionMode enum", () => {
    expect(() => validateFlagValueDaemon("permissionMode", "default")).not.toThrow();
    expect(() => validateFlagValueDaemon("permissionMode", "plan")).not.toThrow();
    expect(() => validateFlagValueDaemon("permissionMode", "bogus")).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("permissionMode", 123)).toThrow(/flag_value_invalid/);
  });
  test("dangerouslySkipPermissions boolean (string 'true' must be rejected)", () => {
    expect(() => validateFlagValueDaemon("dangerouslySkipPermissions", true)).not.toThrow();
    expect(() => validateFlagValueDaemon("dangerouslySkipPermissions", false)).not.toThrow();
    expect(() => validateFlagValueDaemon("dangerouslySkipPermissions", "true")).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("dangerouslySkipPermissions", 1)).toThrow(/flag_value_invalid/);
  });
  test("maxTurns integer range — 'DROP TABLE' / float / out-of-range rejected", () => {
    expect(() => validateFlagValueDaemon("maxTurns", 50)).not.toThrow();
    expect(() => validateFlagValueDaemon("maxTurns", 1)).not.toThrow();
    expect(() => validateFlagValueDaemon("maxTurns", 9999)).not.toThrow();
    expect(() => validateFlagValueDaemon("maxTurns", "DROP TABLE")).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("maxTurns", 0)).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("maxTurns", 10000)).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("maxTurns", 5.5)).toThrow(/flag_value_invalid/);
  });
  test("budget number with decimals allowed; out-of-range rejected", () => {
    expect(() => validateFlagValueDaemon("budget", 0)).not.toThrow();
    expect(() => validateFlagValueDaemon("budget", 5.5)).not.toThrow();
    expect(() => validateFlagValueDaemon("budget", 1000)).not.toThrow();
    expect(() => validateFlagValueDaemon("budget", -1)).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("budget", 1001)).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("budget", "free")).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("budget", Infinity)).toThrow(/flag_value_invalid/);
  });
  test("timeout integer range", () => {
    expect(() => validateFlagValueDaemon("timeout", 600)).not.toThrow();
    expect(() => validateFlagValueDaemon("timeout", 1)).not.toThrow();
    expect(() => validateFlagValueDaemon("timeout", 86400)).not.toThrow();
    expect(() => validateFlagValueDaemon("timeout", 0)).toThrow(/flag_value_invalid/);
    expect(() => validateFlagValueDaemon("timeout", 86401)).toThrow(/flag_value_invalid/);
  });
  test("unknown key rejected", () => {
    expect(() => validateFlagValueDaemon("evilKey", true)).toThrow(/flag_key_unknown/);
  });
});

describe("buildAnetArgsDaemon now reaches flag value validation", () => {
  test("happy path with mixed flags", () => {
    const args = buildAnetArgsDaemon({
      name: "x", runtime: "claude-agent-sdk", model: "claude-opus-4.6",
      flags: { maxTurns: 50, budget: 5.5, permissionMode: "plan" },
    });
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("50");
    expect(args[args.indexOf("--budget") + 1]).toBe("5.5");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
  });
  test("smuggled string maxTurns rejected by daemon even if hub missed", () => {
    expect(() => buildAnetArgsDaemon({
      name: "x", runtime: "claude-agent-sdk", model: "x",
      flags: { maxTurns: "DROP TABLE" as any },
    })).toThrow(/flag_value_invalid/);
  });
  test("smuggled string dangerouslySkipPermissions rejected", () => {
    expect(() => buildAnetArgsDaemon({
      name: "x", runtime: "claude-agent-sdk", model: "x",
      flags: { dangerouslySkipPermissions: "true" as any },
    })).toThrow(/flag_value_invalid/);
  });
  test("name shell-metachar still rejected (existing validateName, F2)", () => {
    expect(() => buildAnetArgsDaemon({
      name: ";rm -rf /", runtime: "claude-agent-sdk", model: "x",
    })).toThrow(/node_name_invalid/);
  });
  test("runtime enum still enforced", () => {
    expect(() => buildAnetArgsDaemon({
      name: "x", runtime: "bash", model: "x",
    })).toThrow(/runtime_invalid/);
  });
  test("channels non-empty rejected (P1 fail-closed)", () => {
    expect(() => buildAnetArgsDaemon({
      name: "x", runtime: "claude-agent-sdk", model: "x",
      channels: ["telegram"] as any,
    })).toThrow(/channels_not_supported_in_p1/);
  });
});

describe("§4.2.6 B2 loadAndVerifyAnetBin — install-time pin 5-check (BLOCKER #3 hardened)", () => {
  const FIXTURE_DIR = "/tmp/anet-bin-test-fixtures";

  function setup(name: string, body = "#!/bin/sh\necho real"): string {
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const p = join(FIXTURE_DIR, name);
    writeFileSync(p, body, { mode: 0o755 });
    return p;
  }
  function cleanup() {
    try { rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch { /* ok */ }
  }

  test("happy path with hash witness", () => {
    cleanup();
    const p = setup("good", "fake-binary-bytes");
    const expectedHash = createHash("sha256").update("fake-binary-bytes").digest("hex");
    const got = loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_BIN_SHA256: expectedHash,
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",  // test runs as non-root
    });
    expect(got).toBe(p);
    cleanup();
  });

  test("REJECT: no ANET_BIN_ABS at all", () => {
    expect(() => loadAndVerifyAnetBin({
      ANET_DAEMON_PATH_CONF: "/nonexistent",
    })).toThrow(/anet_bin_unsafe_path.*no ANET_BIN_ABS/);
  });

  test("REJECT: relative path", () => {
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: "anet",
      ANET_DAEMON_PATH_CONF: "/nonexistent",
    })).toThrow(/anet_bin_unsafe_path.*not absolute/);
  });

  test("REJECT: symlink (contains symlink component)", () => {
    cleanup();
    const realBin = setup("real", "real-content");
    const symlinkPath = join(FIXTURE_DIR, "via-symlink");
    try { unlinkSync(symlinkPath); } catch { /* ok */ }
    symlinkSync(realBin, symlinkPath);
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: symlinkPath,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*symlink/);
    cleanup();
  });

  test("REJECT: world-writable (mode 0o777)", () => {
    cleanup();
    const p = setup("world-writable");
    chmodSync(p, 0o777);
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*writable by group\/other/);
    cleanup();
  });

  test("REJECT: group-writable (mode 0o775)", () => {
    cleanup();
    const p = setup("group-writable");
    chmodSync(p, 0o775);
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*writable by group\/other/);
    cleanup();
  });

  test("REJECT: not executable (mode 0o644)", () => {
    cleanup();
    const p = setup("not-exec");
    chmodSync(p, 0o644);
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*not executable/);
    cleanup();
  });

  test("REJECT: owner not root (no opt-out)", () => {
    cleanup();
    const p = setup("non-root-owner");
    // test runs as non-root by default; owner=current uid (not 0)
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      // ANET_DAEMON_ALLOW_NON_ROOT_BIN intentionally NOT set
    })).toThrow(/anet_bin_unsafe_path.*owner not root/);
    cleanup();
  });

  test("ACCEPT: owner not root WHEN ANET_DAEMON_ALLOW_NON_ROOT_BIN=1 (explicit opt-out)", () => {
    cleanup();
    const p = setup("explicit-non-root");
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    })).not.toThrow();
    cleanup();
  });

  test("REJECT: sha256 mismatch with install witness", () => {
    cleanup();
    const p = setup("hash-changed", "current-bytes");
    const installTimeHash = createHash("sha256").update("install-time-bytes-different").digest("hex");
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_BIN_SHA256: installTimeHash,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*sha256 mismatch/);
    cleanup();
  });
});

describe("minimalEnv defensive compose (BLOCKER #1+#2 lineage — kept stable)", () => {
  test("happy path: no extra → PATH includes daemon's own node bin dir + SAFE_PATH (issue #301 nvm fix)", () => {
    const env = minimalEnv();
    // PATH now starts with daemon's process.execPath dirname so spawned
    // children's `#!/usr/bin/env node` shebang can find node under nvm /
    // pnpm / Bun installs. SAFE_PATH follows; if execDir is already a
    // canonical SAFE_PATH entry (e.g. /usr/local/bin), no duplicate.
    const SAFE_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
    const execDir = require("node:path").dirname(process.execPath);
    if (SAFE_PATH.split(":").includes(execDir)) {
      expect(env.PATH).toBe(SAFE_PATH);
    } else {
      expect(env.PATH).toBe(`${execDir}:${SAFE_PATH}`);
      // Critically: execDir is FIRST so spawned child's env node resolves
      // to daemon's own node (anti shebang-fail in nvm context).
      expect(env.PATH!.startsWith(execDir)).toBe(true);
    }
    expect(env.HOME).toBeDefined();
    expect(env.LANG).toBeDefined();
  });
  test("legitimate extra key passes + fixed PATH keeps execPath prepend (issue #301)", () => {
    const env = minimalEnv({ ANTHROPIC_API_KEY: "x" });
    expect(env.ANTHROPIC_API_KEY).toBe("x");
    // PATH still includes SAFE_PATH segment
    expect(env.PATH).toContain("/usr/local/bin");
    expect(env.PATH).toContain("/usr/bin");
  });
  test("THROWS on reserved key in extra (LD_PRELOAD smuggled by attacker)", () => {
    expect(() => minimalEnv({ LD_PRELOAD: "/tmp/evil.so" })).toThrow(/reserved env key/);
  });
  test("THROWS on fixed key in extra (PATH smuggled — caller cannot override the trust-root execPath prepend)", () => {
    expect(() => minimalEnv({ PATH: "/tmp/evil-bin" })).toThrow(/reserved env key|fixed env key/);
  });
  test("C1 invariant — issue #301 fix does NOT widen attacker surface: PATH source is process.execPath (daemon's already-resolved node), NOT env.PATH (attacker C1 surface)", () => {
    // We do NOT read process.env.PATH; we use process.execPath.
    // Sanity proof: read the source file, confirm no env.PATH reference
    // in computeChildPath / minimalEnv code path.
    const src = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "create-node-daemon.ts"), "utf-8",
    );
    // Extract computeChildPath function body
    const m = src.match(/function computeChildPath\(\)[\s\S]+?\n\}/);
    expect(m).toBeTruthy();
    if (m) {
      expect(m[0]).toContain("process.execPath");
      expect(m[0]).not.toMatch(/process\.env\.PATH/);   // explicit anti-C1 invariant
    }
  });
});

// PR3 #338 / RFC-026 §9.3 D2 — fail-fast spawn detection primitive.
// 通信龙 mandate: "真起子进程测——按你说的需要真 binary / Docker 就走 Docker，
// 别 mock 糊弄". claimAndSpawnChild's full path is wired through hub MCP +
// SSE doorbell; that's covered by the integration test fixture. These two
// tests pin the BEHAVIORAL PRIMITIVE my new 5s window relies on, using real
// `node` subprocesses (no mocks): kill-0 raises ESRCH if pid is dead, succeeds
// if alive. If Node's child_process / process.kill semantics ever drift, the
// fail-fast code silently breaks — these tests catch that.
describe("FAIL_FAST_MS primitive — real subprocess kill-0 lifecycle", () => {
  test("child that exits within window → process.kill(pid, 0) raises ESRCH after wait", async () => {
    const { spawn } = await import("node:child_process");
    // Real Node subprocess; exits ~50ms after spawn.
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(1), 50)"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);
    child.unref();
    // Wait 500ms — well past the 50ms child exit.
    await new Promise(r => setTimeout(r, 500));
    // kill-0 must raise (child is dead → ESRCH).
    let threw = false;
    try { process.kill(pid, 0); } catch { threw = true; }
    expect(threw).toBe(true);
  });

  test("child that survives window → process.kill(pid, 0) succeeds", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 10000)"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);
    child.unref();
    // 200ms wait — child still in its 10s sleep.
    await new Promise(r => setTimeout(r, 200));
    // kill-0 must succeed (child alive).
    expect(() => process.kill(pid, 0)).not.toThrow();
    // cleanup so the test doesn't leave a child running 10s post-suite.
    try { process.kill(pid, "SIGKILL"); } catch { /* may already exit */ }
  });
});
