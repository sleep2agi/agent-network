import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { inspectLaunchHealth, LAUNCH_HEALTH_FILE, publishLaunchHealth, readLiveProcess, successfulLauncherExit, validateLaunchHealth, type LaunchHealth } from "./launcher-health";

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
    expect(source).toContain("recordSpawnedChild(childNodeIdForMap, req.node_spec.name, health.bridgePid)");
    expect(source.indexOf("const health = inspectLaunchHealth")).toBeLessThan(source.indexOf("let stillAlive = false"));
    expect(source).toContain("while (!launcherExit && Date.now() < deadline)");
  });
});
