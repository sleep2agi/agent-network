import { describe, expect, test } from "bun:test";
import {
  validateFlagValueDaemon,
  buildAnetArgsDaemon,
  minimalEnv,
  loadAndVerifyAnetBin,
  ensureGlobalAnetConfig,
  reconcilePendingCreateRequestsOnConnect,
} from "./create-node-daemon.js";
import { writeFileSync, mkdirSync, symlinkSync, chmodSync, unlinkSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

describe("create_node pending reconciliation after SSE connect", () => {
  test("pulls and handles pending requests that arrived while SSE was disconnected", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const handled: string[] = [];

    await reconcilePendingCreateRequestsOnConnect({
      callCommHub: async (tool, args) => {
        calls.push({ tool, args });
        if (tool === "list_my_pending_create_requests") {
          return { ok: true, count: 1, requests: [{ request_id: "cr_missed_doorbell" }] };
        }
        throw new Error(`unexpected tool ${tool}`);
      },
      handleCreateNodeDoorbell: async (event) => {
        handled.push(event.request_id);
      },
      log: () => {},
      warn: () => {},
    });

    expect(calls.map((c) => c.tool)).toEqual(["list_my_pending_create_requests"]);
    expect(handled).toEqual(["cr_missed_doorbell"]);
  });

  test("deduplicates request_ids already handled from the live SSE doorbell path", async () => {
    const handled: string[] = [];

    await reconcilePendingCreateRequestsOnConnect({
      callCommHub: async () => ({
        ok: true,
        count: 3,
        requests: [
          { request_id: "cr_live" },
          { request_id: "cr_live" },
          { request_id: "cr_pending" },
        ],
      }),
      handleCreateNodeDoorbell: async (event) => {
        handled.push(event.request_id);
      },
      recentlyHandledRequestIds: new Set(["cr_live"]),
      log: () => {},
      warn: () => {},
    });

    expect(handled).toEqual(["cr_pending"]);
  });
});

describe("#633 daemon private state", () => {
  const fixture = "/tmp/anet-test633-daemon-private";

  test("global config repair and replacement converge to private state", () => {
    rmSync(fixture, { recursive: true, force: true });
    const parent = join(fixture, ".anet");
    const config = join(parent, "config.json");
    mkdirSync(parent, { recursive: true, mode: 0o755 });
    writeFileSync(config, JSON.stringify({ token: "ntok_fixture", hub: "old" }), { mode: 0o666 });
    chmodSync(config, 0o666);

    ensureGlobalAnetConfig(fixture, "http://hub.test");

    expect(statSync(parent).mode & 0o777).toBe(0o700);
    expect(statSync(config).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(config, "utf8"))).toEqual({
      token: "ntok_fixture",
      hub: "http://hub.test",
    });
    rmSync(fixture, { recursive: true, force: true });
  });

  test("global config read refuses a symlink without touching its target", () => {
    rmSync(fixture, { recursive: true, force: true });
    const parent = join(fixture, ".anet");
    const config = join(parent, "config.json");
    const victim = join(fixture, "victim.json");
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    writeFileSync(victim, '{"sentinel":"unchanged"}\n', { mode: 0o600 });
    symlinkSync(victim, config);

    expect(() => ensureGlobalAnetConfig(fixture, "http://hub.test")).toThrow(/linked|refuses/);
    expect(readFileSync(victim, "utf8")).toBe('{"sentinel":"unchanged"}\n');
    rmSync(fixture, { recursive: true, force: true });
  });
});

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
  test("omitted model is allowed and does not emit --model", () => {
    const args = buildAnetArgsDaemon({
      name: "x", runtime: "claude-agent-sdk",
      flags: { maxTurns: 50 },
    });
    expect(args).toEqual(["node", "create", "x", "--runtime", "claude-agent-sdk", "--max-turns", "50"]);
  });
  test("empty model is still rejected", () => {
    expect(() => buildAnetArgsDaemon({
      name: "x", runtime: "claude-agent-sdk", model: "",
    })).toThrow(/model_invalid/);
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
    const pkgDir = join(FIXTURE_DIR, `${name}-pkg`);
    const binDir = join(pkgDir, "dist", "bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(pkgDir, "package.json"), JSON.stringify({
      name: "@sleep2agi/agent-network",
      bin: { anet: "dist/bin/anet.cjs" },
    }));
    const p = join(binDir, "anet.cjs");
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
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
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

  test("REJECT: ANET_BIN_ABS env fallback without explicit opt-in", () => {
    cleanup();
    const p = setup("env-fallback-disabled");
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
    })).toThrow(/ANET_BIN_ABS env fallback disabled.*ANET_DAEMON_ALLOW_ENV_BIN=1/);
    cleanup();
  });

  test("ACCEPT: ANET_BIN_ABS env fallback when explicitly opted in", () => {
    cleanup();
    const p = setup("env-fallback-enabled");
    expect(loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
      ANET_DAEMON_PATH_CONF: "/nonexistent",
    })).toBe(p);
    cleanup();
  });

  test("path.conf wins over ANET_BIN_ABS env fallback", () => {
    cleanup();
    const confBin = setup("conf-bin");
    const envBin = setup("env-bin");
    const conf = join(FIXTURE_DIR, "path.conf");
    writeFileSync(conf, `ANET_BIN_ABS=${confBin}\n`);
    expect(loadAndVerifyAnetBin({
      ANET_DAEMON_PATH_CONF: conf,
      ANET_BIN_ABS: envBin,
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
    })).toBe(confBin);
    cleanup();
  });

  test("REJECT: relative path", () => {
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: "anet",
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
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
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*symlink/);
    cleanup();
  });

  test("REJECT: non-anet absolute path is not chmodded", () => {
    cleanup();
    mkdirSync(FIXTURE_DIR, { recursive: true });
    const p = join(FIXTURE_DIR, "not-anet");
    writeFileSync(p, "#!/bin/sh\necho nope", { mode: 0o777 });
    chmodSync(p, 0o777);
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*not an anet package bin/);
    expect(statSync(p).mode & 0o777).toBe(0o777);
    cleanup();
  });

  test("REJECT: forged agent-network package bin is not chmodded", () => {
    cleanup();
    const p = setup("forged", "#!/usr/bin/env node\n// fake\n");
    chmodSync(p, 0o777);
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*writable by group\/other/);
    expect(statSync(p).mode & 0o777).toBe(0o777);
    cleanup();
  });

  test("REJECT: world-writable (mode 0o777) without chmodding", () => {
    cleanup();
    const p = setup("world-writable");
    chmodSync(p, 0o777);
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*writable by group\/other/);
    expect(statSync(p).mode & 0o777).toBe(0o777);
    cleanup();
  });

  test("REJECT: group-writable (mode 0o775) without chmodding", () => {
    cleanup();
    const p = setup("group-writable");
    chmodSync(p, 0o775);
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*writable by group\/other/);
    expect(statSync(p).mode & 0o777).toBe(0o775);
    cleanup();
  });

  test("REJECT: not executable (mode 0o644)", () => {
    cleanup();
    const p = setup("not-exec");
    chmodSync(p, 0o644);
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    })).toThrow(/anet_bin_unsafe_path.*not executable/);
    cleanup();
  });

  test("ACCEPT: owner not root by default for nvm/homebrew/user installs", () => {
    cleanup();
    const p = setup("non-root-owner");
    // test runs as non-root by default; owner=current uid (not 0)
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
    })).not.toThrow();
    cleanup();
  });

  // (removed in #1394) the "strict root mode" case tested ANET_DAEMON_STRICT_ROOT_BIN,
  // a behavior that lives in the intentionally-skipped env-fallback commit (see PR body);
  // it only reddened inside root containers where chown to nobody actually works.

  test("REJECT: sha256 mismatch with install witness", () => {
    cleanup();
    const p = setup("hash-changed", "current-bytes");
    const installTimeHash = createHash("sha256").update("install-time-bytes-different").digest("hex");
    expect(() => loadAndVerifyAnetBin({
      ANET_BIN_ABS: p,
      ANET_BIN_SHA256: installTimeHash,
      ANET_DAEMON_PATH_CONF: "/nonexistent",
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
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

// RFC-027 PR1 v3 — BLOCKER-1 lock. The recorded child_node_id MUST match
// the hub's canonical derivation `node_${request_id.replace(/^cr_/,"")}`
// (server/src/tools.ts ~363 mints the child config with this exact id,
// and the child's later register call uses it as the nodes.node_id; the
// same string flows back to the daemon via get_stop_request as
// child_node_id). PR1 v2 fell back to `node_${alias}` when an absent
// child_node_id field was missing from get_create_request — every stop
// dispatch then noop'd at the daemon. This test pins the key shape so
// the fallback can't drift back in.
describe("RFC-027 BLOCKER-1 — childrenMap key shape matches hub canonical node_id", () => {
  test("derive key from request_id, not alias", () => {
    const request_id = "cr_abc123def456";
    const expected = `node_${request_id.replace(/^cr_/, "")}`;
    expect(expected).toBe("node_abc123def456");
    // Hub server/src/tools.ts:363 writes EXACTLY this expression into
    // the child's config.json node_id — keep them byte-identical or
    // stop/delete will silently no-op.
  });

  // #1293 —— 记录必须在 +5000ms 能力检查**之前**发生,否则 hub 认识子节点、
  // daemon 不认,中间约 5 秒里 stop/delete 全部 ack `noop_not_my_child`。
  // 提前记录必须配一次回滚,否则能力检查失败会留一条指向死 pid 的条目。
  test("#1293 forgetSpawnedChild undoes an early record (capability-fail rollback)", async () => {
    const { recordSpawnedChild, forgetSpawnedChild, getChildrenSnapshot, _resetChildrenMapForTest } =
      await import("./stop-daemon");
    _resetChildrenMapForTest();
    const id = "node_cap_fail_rollback";
    recordSpawnedChild(id, "doomed-child", 4242);
    expect(getChildrenSnapshot().length).toBe(1);

    // 回滚:返回 true 表示确实删掉了一条 —— 调用方据此判断「我记过吗」,不靠假设
    expect(forgetSpawnedChild(id)).toBe(true);
    expect(getChildrenSnapshot().length).toBe(0);

    // 🔴 幂等 + 诚实:再删一次必须返回 false,而不是静默成功。
    //    一个「删不存在的东西也说成功」的 API,会让调用方无法区分
    //    「我记过并撤销了」和「我根本没记上」。
    expect(forgetSpawnedChild(id)).toBe(false);

    // 只删指定的那一条,不误伤兄弟
    recordSpawnedChild("node_a", "a", 1);
    recordSpawnedChild("node_b", "b", 2);
    expect(forgetSpawnedChild("node_a")).toBe(true);
    const rest = getChildrenSnapshot();
    expect(rest.length).toBe(1);
    expect(rest[0].child_node_id).toBe("node_b");
    _resetChildrenMapForTest();
  });

  // 🔴 源码级断言:证明 record 真的排在能力检查之前。
  //    上面那个用例只测 forgetSpawnedChild 这个零件 —— 它在旧代码上**照样会绿**,
  //    因为顺序错不影响这个函数本身。顺序是这条 issue 的全部内容,必须单独钉。
  test("#1293 recordSpawnedChild is invoked BEFORE the FAIL_FAST capability wait", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./create-node-daemon.ts", import.meta.url), "utf8");
    const iRecord = src.indexOf("recordSpawnedChild(child_node_id");
    const iWait = src.indexOf("const FAIL_FAST_MS");
    const iRollback = src.indexOf("forgetSpawnedChild(`node_${request_id");
    expect(iRecord).toBeGreaterThan(-1);
    expect(iWait).toBeGreaterThan(-1);
    expect(iRollback).toBeGreaterThan(-1);
    expect(iRecord).toBeLessThan(iWait);      // 记录在等待之前
    expect(iRollback).toBeGreaterThan(iWait); // 回滚在等待之后的失败路径上
  });

  test("recordSpawnedChild end-to-end with the canonical key — stop-daemon can find it", async () => {
    const { recordSpawnedChild, getChildrenSnapshot, _resetChildrenMapForTest } =
      await import("./stop-daemon");
    _resetChildrenMapForTest();
    const request_id = "cr_e2e_lookup_test";
    const child_node_id = `node_${request_id.replace(/^cr_/, "")}`;
    recordSpawnedChild(child_node_id, "alias-xyz", 12345);
    const snap = getChildrenSnapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].child_node_id).toBe("node_e2e_lookup_test");
    expect(snap[0].alias).toBe("alias-xyz");
    expect(snap[0].pid).toBe(12345);
    _resetChildrenMapForTest();
  });
});
