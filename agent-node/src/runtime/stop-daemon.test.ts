import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetChildrenMapForTest,
  getChildrenSnapshot,
  handleStopDoorbell,
  recordSpawnedChild,
} from "./stop-daemon";
import { mkdtempSync, mkdirSync, readdirSync, statSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// RFC-027 §2.4 daemon stop handler tests. We drive handleStopDoorbell
// with synthetic deps (fake callCommHub + injectable signalProcess /
// sleep / fs ops) so we exercise the full state machine without
// spawning real subprocesses for every case. The kill-0 + SIGTERM
// branch behaviour is also covered by a real-subprocess integration
// test below (per 通信龙 #338 PR3 lesson — "真起子进程测, 别 mock 糊弄").

let scratch = "";
beforeEach(() => {
  _resetChildrenMapForTest();
  scratch = mkdtempSync(join(tmpdir(), "stop-daemon-"));
});
afterEach(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function makeDeps(opts: {
  acks?: Array<{ tool: string; args: any }>;
  aliveAfterSig?: boolean;            // simulate child still alive after SIGTERM
  reapAfterMs?: number;                // simulate ms before isAlive flips false
  signalThrows?: Error;
  workdirRoot?: string;
  deletedRoot?: string;
  getStopReturn?: any;
} = {}) {
  const acks = opts.acks ?? [];
  let aliveCalls = 0;
  const fakeSignals: Array<{ pid: number; sig: any }> = [];
  return {
    acks,
    fakeSignals,
    deps: {
      callCommHub: async (tool: string, args: any) => {
        if (tool === "get_stop_request") {
          return opts.getStopReturn ?? { ok: false, error: "no_fixture" };
        }
        acks.push({ tool, args });
        return { ok: true };
      },
      log: (_m: string) => { /* swallow */ },
      warn: (_m: string) => { /* swallow */ },
      workdirRoot: opts.workdirRoot,
      deletedRoot: opts.deletedRoot,
      signalProcess: (pid: number, sig: NodeJS.Signals | 0) => {
        if (opts.signalThrows && sig !== 0) throw opts.signalThrows;
        fakeSignals.push({ pid, sig });
        if (sig === 0) {
          aliveCalls++;
          const hasSigkill = fakeSignals.some(s => s.sig === "SIGKILL");
          if (hasSigkill) {
            // After SIGKILL → dies immediately on next kill-0
            const err: any = new Error("ESRCH"); err.code = "ESRCH"; throw err;
          }
          const sentSigterm = fakeSignals.some(s => s.sig === "SIGTERM");
          if (sentSigterm) {
            if (opts.aliveAfterSig === true) {
              // Simulate stubborn child: stays alive across enough
              // polls to exhaust grace_seconds. We let the handler's
              // own deadline expire (sleep below advances fakeNow);
              // alive=true throughout.
              return;
            }
            // Default: dead one poll after SIGTERM.
            const err: any = new Error("ESRCH"); err.code = "ESRCH"; throw err;
          }
          // pre-SIGTERM kill-0 → alive (no throw).
        }
      },
      // Fake sleep that advances Date.now via a stub timeout. We can't
      // easily mock Date in Bun without monkey-patching; instead sleep
      // resolves on the next macrotask AND the test relies on
      // grace_seconds=5 + 25 max polls = 5s wall-clock with the real
      // Date.now still moving. To avoid 5s test runtime we let the
      // fake also tick Date forward by setting a virtual clock — but
      // that needs more plumbing. Simpler: sleep is real, grace=5s
      // means test takes ~5s. We bump test timeout instead.
      sleep: async (ms: number) => new Promise(r => setTimeout(r, Math.min(ms, 50))),
    },
  };
}

describe("recordSpawnedChild + map shape", () => {
  test("records + snapshot returns entry", () => {
    recordSpawnedChild("node_child_a", "alias-a", 1234);
    const snap = getChildrenSnapshot();
    expect(snap.length).toBe(1);
    expect(snap[0].pid).toBe(1234);
    expect(snap[0].alias).toBe("alias-a");
    expect(snap[0].child_node_id).toBe("node_child_a");
  });
  test("re-record overwrites pid", () => {
    recordSpawnedChild("node_child_a", "alias-a", 1234);
    recordSpawnedChild("node_child_a", "alias-a", 5678);
    expect(getChildrenSnapshot()[0].pid).toBe(5678);
  });
});

describe("handleStopDoorbell — noop_not_my_child", () => {
  test("unknown child_node_id → degraded ack (not error)", async () => {
    const { acks, deps } = makeDeps({
      getStopReturn: {
        ok: true, request_id: "sr_x",
        child_node_id: "node_unknown", child_alias: "unknown",
        action: "stop", delete_config: false, grace_seconds: 10, force: false,
      },
    });
    await handleStopDoorbell({ request_id: "sr_x" }, deps);
    expect(acks.length).toBe(1);
    expect(acks[0].tool).toBe("ack_stop_request");
    expect(acks[0].args.status).toBe("noop_not_my_child");
  });
});

describe("handleStopDoorbell — happy stop (SIGTERM-reaped quickly)", () => {
  test("child reaped after SIGTERM → ack stopped + SIGTERM signal recorded", async () => {
    recordSpawnedChild("node_c", "alias-c", 9999);
    const { acks, fakeSignals, deps } = makeDeps({
      getStopReturn: {
        ok: true, request_id: "sr_1",
        child_node_id: "node_c", child_alias: "alias-c",
        action: "stop", delete_config: false, grace_seconds: 10, force: false,
      },
    });
    await handleStopDoorbell({ request_id: "sr_1" }, deps);
    expect(acks.length).toBe(1);
    expect(acks[0].args.status).toBe("stopped");
    expect(acks[0].args.exit_signal).toBe("SIGTERM");
    expect(fakeSignals.some(s => s.sig === "SIGTERM")).toBe(true);
    expect(fakeSignals.some(s => s.sig === "SIGKILL")).toBe(false);
    // Map cleared on successful stop.
    expect(getChildrenSnapshot().length).toBe(0);
  });
});

describe("handleStopDoorbell — SIGKILL escalation", () => {
  test("child ignores SIGTERM → grace exceeded → SIGKILL → ack stopped w/ SIGKILL", async () => {
    recordSpawnedChild("node_busy", "alias-busy", 7777);
    const { acks, fakeSignals, deps } = makeDeps({
      aliveAfterSig: true,
      getStopReturn: {
        ok: true, request_id: "sr_kill",
        child_node_id: "node_busy", child_alias: "alias-busy",
        // grace=5 is the hub-side minimum; below the wire-format minimum.
        // For the unit test we drop to 5 — handler's grace_seconds=5 means
        // ~5s real wall clock with capped fake-sleep. Acceptable cost
        // for the SIGKILL escalation coverage.
        action: "stop", delete_config: false, grace_seconds: 5, force: false,
      },
    });
    await handleStopDoorbell({ request_id: "sr_kill" }, deps);
    expect(acks.length).toBe(1);
    expect(acks[0].args.status).toBe("stopped");
    expect(acks[0].args.exit_signal).toBe("SIGKILL");
    expect(fakeSignals.filter(s => s.sig === "SIGTERM").length).toBe(1);
    expect(fakeSignals.filter(s => s.sig === "SIGKILL").length).toBe(1);
  });
});

describe("handleStopDoorbell — delete action with delete_config", () => {
  test("mv child workdir to ~/.anet/deleted/<ts>-<alias>/ + chmod 700 + ack backup_path", async () => {
    const workdirRoot = join(scratch, "nodes");
    const deletedRoot = join(scratch, "deleted");
    mkdirSync(workdirRoot, { recursive: true });
    const childDir = join(workdirRoot, "alias-d");
    mkdirSync(childDir);
    writeFileSync(join(childDir, "config.json"), JSON.stringify({ token: "ntok_secret" }), { mode: 0o600 });

    recordSpawnedChild("node_d", "alias-d", 5555);
    const { acks, deps } = makeDeps({
      workdirRoot, deletedRoot,
      getStopReturn: {
        ok: true, request_id: "sr_d",
        child_node_id: "node_d", child_alias: "alias-d",
        action: "delete", delete_config: true, grace_seconds: 10, force: false,
      },
    });
    await handleStopDoorbell({ request_id: "sr_d" }, deps);
    expect(acks.length).toBe(1);
    expect(acks[0].args.status).toBe("stopped");
    expect(typeof acks[0].args.backup_path).toBe("string");
    // backup_path naming: <ts>-<alias>
    expect(acks[0].args.backup_path).toMatch(/\/\d+-alias-d$/);
    // Source dir gone, target dir exists.
    expect(readdirSync(workdirRoot).filter(n => n === "alias-d").length).toBe(0);
    const trash = readdirSync(deletedRoot);
    expect(trash.length).toBe(1);
    // chmod 700 on the backup dir.
    const mode = statSync(join(deletedRoot, trash[0])).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  test("delete_config=false → no backup dir, no source move", async () => {
    const workdirRoot = join(scratch, "nodes2");
    const deletedRoot = join(scratch, "deleted2");
    mkdirSync(workdirRoot, { recursive: true });
    mkdirSync(join(workdirRoot, "alias-j"));
    recordSpawnedChild("node_j", "alias-j", 4444);
    const { acks, deps } = makeDeps({
      workdirRoot, deletedRoot,
      getStopReturn: {
        ok: true, request_id: "sr_j",
        child_node_id: "node_j", child_alias: "alias-j",
        action: "delete", delete_config: false, grace_seconds: 10, force: false,
      },
    });
    await handleStopDoorbell({ request_id: "sr_j" }, deps);
    expect(acks[0].args.status).toBe("stopped");
    expect(acks[0].args.backup_path).toBeUndefined();
    // Source dir untouched.
    expect(readdirSync(workdirRoot).includes("alias-j")).toBe(true);
  });
});

describe("handleStopDoorbell — real subprocess primitive (no mocks)", () => {
  // Mirror PR3 #338 discipline: lock the actual kill-0 + signal
  // semantics against a real node subprocess so a runtime drift
  // doesn't slip past unit tests. We don't drive handleStopDoorbell
  // here because it would need full callCommHub fixtures; instead
  // we verify the primitive that the handler depends on.
  test("real subprocess: SIGTERM kills + kill-0 ESRCH after", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, ["-e", "setInterval(()=>{}, 5000)"], {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);
    child.unref();
    await new Promise(r => setTimeout(r, 200));
    expect(() => process.kill(pid, 0)).not.toThrow();   // alive
    process.kill(pid, "SIGTERM");
    // Poll for reap.
    let reaped = false;
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 100));
      try { process.kill(pid, 0); }
      catch (e: any) { if (e.code === "ESRCH") { reaped = true; break; } }
    }
    expect(reaped).toBe(true);
  });
});
