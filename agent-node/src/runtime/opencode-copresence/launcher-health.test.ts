import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { inspectLaunchHealth, LAUNCH_HEALTH_FILE, publishLaunchHealth, readLiveProcess, successfulLauncherExit, validateLaunchHealth, waitForLaunchHealth, type LaunchHealth } from "./launcher-health";

function fixture() {
  const bridge = { pid: 200, ticks: "10", parent: 100, state: "S" };
  const serve = { pid: 201, ticks: "11", parent: 200, state: "S" };
  const tui = { pid: 202, ticks: "12", parent: 150, state: "S" };
  const record: LaunchHealth = { version: 1, generation: "ses_123", writtenAt: 1000, bridge, serve };
  const attach = { pid: 202, startTicks: "12", gen: "ses_123" };
  const live = new Map([bridge, serve, tui].map(p => [p.pid, { ...p }]));
  const args = new Map([[200, ["agent-node", "--config", "/node/config.json"]], [202, ["opencode", "--session", "ses_123"]]]);
  const check = () => validateLaunchHealth(record, attach, "/node/config.json", 999,
    { process: pid => live.get(pid), argv: pid => args.get(pid) ?? [] });
  return { record, attach, live, args, check };
}
describe("daemon OpenCode live launch generation", () => {
  test("matching bridge, child serve and same-session TUI", () => {
    expect(fixture().check()).toEqual({ ok: true, bridgePid: 200 });
  });
  test("missing/dead and PID-reused processes all fail closed", () => {
    for (const pid of [200, 201, 202]) {
      const f = fixture(); f.live.delete(pid); expect(f.check().ok).toBe(false);
      const g = fixture(); g.live.get(pid)!.ticks = "999"; expect(g.check().ok).toBe(false);
    }
  });
  test("old record and wrong TUI generation rejected", () => {
    const f = fixture(); f.record.writtenAt = 998; expect(f.check().ok).toBe(false);
    const g = fixture(); g.attach.gen = "ses_other"; expect(g.check().ok).toBe(false);
  });
  test("unrelated live serve/config/TUI rejected", () => {
    const f = fixture(); f.live.get(201)!.parent = 300; expect(f.check().ok).toBe(false);
    const g = fixture(); g.args.set(200, ["agent-node", "--config", "/other/config.json"]); expect(g.check().ok).toBe(false);
    const h = fixture(); h.args.set(202, ["opencode", "--session", "ses_other"]); expect(h.check().ok).toBe(false);
  });
  test("exit zero required independently of health", () => {
    expect(successfulLauncherExit({ code: 0, signal: null })).toBe(true);
    for (const e of [null, { code: 1, signal: null }, { code: 0, signal: "SIGTERM" }, { code: null, signal: null }]) expect(successfulLauncherExit(e)).toBe(false);
  });
  test("malformed records, unknown process identity and missing proof refuse", () => {
    const f = fixture(); f.record.bridge = null as any; expect(f.check().ok).toBe(false);
    expect(readLiveProcess(-1)).toBeUndefined();
    expect(inspectLaunchHealth("/missing-test829", "/missing-test829/config.json", 0).ok).toBe(false);
  });
  test("real child proof private, replaced generation survives old cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "test829-health-"));
    const child = spawn("sleep", ["30"]);
    try {
      const cleanup = publishLaunchHealth(dir, "ses_first", child.pid!);
      const path = join(dir, LAUNCH_HEALTH_FILE);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8")).serve.pid).toBe(child.pid);
      const cleanupNew = publishLaunchHealth(dir, "ses_second", child.pid!);
      cleanup(); expect(JSON.parse(readFileSync(path, "utf8")).generation).toBe("ses_second");
      cleanupNew(); expect(() => statSync(path)).toThrow();
    } finally { child.kill(); await new Promise(r => child.once("exit", r)); rmSync(dir, { recursive: true, force: true }); }
  });
  test("daemon removes only the exited PID and records verified bridge", () => {
    const source = readFileSync(join(import.meta.dir, "../create-node-daemon.ts"), "utf8");
    expect(source).toContain("if (codexCopresence || opencodeCopresence)");
    expect(source).toContain("forgetSpawnedChildIfPid(childNodeIdForMap, childPid)");
    expect(source).toContain("successfulLauncherExit(ex) && health.ok");
    expect(source).toContain('child_pid: health.bridgePid, launch_verified: true');
    expect(source.match(/launch_verified: true/g)?.length).toBe(1);
    expect(source).toContain("recordSpawnedChild(childNodeIdForMap, req.node_spec.name, health.bridgePid)");
    expect(source).toContain("const health = successfulLauncherExit(ex)\n      ? await waitForLaunchHealth(childDir, childCfgPath, launchedAt, deadline)\n      : inspectLaunchHealth(childDir, childCfgPath, launchedAt)");
    expect(source.indexOf("const health = successfulLauncherExit(ex)")).toBeLessThan(source.indexOf("let stillAlive = false"));
    expect(source).toContain("while (!launcherExit && Date.now() < deadline)");
  });
});

describe("bounded attach exec readiness", () => {
  test("rechecks unchanged full guard until exec makes the same session ready", async () => {
    let time = 1000, calls = 0;
    const f = fixture();
    f.args.set(202, ["sh", "/attach.sh"]);
    const result = await waitForLaunchHealth("/node", "/node/config.json", 999, 1200, {
      now: () => time,
      sleep: async ms => { time += ms; if (time === 1100) f.args.set(202, ["opencode", "--session", "ses_123"]); },
      inspect: () => { calls++; return f.check(); },
    });
    expect(result).toEqual({ok: true, bridgePid: 200});
    expect(calls).toBe(3);
    expect(time).toBe(1100);
  });
  test("foreign session and reused PID never pass, remaining budget is not extended", async () => {
    for (const mode of ["session", "pid"]) {
      let time = 1000;
      const sleeps: number[] = [], f = fixture();
      if (mode === "session") f.args.set(202, ["opencode", "--session", "ses_other"]);
      else f.live.get(202)!.ticks = "999";
      const before = f.check();
      const result = await waitForLaunchHealth("/node", "/node/config.json", 999, 1125, {
        now: () => time, inspect: () => f.check(),
        sleep: async ms => { sleeps.push(ms); time += ms; },
      });
      expect(result).toEqual(before);
      expect(result.ok).toBe(false);
      expect(sleeps).toEqual([50, 50, 25]);
      expect(time).toBe(1125);
    }
  });
  test("no waiting after deadline and no additional reads after a delayed timer", async () => {
    for (const expired of [true, false]) {
      let time = 1000, calls = 0, sleeps = 0;
      const result = await waitForLaunchHealth("/node", "/config", 999, expired ? 999 : 1100, {
        now: () => time,
        inspect: () => { calls++; return {ok: false, reason: "TUI session mismatch"}; },
        sleep: async () => { sleeps++; time = 1500; },
      });
      expect(result.ok).toBe(false);
      expect(calls).toBe(1);
      expect(sleeps).toBe(expired ? 0 : 1);
    }
  });
});
