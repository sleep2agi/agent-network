import { afterEach, beforeEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { handleStartDoorbell } from "./start-daemon";
import { _resetChildrenMapForTest, getChildrenSnapshot } from "./stop-daemon";

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "oc-start-")); _resetChildrenMapForTest(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function fixture() {
  const dir = join(root, "child"); mkdirSync(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify({ node_id: "node_child", node_name: "child",
    runtime: "opencode-cli", opencodeGeneration: "v2", opencodeMode: "copresence" }), { mode: 0o600 });
  const kills: string[] = [], acks: any[] = [];
  const child = Object.assign(new EventEmitter(), { pid: 4242, unref() {}, kill(s: string) { kills.push(s); return true; } });
  let spawns = 0, probes = 0;
  const deps: any = { workDir: root, nodesRoot: root, log() {}, warn() {}, anetBin: () => "/trusted/anet",
    spawnChild: () => { spawns++; return child; },
    inspectOpenCodeStartHealth: (nodeDir: string, cfg: string, at: number) => {
      probes++; expect(nodeDir).toBe(dir); expect(cfg).toBe(join(dir, "config.json")); expect(at).toBeGreaterThan(0);
      return { ok: true, bridgePid: 4343 };
    },
    callCommHub: async (tool: string, args: any) => {
      if (tool === "get_start_request") return { ok: true, child_node_id: "node_child", child_alias: "child", start_completion_capable: true };
      acks.push(args); return { ok: true, status: args.status };
    } };
  return { deps, child, acks, kills, spawns: () => spawns, probes: () => probes };
}

test("V2 waits for launcher completion, shares replay, and records real bridge not dead launcher", async () => {
  const f = fixture();
  const first = handleStartDoorbell({ request_id: "str_wait" }, f.deps); await tick();
  const second = handleStartDoorbell({ request_id: "str_wait" }, f.deps); await tick();
  expect(f.spawns()).toBe(1); expect(f.acks.map(a => a.status)).toEqual(["starting"]);
  expect(f.probes()).toBe(0); expect(getChildrenSnapshot()[0].pid).toBe(4242);
  f.child.emit("exit", 0, null); await Promise.all([first, second]);
  expect(f.acks.at(-1)).toMatchObject({ status: "started", child_pid: 4343 });
  expect(getChildrenSnapshot()[0].pid).toBe(4343);
});
test.each([[1, null], [null, "SIGTERM"]])("launcher exit %s / %s rejects without health success", async (code, signal) => {
  const f = fixture(); const run = handleStartDoorbell({ request_id: "str_failure" }, f.deps);
  await tick(); f.child.emit("exit", code, signal); await run;
  expect(f.acks.map(a => a.status)).toEqual(["starting", "start_failed"]);
  expect(f.probes()).toBe(0); expect(getChildrenSnapshot()).toEqual([]);
});
test("start rechecks within the original deadline and publishes the TUI mismatch code", async () => {
  const f = fixture();
  delete f.deps.inspectOpenCodeStartHealth;
  f.deps.opencodeStartTimeoutMs = 1000;
  let span = 0;
  f.deps.waitOpenCodeStartHealth = (_dir: string, _cfg: string, at: number, deadline: number) => {
    span = deadline - at;
    return { ok: false, reason: "TUI session mismatch" };
  };
  const run = handleStartDoorbell({ request_id: "str_tui" }, f.deps);
  await tick(); f.child.emit("exit", 0, null); await run;
  expect(span).toBe(1000);
  expect(f.acks.at(-1)).toMatchObject({ status: "start_failed", error: "opencode_tui_session_mismatch" });
  expect(getChildrenSnapshot()).toEqual([]);
  const source = readFileSync(join(import.meta.dir, "opencode-start-completion.ts"), "utf8");
  expect(source).toContain("deps.waitOpenCodeStartHealth ?? waitForLaunchHealth");
  expect(source).toContain("launchedAt + (deps.opencodeStartTimeoutMs ?? 35_000)");
});
test("successful launcher with invalid generation proof is not started", async () => {
  const f = fixture(); f.deps.inspectOpenCodeStartHealth = () => ({ ok: false, reason: "stale or mismatched generation" });
  const run = handleStartDoorbell({ request_id: "str_stale" }, f.deps);
  await tick(); f.child.emit("exit", 0, null); await run;
  expect(f.acks.at(-1)).toMatchObject({ status: "start_failed", error: "opencode_launch_health:stale or mismatched generation" });
  expect(getChildrenSnapshot()).toEqual([]);
});
test("async spawn error is a failed start", async () => {
  const f = fixture(); const run = handleStartDoorbell({ request_id: "str_error" }, f.deps);
  await tick(); f.child.emit("error", Error("ENOENT")); await run;
  expect(f.acks.at(-1).status).toBe("start_failed"); expect(getChildrenSnapshot()).toEqual([]);
});
test("bounded timeout signals only owned launcher and ignores late successful exit", async () => {
  const f = fixture(); f.deps.opencodeStartTimeoutMs = 10;
  await handleStartDoorbell({ request_id: "str_timeout" }, f.deps);
  expect(f.kills).toEqual(["SIGTERM"]); expect(f.acks.at(-1).error).toBe("opencode_launcher_timeout");
  f.child.emit("exit", 0, null); await tick();
  expect(f.probes()).toBe(0); expect(getChildrenSnapshot()).toEqual([]);
});
test("old Hub fails explicitly before spawn, without falling back to kill-0", async () => {
  const f = fixture(), call = f.deps.callCommHub;
  f.deps.callCommHub = async (tool: string, args: any) => { const r = await call(tool, args); delete r.start_completion_capable; return r; };
  await handleStartDoorbell({ request_id: "str_old" }, f.deps);
  expect(f.spawns()).toBe(0); expect(f.acks.at(-1).error).toBe("opencode_start_completion_unsupported");
});
test("rejected progress ack has no spawn side effect", async () => {
  const f = fixture(), call = f.deps.callCommHub;
  f.deps.callCommHub = async (tool: string, args: any) => args.status === "starting" ? { ok: false } : call(tool, args);
  await handleStartDoorbell({ request_id: "str_progress" }, f.deps);
  expect(f.spawns()).toBe(0); expect(f.acks.at(-1).status).toBe("start_failed");
});
test("lost final ack replays without spawning another generation", async () => {
  const f = fixture(), call = f.deps.callCommHub; let lost = true;
  f.deps.callCommHub = async (tool: string, args: any) => {
    if (args.status === "started" && lost) { lost = false; throw Error("offline"); }
    return call(tool, args);
  };
  const run = handleStartDoorbell({ request_id: "str_lost" }, f.deps).catch(e => e);
  await tick(); f.child.emit("exit", 0, null); expect((await run).message).toBe("offline");
  await handleStartDoorbell({ request_id: "str_lost" }, f.deps);
  expect(f.spawns()).toBe(1); expect(f.acks.at(-1).child_pid).toBe(4343);
});
test("real child delayed nonzero exit is never started", async () => {
  const f = fixture(); f.deps.spawnChild = (_bin: string, _args: string[], opts: any) =>
    spawn(process.execPath, ["-e", "setTimeout(() => process.exit(7), 25)"], opts);
  await handleStartDoorbell({ request_id: "str_real" }, f.deps);
  expect(f.acks.map(a => a.status)).toEqual(["starting", "start_failed"]);
  expect(f.acks.at(-1).error).toBe("opencode_launcher_exit:7");
});
