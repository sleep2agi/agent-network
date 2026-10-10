import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { classifyTuiArgv, inspectLaunchHealth, LAUNCH_HEALTH_FILE, publishLaunchHealth, readLiveProcess, successfulLauncherExit, validateLaunchHealth, waitForLaunchHealth, type LaunchHealth } from "./launcher-health";

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
  test("argv class separates pre-exec shell, wrong session, and the two-arg contract", () => {
    expect(classifyTuiArgv(["sh", "attach.sh"], "ses_123")).toBe("pre_exec");
    expect(classifyTuiArgv(["opencode", "--session", "ses_other"], "ses_123")).toBe("wrong_session");
    expect(classifyTuiArgv(["opencode", "--session=ses_123"], "ses_123")).toBe("wrong_session");
    expect(classifyTuiArgv(["opencode", "--server", "http://127.0.0.1:9", "--session", "ses_123"], "ses_123")).toBe("match");
  });
  test("rechecks the unchanged full guard until exec makes the same session ready", async () => {
    let time = 1000;
    const f = fixture();
    f.args.set(202, ["sh", "attach.sh"]);
    const result = await waitForLaunchHealth("/node", "/node/config.json", 999, 1200, {
      now: () => time,
      sleep: async () => { time += 50; if (time === 1100) f.args.set(202, ["opencode", "--session", "ses_123"]); },
      inspect: () => f.check(),
    });
    expect(result).toEqual({ ok: true, bridgePid: 200 });
    expect(time).toBe(1100);
    expect(classifyTuiArgv(["sh", "attach.sh"], "ses_123")).toBe("pre_exec");
  });
  test("wrong session and a deadline already reached do not pass or gain budget", async () => {
    const sleeps: number[] = [];
    let time = 1000;
    const f = fixture();
    f.args.set(202, ["opencode", "--session", "ses_other"]);
    const wrong = await waitForLaunchHealth("/node", "/node/config.json", 999, 1100, {
      now: () => time,
      sleep: async (ms) => { sleeps.push(ms); time += ms; },
      inspect: () => f.check(),
    });
    expect(wrong.ok).toBe(false);
    expect(time).toBe(1100);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBe(100);
    const expired = await waitForLaunchHealth("/node", "/node/config.json", 999, 1000, {
      now: () => 1000,
      sleep: async () => { throw new Error("deadline already reached"); },
      inspect: () => f.check(),
    });
    expect(expired.ok).toBe(false);
  });
  test("linux pre-exec cmdline is TUI session mismatch and the same pid matches after exec", async () => {
    if (process.platform !== "linux") return;
    const dir = mkdtempSync(join(tmpdir(), "tui-session-"));
    const config = join(dir, "config.json");
    const gate = join(dir, "exec-ready");
    const shellPath = join(dir, "attach.sh");
    const bridgePath = join(dir, "bridge.ts");
    writeFileSync(config, "{}\n", { mode: 0o600 });
    writeFileSync(bridgePath, `
      import { spawn } from "node:child_process";
      import { publishLaunchHealth } from ${JSON.stringify(join(import.meta.dir, "launcher-health.ts"))};
      const serve = spawn("sleep", ["60"], { stdio: "ignore" });
      await new Promise((resolve, reject) => { serve.once("spawn", resolve); serve.once("error", reject); });
      publishLaunchHealth(process.argv[2], "ses_window894", serve.pid);
      process.on("SIGTERM", () => { try { serve.kill(); } catch {} process.exit(0); });
      setInterval(() => {}, 1000);
    `, { mode: 0o600 });
    const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
    const { renderAttachRecordShell } = await import("./attach-tui");
    // test829's image is node:22-bookworm-slim and has no python3. `node -e`
    // keeps `--session` and the id as the next argv element after `--`.
    writeFileSync(shellPath, [
      ...renderAttachRecordShell(join(dir, "opencode-attach.json"), "ses_window894"),
      `while [ ! -e ${q(gate)} ]; do sleep 0.01; done`,
      "exec node -e 'setInterval(() => {}, 1e9)' -- --session ses_window894",
    ].join("\n"), { mode: 0o700 });
    const launchedAt = Date.now();
    const bridge = spawn(process.execPath, [bridgePath, dir, "--config", config], { stdio: "ignore" });
    const launcher = spawn("sh", ["-c", `sh ${q(shellPath)} >/dev/null 2>&1 & exit 0`], { stdio: "ignore" });
    const stop = () => {
      try { bridge.kill("SIGTERM"); } catch {}
      try {
        const attach = JSON.parse(readFileSync(join(dir, "opencode-attach.json"), "utf8"));
        process.kill(attach.pid, "SIGTERM");
      } catch {}
    };
    const waitFor = async (ok: () => boolean, ms: number, why: () => string) => {
      const deadline = Date.now() + ms;
      while (!ok() && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
      if (!ok()) throw new Error(why());
    };
    try {
      await new Promise((resolve, reject) => { launcher.once("exit", resolve); launcher.once("error", reject); });
      await waitFor(
        () => existsSync(join(dir, LAUNCH_HEALTH_FILE)) && existsSync(join(dir, "opencode-attach.json")),
        2000,
        () => `launch records missing health=${existsSync(join(dir, LAUNCH_HEALTH_FILE))} attach=${existsSync(join(dir, "opencode-attach.json"))}`,
      );
      const before = inspectLaunchHealth(dir, config, launchedAt);
      expect(before).toEqual({ ok: false, reason: "TUI session mismatch" });
      const attach = JSON.parse(readFileSync(join(dir, "opencode-attach.json"), "utf8"));
      const argv = readFileSync(`/proc/${attach.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      expect(classifyTuiArgv(argv, "ses_window894")).toBe("pre_exec");
      expect(readLiveProcess(attach.pid)?.ticks).toBe(String(attach.startTicks));
      writeFileSync(gate, "ready\n", { mode: 0o600 });
      await waitFor(
        () => inspectLaunchHealth(dir, config, launchedAt).ok,
        2000,
        () => {
          const health = inspectLaunchHealth(dir, config, launchedAt);
          let cmdline = "unavailable";
          try { cmdline = readFileSync(`/proc/${attach.pid}/cmdline`, "utf8").split("\0").filter(Boolean).join(" "); } catch {}
          return `exec did not match (${health.ok ? "ok" : health.reason}); cmdline=${cmdline}`;
        },
      );
      const after = inspectLaunchHealth(dir, config, launchedAt);
      expect(after.ok).toBe(true);
      const execArgv = readFileSync(`/proc/${attach.pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      expect(classifyTuiArgv(execArgv, "ses_window894")).toBe("match");
      expect(readLiveProcess(attach.pid)?.ticks).toBe(String(attach.startTicks));
    } finally {
      stop();
      if (bridge.exitCode === null) await new Promise(r => bridge.once("exit", r));
      rmSync(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
