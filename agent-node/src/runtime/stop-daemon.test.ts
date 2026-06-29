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
  let virtualNow = 1_700_000_000_000;   // arbitrary epoch; sleep() advances it
  const fakeSignals: Array<{ pid: number; sig: any }> = [];
  return {
    acks,
    fakeSignals,
    deps: {
      now: () => virtualNow,
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
      // SF-1 (#345 review): use a virtual clock so the SIGKILL test
      // doesn't burn real wall-clock. `now` is injectable via deps
      // (stop-daemon.ts threads it into waitForExit). sleep advances
      // the virtual clock by the asked-for ms; setTimeout(0) just
      // yields the event loop so async branches resolve.
      sleep: async (ms: number) => {
        virtualNow += ms;
        return new Promise(r => setTimeout(r, 0));
      },
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

// ─── RFC-027 PR1.1 — rebuildChildrenMapOnBoot tests ────────────────
// Cover: happy recover, alias substring collision rejection (cmdline
// verify), zombie skip, ambiguous multi-pid skip, missing-pid warn,
// self-pid exclusion. Plus a "real subprocess primitive" test that
// spawns a fake child + pgrep + cmdline match exercise on this host
// (per 通信龙 explicit "真子进程测给 rebuild 上真牙").
describe("rebuildChildrenMapOnBoot (RFC-027 PR1.1)", () => {
  test("happy: hub returns 2 children + each has unique matching pid → both recovered", async () => {
    _resetChildrenMapForTest();
    const { rebuildChildrenMapOnBoot } = await import("./stop-daemon");
    const r = await rebuildChildrenMapOnBoot({
      callCommHub: async (tool) => {
        if (tool === "list_my_children") return {
          ok: true, count: 2,
          children: [
            { child_node_id: "node_alpha", alias: "alpha", lifecycle_state: "active" },
            { child_node_id: "node_beta",  alias: "beta",  lifecycle_state: "active" },
          ],
        };
        return { ok: false };
      },
      log: () => {}, warn: () => {},
      pgrepAlias: async (a) => a === "alpha" ? [1001] : a === "beta" ? [2002] : [],
      readProcCmdline: (pid) =>
        pid === 1001 ? "agent-node\0--alias\0alpha\0" :
        pid === 2002 ? "agent-node\0--alias\0beta\0" : null,
      readProcStatState: () => "S",
    });
    expect(r.recovered).toBe(2);
    expect(r.missing.length).toBe(0);
    expect(getChildrenSnapshot().map(c => c.alias).sort()).toEqual(["alpha", "beta"]);
    _resetChildrenMapForTest();
  });

  test("alias substring collision: pgrep finds 'bot2' for alias 'bot' but cmdline argv exact-match rejects", async () => {
    _resetChildrenMapForTest();
    const { rebuildChildrenMapOnBoot, _internals } = await import("./stop-daemon");
    // Validate the underlying argv check first.
    expect(_internals.cmdlineMatchesAlias("agent-node\0--alias\0bot2\0", "bot")).toBe(false);
    expect(_internals.cmdlineMatchesAlias("agent-node\0--alias\0bot\0",  "bot")).toBe(true);
    expect(_internals.cmdlineMatchesAlias("agent-node\0--alias\0bot",     "bot")).toBe(true);
    const r = await rebuildChildrenMapOnBoot({
      callCommHub: async () => ({ ok: true, children: [{ child_node_id: "node_bot", alias: "bot", lifecycle_state: "active" }] }),
      log: () => {}, warn: () => {},
      pgrepAlias: async () => [9999],   // candidate pid (e.g. would match "bot2")
      readProcCmdline: () => "agent-node\0--alias\0bot2\0",  // argv has bot2 not bot
      readProcStatState: () => "S",
    });
    // No verified match — alias goes into missing.
    expect(r.recovered).toBe(0);
    expect(r.missing).toContain("bot");
    expect(getChildrenSnapshot().length).toBe(0);
    _resetChildrenMapForTest();
  });

  test("zombie pid skipped (state=Z)", async () => {
    _resetChildrenMapForTest();
    const { rebuildChildrenMapOnBoot } = await import("./stop-daemon");
    const r = await rebuildChildrenMapOnBoot({
      callCommHub: async () => ({ ok: true, children: [{ child_node_id: "node_z", alias: "zomb", lifecycle_state: "active" }] }),
      log: () => {}, warn: () => {},
      pgrepAlias: async () => [4040],
      readProcCmdline: () => "agent-node\0--alias\0zomb\0",
      readProcStatState: () => "Z",   // defunct
    });
    expect(r.recovered).toBe(0);
    expect(r.zombies).toContain("zomb");
    _resetChildrenMapForTest();
  });

  test("ambiguous: multiple verified pids → skipped (operator intervention)", async () => {
    _resetChildrenMapForTest();
    const { rebuildChildrenMapOnBoot } = await import("./stop-daemon");
    const r = await rebuildChildrenMapOnBoot({
      callCommHub: async () => ({ ok: true, children: [{ child_node_id: "node_dup", alias: "dup", lifecycle_state: "active" }] }),
      log: () => {}, warn: () => {},
      pgrepAlias: async () => [5050, 6060],
      // Both legit cmdlines — likely operator started a duplicate.
      readProcCmdline: () => "agent-node\0--alias\0dup\0",
      readProcStatState: () => "S",
    });
    expect(r.recovered).toBe(0);
    expect(r.ambiguous).toContain("dup");
    expect(getChildrenSnapshot().length).toBe(0);
    _resetChildrenMapForTest();
  });

  test("hub-active but pgrep finds nothing → missing (warn, don't auto-nudge)", async () => {
    _resetChildrenMapForTest();
    const warns: string[] = [];
    const { rebuildChildrenMapOnBoot } = await import("./stop-daemon");
    const r = await rebuildChildrenMapOnBoot({
      callCommHub: async () => ({ ok: true, children: [{ child_node_id: "node_g", alias: "ghost", lifecycle_state: "active" }] }),
      log: () => {}, warn: (m) => warns.push(m),
      pgrepAlias: async () => [],
      readProcCmdline: () => null,
      readProcStatState: () => null,
    });
    expect(r.recovered).toBe(0);
    expect(r.missing).toContain("ghost");
    expect(warns.some(w => w.includes("ghost"))).toBe(true);
    _resetChildrenMapForTest();
  });

  test("daemon's own pid is excluded from candidates", async () => {
    _resetChildrenMapForTest();
    const { rebuildChildrenMapOnBoot } = await import("./stop-daemon");
    const r = await rebuildChildrenMapOnBoot({
      callCommHub: async () => ({ ok: true, children: [{ child_node_id: "node_self", alias: "myself", lifecycle_state: "active" }] }),
      log: () => {}, warn: () => {},
      pgrepAlias: async () => [process.pid],   // collides with daemon itself
      readProcCmdline: () => "agent-node\0--alias\0myself\0",
      readProcStatState: () => "S",
    });
    expect(r.recovered).toBe(0);
    expect(r.missing).toContain("myself");
    _resetChildrenMapForTest();
  });

  test("list_my_children failure → safe empty result (no throw, no map mutation)", async () => {
    _resetChildrenMapForTest();
    recordSpawnedChild("node_preserve", "preserve", 12345);
    const { rebuildChildrenMapOnBoot } = await import("./stop-daemon");
    const r = await rebuildChildrenMapOnBoot({
      callCommHub: async () => ({ ok: false, error: "auth_failed" }),
      log: () => {}, warn: () => {},
    });
    expect(r.recovered).toBe(0);
    expect(r.total_children_from_hub).toBe(0);
    // Existing map untouched.
    expect(getChildrenSnapshot().length).toBe(1);
    expect(getChildrenSnapshot()[0].alias).toBe("preserve");
    _resetChildrenMapForTest();
  });
});

describe("rebuildChildrenMapOnBoot — real subprocess primitive (no pgrep mocks, no proc mocks)", () => {
  // Per 通信龙 PR1.1 dispatch + #345 review lesson: "真子进程测给
  // rebuildOnBoot 上真牙这点尤其对". Spawn a real fake "child" that
  // sets its argv to look like agent-node + alias, let the real
  // defaultPgrepAlias + /proc readers find it, verify recovery.
  // We can't easily fake argv[0] from inside JS so we spawn with
  // a shell exec that sets the title via process.argv inline.
  // pgrep -f matches on the full /proc/<pid>/cmdline so we need our
  // fake to write a cmdline that contains `agent-node` + `--alias <name>`
  // as adjacent NUL-separated tokens.
  // Per 通信龙 lesson on label honesty (PR1.1 dispatch + #345 review):
  // "shape-pin/happy-path 测目前是即使把 fix 回退它们也会过". Calling
  // this a full "end-to-end rebuild" would oversell.
  //
  // What this DOES test: spawn a real subprocess whose argv contains
  // `--alias <test-alias>`, then drive the real cmdlineMatchesAlias
  // helper against that pid's real /proc/<pid>/cmdline. Proves the
  // matcher correctly walks NUL-separated argv from a live kernel.
  //
  // What this does NOT test (deferred to PR1.2 Docker e2e):
  //  - the real pgrep wrapper finding the process by binary name
  //    (test child runs `node`, not `agent-node`, so the default
  //    pgrep pattern misses; PR1.2 spawns a real agent-node container
  //    where the pattern truly matches end-to-end)
  //  - the recovery decision integrating pgrep + /proc end-to-end
  test("matcher accepts a real subprocess whose argv contains --alias <token>", async () => {
    const { spawn } = await import("node:child_process");
    const { _internals } = await import("./stop-daemon");
    const { readFileSync } = await import("node:fs");
    // Spawn `node --title=...` is not portable; instead spawn `bash -c
    // "exec -a 'agent-node --alias FAKE-PRIM' node -e ...'"` so /proc/
    // <pid>/cmdline records our pretend argv.
    // exec -a replaces argv[0]; we still need --alias to appear as a
    // SEPARATE NUL token, so include it in the exec -a string with
    // a literal NUL won't work. Workaround: invoke node directly with
    // sentinel args so /proc/<pid>/cmdline naturally separates.
    const alias = "FAKE-MATCH-" + Math.floor(Math.random() * 1e6);
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},5000)", "--alias", alias],
      { stdio: ["ignore", "ignore", "ignore"], detached: true },
    );
    const pid = child.pid!;
    expect(pid).toBeGreaterThan(0);
    child.unref();
    try {
      await new Promise(r => setTimeout(r, 200));
      // Read REAL /proc/<pid>/cmdline from a live process.
      const realCmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
      // Real cmdline doesn't contain `agent-node` (we spawned `node`),
      // so prepend the production binary token to confirm the matcher
      // walks the real argv data correctly when the binary IS present.
      const cmdlineWithAgentNode = "agent-node\0" + realCmdline;
      expect(_internals.cmdlineMatchesAlias(cmdlineWithAgentNode, alias)).toBe(true);
      // And rejects a collision alias (substring of ours).
      expect(_internals.cmdlineMatchesAlias(cmdlineWithAgentNode, alias.slice(0, -1))).toBe(false);
    } finally {
      try { process.kill(pid, "SIGKILL"); } catch { /* already exited */ }
    }
  });
});
