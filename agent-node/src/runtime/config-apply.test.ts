// Coverage for the node-side config-apply runtime — pure helpers that
// don't need a real hub, real fs in tmp dirs for atomic-write / boot
// self-heal / .prev backup paths.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  validateLocalPatch,
  computeApplyMode,
  atomicWriteJson,
  atomicWritePrivateText,
  backupConfigPrev,
  repairPrivateConfigPermissions,
  loadConfigWithSelfHeal,
  mergePatch,
  buildConfigSnapshot,
  RESTART_SENTINEL,
} from "./config-apply";

let scratch = "";
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "rfc024-"));
});
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("RESTART_SENTINEL — exact value pin", () => {
  test("equals 75 (BSD EX_TEMPFAIL semantics, parent supervisor checks this exact code)", () => {
    expect(RESTART_SENTINEL).toBe(75);
  });
});

describe("#633 private text writer", () => {
  test("replaces a leaf symlink without following it", () => {
    const managed = join(scratch, ".anet");
    const victim = join(scratch, "victim.txt");
    const secret = join(managed, ".env.local");
    mkdirSync(managed, { recursive: true, mode: 0o700 });
    writeFileSync(victim, "victim-unchanged\n", { mode: 0o600 });
    symlinkSync(victim, secret);

    atomicWritePrivateText(secret, "PRIVATE_FIXTURE=1\n");

    expect(readFileSync(victim, "utf8")).toBe("victim-unchanged\n");
    expect(lstatSync(secret).isSymbolicLink()).toBe(false);
    expect(readFileSync(secret, "utf8")).toBe("PRIVATE_FIXTURE=1\n");
    expect(lstatSync(secret).mode & 0o777).toBe(0o600);
  });
});

describe("validateLocalPatch — defense-in-depth", () => {
  test("undefined model + empty flags passes (no-op patch)", () => {
    expect(validateLocalPatch({})).toBeNull();
  });
  test("valid full patch passes", () => {
    expect(validateLocalPatch({ model: "claude-opus-4", flags: { maxTurns: 50, budget: 100 } })).toBeNull();
  });
  test("unknown flag rejected (even if hub validator drifts loose)", () => {
    const r = validateLocalPatch({ flags: { godmode: true } as any });
    expect(r?.field).toBe("flags.godmode");
  });
  test("permissionMode invalid enum rejected", () => {
    const r = validateLocalPatch({ flags: { permissionMode: "leetmode" } as any });
    expect(r?.field).toBe("flags.permissionMode");
  });
  test("dangerouslySkipPermissions non-boolean rejected", () => {
    const r = validateLocalPatch({ flags: { dangerouslySkipPermissions: 1 } as any });
    expect(r?.field).toBe("flags.dangerouslySkipPermissions");
  });
  test("maxTurns out of range rejected", () => {
    expect(validateLocalPatch({ flags: { maxTurns: -1 } })?.field).toBe("flags.maxTurns");
    expect(validateLocalPatch({ flags: { maxTurns: 10001 } })?.field).toBe("flags.maxTurns");
  });
  test("timeout invalid rejected", () => {
    expect(validateLocalPatch({ flags: { timeout: 5_000_000 } })?.field).toBe("flags.timeout");
    expect(validateLocalPatch({ flags: { timeout: -1 } })?.field).toBe("flags.timeout");
  });
  test("empty-string model rejected", () => {
    expect(validateLocalPatch({ model: "" })?.field).toBe("model");
  });
});

describe("computeApplyMode — tier classifier", () => {
  test("empty patch → restart_only (restart_node)", () => {
    expect(computeApplyMode({})).toBe("restart_only");
  });
  test("model only → restart", () => {
    expect(computeApplyMode({ model: "claude-opus-4" })).toBe("restart");
  });
  test("permissionMode → restart", () => {
    expect(computeApplyMode({ flags: { permissionMode: "auto" } })).toBe("restart");
  });
  test("dangerouslySkipPermissions → restart", () => {
    expect(computeApplyMode({ flags: { dangerouslySkipPermissions: true } })).toBe("restart");
  });
  test("teammateMode no longer in allowlist → ignored by classifier (returns hot since no restart-required flag matches)", () => {
    // teammateMode dropped from P1 schema per #290 review — not consumed
    // by agent-node runtimes. classifier no longer keys on it.
    expect(computeApplyMode({ flags: { teammateMode: false } as any })).toBe("hot");
  });
  test("timeout → restart", () => {
    expect(computeApplyMode({ flags: { timeout: 60000 } })).toBe("restart");
  });
  test("maxTurns only → hot", () => {
    expect(computeApplyMode({ flags: { maxTurns: 50 } })).toBe("hot");
  });
  test("budget only → hot", () => {
    expect(computeApplyMode({ flags: { budget: 100 } })).toBe("hot");
  });
  test("mixed (model + maxTurns) → restart (strictest wins)", () => {
    expect(computeApplyMode({ model: "x", flags: { maxTurns: 50 } })).toBe("restart");
  });
});

describe("atomicWriteJson — temp + rename", () => {
  test("creates file with JSON content + trailing newline", () => {
    const path = join(scratch, "config.json");
    atomicWriteJson(path, { foo: 1, nested: { bar: "baz" } });
    const txt = readFileSync(path, "utf-8");
    expect(JSON.parse(txt)).toEqual({ foo: 1, nested: { bar: "baz" } });
    expect(txt.endsWith("\n")).toBe(true);
  });

  test("overwrites existing file atomically (no .tmp left behind)", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, '{"old": true}');
    atomicWriteJson(path, { new: true });
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ new: true });
    // No .tmp file should remain after the rename.
    const tmpFiles = require("node:fs").readdirSync(scratch).filter((f: string) => f.includes(".tmp."));
    expect(tmpFiles.length).toBe(0);
  });
});

describe("#472 private config permissions", () => {
  const mode = (path: string) => lstatSync(path).mode & 0o777;

  for (const mask of [0o000, 0o002, 0o022, 0o077]) {
    test(`atomic write is 0600 under umask ${mask.toString(8)}`, () => {
      const parent = join(scratch, ".anet", "nodes", "n_test");
      mkdirSync(parent, { recursive: true });
      const path = join(parent, "config.json");
      chmodSync(parent, 0o777);
      const previous = process.umask(mask);
      try { atomicWriteJson(path, { token: "ntok_synthetic" }); }
      finally { process.umask(previous); }
      expect(mode(path)).toBe(0o600);
      expect(mode(parent)).toBe(0o700);
    });
  }

  test("repairs existing primary, backup, and parent before token read", () => {
    const parent = join(scratch, ".anet", "nodes", "n_test");
    mkdirSync(parent, { recursive: true });
    const path = join(parent, "config.json");
    writeFileSync(path, JSON.stringify({ token: "ntok_primary" }));
    writeFileSync(`${path}.prev`, JSON.stringify({ token: "ntok_backup" }));
    chmodSync(parent, 0o775);
    chmodSync(path, 0o664);
    chmodSync(`${path}.prev`, 0o644);
    repairPrivateConfigPermissions(path);
    expect(mode(parent)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
    expect(mode(`${path}.prev`)).toBe(0o600);
  });

  test("custom --config parent is never chmodded", () => {
    const parent = join(scratch, "shared-project");
    mkdirSync(parent);
    chmodSync(parent, 0o750);
    const path = join(parent, "agent.json");
    writeFileSync(path, JSON.stringify({ token: "ntok_custom" }));
    chmodSync(path, 0o664);

    repairPrivateConfigPermissions(path);

    expect(mode(parent)).toBe(0o750);
    expect(mode(path)).toBe(0o600);
  });

  test("atomic custom --config write preserves parent mode", () => {
    const parent = join(scratch, "shared-project");
    mkdirSync(parent);
    chmodSync(parent, 0o755);
    const path = join(parent, "agent.json");

    atomicWriteJson(path, { token: "ntok_custom" });

    expect(mode(parent)).toBe(0o755);
    expect(mode(path)).toBe(0o600);
  });

  // 🔴 #874 —— Windows 上 fchmodSync 抛 EPERM，fail-closed 把所有 runtime 挡死。
  //    我没有 Windows 机器，所以**注入 platform** 来验分支被走到，
  //    而不是拿「我试过了」当证据。这两条测的是：
  //      · win32 分支不再抛（改之前这里会 throw，节点因此起不来）
  //      · POSIX 分支的行为**一个字节都没变**（下面那条是现有测试的 win32 对照）
  test("#874 win32: does not throw, and leaves modes untouched", () => {
    const parent = join(scratch, ".anet", "nodes", "n_win");
    mkdirSync(parent, { recursive: true });
    const path = join(parent, "config.json");
    writeFileSync(path, JSON.stringify({ token: "ntok_win" }));
    chmodSync(parent, 0o775);
    chmodSync(path, 0o664);

    // 🔴 这一行在 Linux 上几乎是免费的 —— `fchmodSync` 在这里本来就不会抛。
    //    它记录意图，但**不承重**。
    expect(() => repairPrivateConfigPermissions(path, "win32")).not.toThrow();

    // 🔴 承重的是下面两行：win32 分支**确实跳过了 chmod**（撤掉守卫后正是这里红）。
    //    必须说清它证明了什么、没证明什么：
    //      证明了 —— platform="win32" 时不再调用 fchmod
    //      **没证明** —— 在真 Windows 上不再抛 EPERM（那要一台 Windows 机）
    //    Windows 上没有 mode 收紧保证，但那不是本次改动造成的：
    //    改之前是崩掉，从来没有过「在 Windows 上收紧成功」这个状态。
    expect(mode(parent)).toBe(0o775);
    expect(mode(path)).toBe(0o664);
  });

  test("#874 posix branch is unchanged (same fixture, platform=linux)", () => {
    const parent = join(scratch, ".anet", "nodes", "n_posix");
    mkdirSync(parent, { recursive: true });
    const path = join(parent, "config.json");
    writeFileSync(path, JSON.stringify({ token: "ntok_posix" }));
    chmodSync(parent, 0o775);
    chmodSync(path, 0o664);

    repairPrivateConfigPermissions(path, "linux");

    expect(mode(parent)).toBe(0o700);
    expect(mode(path)).toBe(0o600);
  });

  test("backup atomically replaces a legacy broad .prev", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, JSON.stringify({ token: "ntok_fresh" }), { mode: 0o600 });
    writeFileSync(`${path}.prev`, JSON.stringify({ token: "ntok_old" }));
    chmodSync(`${path}.prev`, 0o664);
    backupConfigPrev(path);
    expect(mode(`${path}.prev`)).toBe(0o600);
    expect(JSON.parse(readFileSync(`${path}.prev`, "utf8")).token).toBe("ntok_fresh");
  });
});

describe("backupConfigPrev — pre-write snapshot", () => {
  test("copies existing config to .prev", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, '{"v": 1}');
    const r = backupConfigPrev(path);
    expect(r.backedUp).toBe(true);
    expect(readFileSync(`${path}.prev`, "utf-8")).toBe('{"v": 1}');
  });

  test("returns backedUp=false when no config exists yet (first-write case)", () => {
    const path = join(scratch, "config.json");
    expect(backupConfigPrev(path).backedUp).toBe(false);
    expect(existsSync(`${path}.prev`)).toBe(false);
  });

  test("overwrites previous .prev (single-generation rotation)", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, '{"v": 1}');
    backupConfigPrev(path);
    writeFileSync(path, '{"v": 2}');
    backupConfigPrev(path);
    expect(JSON.parse(readFileSync(`${path}.prev`, "utf-8"))).toEqual({ v: 2 });
  });
});

describe("loadConfigWithSelfHeal — boot recovery", () => {
  test("primary parses → returns primary", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, '{"model": "claude-opus-4"}');
    const r = loadConfigWithSelfHeal(path);
    expect(r.source).toBe("primary");
    expect(r.config).toEqual({ model: "claude-opus-4" });
  });

  test("primary corrupted + .prev valid → restores .prev + reports source=prev", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, "{this is not json");
    writeFileSync(`${path}.prev`, '{"recovered": true}');
    const r = loadConfigWithSelfHeal(path);
    expect(r.source).toBe("prev");
    expect(r.config).toEqual({ recovered: true });
    expect(r.primaryError).toBeDefined();
    // Recovery side effect: primary now mirrors .prev.
    expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({ recovered: true });
  });

  test("primary corrupted + no .prev → throws (truly bricked, caller surfaces)", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, "broken");
    expect(() => loadConfigWithSelfHeal(path)).toThrow(/no .prev/);
  });

  test("primary AND .prev corrupted → throws with both errors", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, "broken1");
    writeFileSync(`${path}.prev`, "broken2");
    expect(() => loadConfigWithSelfHeal(path)).toThrow(/parse also failed/);
  });

  test("primary missing entirely → throws (caller will skip / first-boot path)", () => {
    const path = join(scratch, "no-such.json");
    expect(() => loadConfigWithSelfHeal(path)).toThrow();
  });
});

describe("mergePatch — patch + existing → new config (no mutation)", () => {
  test("model replace", () => {
    const existing = { model: "old", flags: { maxTurns: 1 } };
    const next = mergePatch(existing, { model: "new" });
    expect(next.model).toBe("new");
    expect(next.flags.maxTurns).toBe(1);
    // Source not mutated.
    expect(existing.model).toBe("old");
  });

  test("flags merge (does not replace whole flags obj)", () => {
    const existing = { flags: { maxTurns: 1, budget: 5 } };
    const next = mergePatch(existing, { flags: { maxTurns: 99 } });
    expect(next.flags).toEqual({ maxTurns: 99, budget: 5 });
  });

  test("empty existing + patch → patch only", () => {
    expect(mergePatch({}, { model: "x", flags: { budget: 5 } })).toEqual({ model: "x", flags: { budget: 5 } });
  });

  test("empty patch → existing unchanged (deep clone)", () => {
    const existing = { model: "y", flags: { maxTurns: 10 } };
    const next = mergePatch(existing, {});
    expect(next).toEqual(existing);
    expect(next).not.toBe(existing);  // deep clone, not alias
  });
});

describe("buildConfigSnapshot — pure helper contract (#290 final, drain-omit guard)", () => {
  // The premature-finalize fix in cli.ts.reportStatus omits
  // config_snapshot from the report payload when configApplyDraining
  // is true. buildConfigSnapshot itself stays pure (no global state
  // reads) so this test verifies the snapshot is always shape-valid
  // and the caller is the only place that decides whether to send
  // it. If anyone tries to fold drain detection into the builder, the
  // pure-helper signature changes and this test forces a re-think.
  test("buildConfigSnapshot returns a valid snapshot regardless of caller drain state (pure)", () => {
    const s = buildConfigSnapshot(
      { model: "m", flags: { maxTurns: 50 } },
      true,
      3,
    );
    expect(s.model).toBe("m");
    expect(s.flags.maxTurns).toBe(50);
    expect(s.config_revision).toBe(3);
    expect(s.config_update_capable).toBe(true);
    expect(s.peer_reply_inbox_capable).toBe(true);
  });
});

describe("validateLocalPatch — teammateMode dropped (#290 review)", () => {
  // teammateMode no longer in ALLOWED_FLAGS for agent-node runtimes
  // (consumer only exists in agent-network's claude-code-cli spawn,
  // not in agent-node). Patch should now be rejected as not-in-allowlist.
  test("teammateMode rejected (was: allowed boolean; now: not-in-allowlist)", () => {
    const r = validateLocalPatch({ flags: { teammateMode: true } as any });
    expect(r?.field).toBe("flags.teammateMode");
    expect(r?.reason).toMatch(/allowlist/i);
  });
});

describe("computeApplyMode — teammateMode is no longer restart-required (#290 review)", () => {
  test("teammateMode-only patch → hot (no longer in RESTART_REQUIRED_FLAGS)", () => {
    // Note: validatePatch would reject this before computeApplyMode
    // ever sees it; this test just pins the classifier's behaviour
    // for the case where teammateMode somehow slipped past the gate.
    expect(computeApplyMode({ flags: { teammateMode: false } as any })).toBe("hot");
  });
});

describe("buildConfigSnapshot — masked report (no secrets)", () => {
  test("includes model + ALLOWED_FLAGS only", () => {
    const file = {
      model: "claude-opus-4",
      flags: { maxTurns: 50, dangerouslySkipPermissions: true, mysteryFlag: "x" },
      env: { SECRET: "should-not-leak" },
      token: "ntok_leak",
    };
    const snap = buildConfigSnapshot(file, true, 3);
    expect(snap.model).toBe("claude-opus-4");
    expect(snap.flags.maxTurns).toBe(50);
    expect(snap.flags.dangerouslySkipPermissions).toBe(true);
    expect("mysteryFlag" in snap.flags).toBe(false);
    expect(snap.config_update_capable).toBe(true);
    expect(snap.peer_reply_inbox_capable).toBe(true);
    expect(snap.config_revision).toBe(3);
    // Critical: no env / token leak.
    expect("env" in snap).toBe(false);
    expect("token" in snap).toBe(false);
  });

  test("missing model → null (not undefined, dashboard renders explicitly)", () => {
    const snap = buildConfigSnapshot({ flags: {} }, false, 0);
    expect(snap.model).toBeNull();
  });

  test("config_update_capable=false signals bare node (no supervisor wrapper)", () => {
    const snap = buildConfigSnapshot({}, false, 0);
    expect(snap.config_update_capable).toBe(false);
  });
});

// PR3 #338 nit ④ — buildConfigSnapshot role + daemon_capabilities wire-format
// lock. PR1 added `role`, PR2 added daemon self-declare at top level, neither
// asserted on the output shape. Hub side reads daemon_capabilities.* canonically
// (tools.ts:2010/2075) so any drift here silently breaks daemon discovery +
// allowlist enforcement.
describe("buildConfigSnapshot — role (PR1 #338)", () => {
  test("role: host_supervisor passes through (string)", () => {
    expect(buildConfigSnapshot({ role: "host_supervisor" }, false, 0).role).toBe("host_supervisor");
  });

  test("role: member passes through", () => {
    expect(buildConfigSnapshot({ role: "member" }, false, 0).role).toBe("member");
  });

  test("role: missing → null (not undefined; dashboard distinguishes)", () => {
    expect(buildConfigSnapshot({}, false, 0).role).toBeNull();
  });

  test("role: non-string narrowed to null (typeof guard)", () => {
    expect(buildConfigSnapshot({ role: 42 }, false, 0).role).toBeNull();
    expect(buildConfigSnapshot({ role: { evil: "obj" } }, false, 0).role).toBeNull();
    expect(buildConfigSnapshot({ role: ["leader"] }, false, 0).role).toBeNull();
    expect(buildConfigSnapshot({ role: null }, false, 0).role).toBeNull();
  });
});

describe("buildConfigSnapshot — daemon_capabilities (PR3 #338 nit ①)", () => {
  test("nests runtimes_supported + allowed_secret_keys + max_concurrent_children", () => {
    const snap = buildConfigSnapshot({
      runtimes_supported: ["claude-agent-sdk", "codex-sdk"],
      allowed_secret_keys: ["ANTHROPIC_API_KEY"],
      max_concurrent_children: 50,
    }, false, 0);
    expect(snap.daemon_capabilities).toEqual({
      runtimes_supported: ["claude-agent-sdk", "codex-sdk"],
      allowed_secret_keys: ["ANTHROPIC_API_KEY"],
      max_concurrent_children: 50,
    });
  });

  test("matches hub canonical path snap.daemon_capabilities.* — NOT at top level", () => {
    // tools.ts:2075 reads exactly `snap?.daemon_capabilities?.max_concurrent_children`.
    // PR1+PR2 mistakenly put fields at top level → hub fell back to the hardcoded
    // 20 default + allowlist enforcement was bypassed. This test pins the location.
    const snap = buildConfigSnapshot({
      runtimes_supported: ["X"],
      allowed_secret_keys: ["Y"],
      max_concurrent_children: 99,
    }, false, 0);
    expect(snap.daemon_capabilities?.max_concurrent_children).toBe(99);
    expect(snap.daemon_capabilities?.runtimes_supported).toEqual(["X"]);
    expect(snap.daemon_capabilities?.allowed_secret_keys).toEqual(["Y"]);
    // The PR1/PR2 misplacement guard:
    expect((snap as any).max_concurrent_children).toBeUndefined();
    expect((snap as any).runtimes_supported).toBeUndefined();
    expect((snap as any).allowed_secret_keys).toBeUndefined();
  });

  test("partial declare: only runtimes_supported emits, others omitted", () => {
    const snap = buildConfigSnapshot({ runtimes_supported: ["claude-agent-sdk"] }, false, 0);
    expect(snap.daemon_capabilities).toEqual({ runtimes_supported: ["claude-agent-sdk"] });
    expect(snap.daemon_capabilities?.allowed_secret_keys).toBeUndefined();
    expect(snap.daemon_capabilities?.max_concurrent_children).toBeUndefined();
  });

  test("missing → daemon_capabilities undefined (regular non-daemon node)", () => {
    expect(buildConfigSnapshot({}, false, 0).daemon_capabilities).toBeUndefined();
  });

  test("typeof narrow: non-array runtimes_supported dropped silently", () => {
    expect(buildConfigSnapshot({ runtimes_supported: "claude-agent-sdk" }, false, 0)
      .daemon_capabilities).toBeUndefined();
    expect(buildConfigSnapshot({ runtimes_supported: 42 }, false, 0)
      .daemon_capabilities).toBeUndefined();
    expect(buildConfigSnapshot({ runtimes_supported: null }, false, 0)
      .daemon_capabilities).toBeUndefined();
  });

  test("typeof narrow: array with non-string element dropped silently", () => {
    expect(buildConfigSnapshot({ runtimes_supported: ["claude-agent-sdk", 42] }, false, 0)
      .daemon_capabilities).toBeUndefined();
    expect(buildConfigSnapshot({ allowed_secret_keys: ["KEY", null] }, false, 0)
      .daemon_capabilities).toBeUndefined();
  });

  test("typeof narrow: max_concurrent_children non-finite or non-positive dropped", () => {
    expect(buildConfigSnapshot({ max_concurrent_children: 0 }, false, 0)
      .daemon_capabilities).toBeUndefined();
    expect(buildConfigSnapshot({ max_concurrent_children: -5 }, false, 0)
      .daemon_capabilities).toBeUndefined();
    expect(buildConfigSnapshot({ max_concurrent_children: "20" }, false, 0)
      .daemon_capabilities).toBeUndefined();
    expect(buildConfigSnapshot({ max_concurrent_children: NaN }, false, 0)
      .daemon_capabilities).toBeUndefined();
    expect(buildConfigSnapshot({ max_concurrent_children: Infinity }, false, 0)
      .daemon_capabilities).toBeUndefined();
  });

  test("partial valid + partial invalid: only valid fields included", () => {
    const snap = buildConfigSnapshot({
      runtimes_supported: ["claude-agent-sdk"],   // valid
      allowed_secret_keys: "not-array",            // invalid → dropped
      max_concurrent_children: 30,                 // valid
    }, false, 0);
    expect(snap.daemon_capabilities).toEqual({
      runtimes_supported: ["claude-agent-sdk"],
      max_concurrent_children: 30,
    });
    expect(snap.daemon_capabilities?.allowed_secret_keys).toBeUndefined();
  });
});

// ── #260 P5 — channels support (restart-tier, defense-in-depth) ────
describe("channels — validateLocalPatch", () => {
  test("valid keys pass", () => {
    expect(validateLocalPatch({ channels: ["telegram"] })).toBeNull();
    expect(validateLocalPatch({ channels: ["feishu"] })).toBeNull();
    expect(validateLocalPatch({ channels: ["telegram", "feishu"] })).toBeNull();
    expect(validateLocalPatch({ channels: [] })).toBeNull();
  });
  test("commhub rejected — not a fork target (cli.ts:673 UNSUPPORTED_CHANNEL guard)", () => {
    const r = validateLocalPatch({ channels: ["commhub"] });
    expect(r?.field).toBe("channels.commhub");
  });
  test("unknown channel key rejected (defense-in-depth vs hub drift)", () => {
    const r = validateLocalPatch({ channels: ["wechat"] });
    expect(r?.field).toBe("channels.wechat");
    expect(r?.reason).toMatch(/allowlist/);
  });
  test("non-array rejected", () => {
    const r = validateLocalPatch({ channels: "telegram" as any });
    expect(r?.field).toBe("channels");
    expect(r?.reason).toMatch(/array/);
  });
  test("non-string element rejected", () => {
    const r = validateLocalPatch({ channels: [42 as any] });
    expect(r?.field).toBe("channels");
  });
  test("more than 16 entries rejected", () => {
    const big = Array.from({ length: 17 }, () => "telegram");
    const r = validateLocalPatch({ channels: big });
    expect(r?.field).toBe("channels");
    expect(r?.reason).toMatch(/16/);
  });
});

describe("channels — computeApplyMode", () => {
  test("channels-present patch is restart-tier", () => {
    expect(computeApplyMode({ channels: ["feishu"] })).toBe("restart");
  });
  test("channels: [] still a state change → restart", () => {
    expect(computeApplyMode({ channels: [] })).toBe("restart");
  });
  test("channels + hot flag upgrades to restart", () => {
    expect(computeApplyMode({ channels: ["telegram"], flags: { maxTurns: 5 } })).toBe("restart");
  });
  test("model + channels → restart", () => {
    expect(computeApplyMode({ model: "gpt-5", channels: ["feishu"] })).toBe("restart");
  });
  test("empty patch → restart_only", () => {
    expect(computeApplyMode({})).toBe("restart_only");
  });
});

describe("channels — mergePatch replaces, does not merge", () => {
  test("channels absent in patch: existing.channels preserved", () => {
    const merged = mergePatch({ channels: ["telegram"], model: "x" }, { model: "y" });
    expect(merged.channels).toEqual(["telegram"]);
    expect(merged.model).toBe("y");
  });
  test("channels present: existing.channels REPLACED wholesale", () => {
    const merged = mergePatch({ channels: ["telegram", "feishu"] }, { channels: ["commhub"] });
    expect(merged.channels).toEqual(["commhub"]);
  });
  test("channels: [] disables all editable channels", () => {
    const merged = mergePatch({ channels: ["telegram", "feishu"] }, { channels: [] });
    expect(merged.channels).toEqual([]);
  });
  test("first-write case (existing has no channels key)", () => {
    const merged = mergePatch({ model: "x" }, { channels: ["feishu"] });
    expect(merged.channels).toEqual(["feishu"]);
  });
  test("defensive clone — patch mutation does not leak into merged", () => {
    const arr = ["feishu"];
    const merged = mergePatch({}, { channels: arr });
    arr.push("telegram");
    expect(merged.channels).toEqual(["feishu"]);
  });
});

// ── #260 P5 codex-catch regression tests ───────────────────────────
describe("mergePatch — path-qualified specs preserved", () => {
  test("bare-type patch preserves existing telegram:/abs/path", () => {
    const existing = { channels: ["telegram:/opt/bots/tg", "feishu:/opt/bots/feishu"] };
    const merged = mergePatch(existing, { channels: ["telegram"] });
    // "telegram" resolves to the existing path-qualified spec.
    expect(merged.channels).toEqual(["telegram:/opt/bots/tg"]);
  });
  test("bare-type patch keeps both when both were path-qualified", () => {
    const existing = { channels: ["telegram:/opt/tg", "feishu:/opt/feishu"] };
    const merged = mergePatch(existing, { channels: ["telegram", "feishu"] });
    expect(merged.channels).toEqual(["telegram:/opt/tg", "feishu:/opt/feishu"]);
  });
  test("bare-type patch adds new bare key when existing had no matching spec", () => {
    const existing = { channels: ["telegram:/opt/tg"] };
    const merged = mergePatch(existing, { channels: ["telegram", "feishu"] });
    expect(merged.channels).toEqual(["telegram:/opt/tg", "feishu"]);
  });
  test("disable-all still works — empty patch wipes even path-qualified specs", () => {
    const existing = { channels: ["telegram:/opt/tg"] };
    const merged = mergePatch(existing, { channels: [] });
    expect(merged.channels).toEqual([]);
  });
  test("first-write no existing channels: bare types stay bare", () => {
    const merged = mergePatch({ model: "x" }, { channels: ["feishu"] });
    expect(merged.channels).toEqual(["feishu"]);
  });
});

describe("buildConfigSnapshot — always emits channels for content-match finalize", () => {
  test("empty config emits channels=[]", () => {
    expect(buildConfigSnapshot({}, false, 0).channels).toEqual([]);
  });
  test("bare-type list emitted verbatim + sorted", () => {
    expect(buildConfigSnapshot({ channels: ["telegram", "feishu"] }, false, 0).channels)
      .toEqual(["feishu", "telegram"]);
  });
  test("path-qualified specs collapse to bare type", () => {
    expect(buildConfigSnapshot({ channels: ["telegram:/opt/tg", "feishu:/opt/feishu"] }, false, 0).channels)
      .toEqual(["feishu", "telegram"]);
  });
  test("dupes deduped, unparseable dropped", () => {
    expect(buildConfigSnapshot({ channels: ["telegram", "telegram:/opt/tg", ":", "feishu:"] }, false, 0).channels)
      .toEqual(["telegram"]);
  });
  test("non-array channels field yields []", () => {
    expect(buildConfigSnapshot({ channels: "telegram" }, false, 0).channels).toEqual([]);
    expect(buildConfigSnapshot({ channels: null }, false, 0).channels).toEqual([]);
  });
});
