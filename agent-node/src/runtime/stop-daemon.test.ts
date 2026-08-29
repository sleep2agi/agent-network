import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  _resetChildrenMapForTest,
  getChildrenSnapshot,
  handleStopDoorbell,
  recordSpawnedChild,
} from "./stop-daemon";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync, writeFileSync, existsSync } from "node:fs";
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

describe("handleStopDoorbell — stop without map entry converges (#1448 finding-3)", () => {
  // 改前(#1286 前的对称缺口)：stop 未命中 map ack `noop_not_my_child`,hub 侧
  // 留在 stopping 卡死。改后：与 delete 一样 sweep(按 alias 找并 SIGTERM 任何还
  // 在跑的子进程)+ ack `stopped` 收敛。这条断言 expect "stopped" 在改前会红
  // (拿到 "noop_not_my_child")——witnessed-red。
  test("unknown/absent child on stop → sweep + ack stopped (not noop)", async () => {
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
    expect(acks[0].args.status).toBe("stopped");
    expect(acks[0].args.backup_path).toBeUndefined();   // stop 不搬 config
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
    // PR1.2 BUG-B regression lock (通信龙 PR #349 ack SHOULD-FIX): the
    // pgid kill fix uses `signalProcess(-entry.pid, sig)` — POSIX
    // `kill -pgid` semantics — to reach the wrapper's whole process
    // group including detached agent-node grandchildren. A silent
    // revert to bare-PID (`signalProcess(entry.pid, sig)`) would
    // re-introduce the orphan-grandchild leak. Lock the contract here:
    // for every SIGTERM/SIGKILL on a live child, at least one signal
    // must target a NEGATIVE pid (the recorded wrapper's pgid). e2e
    // (qa-rfc027-stop-delete) proves it on real procs; this test
    // proves the wire shape so the docker harness isn't the only gate.
    expect(fakeSignals.some(s => s.pid < 0)).toBe(true);
    expect(fakeSignals.filter(s => s.pid < 0).some(s => s.sig === "SIGTERM")).toBe(true);
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

// #1474 finding-1(安全) — delete/stop 的 workdir 根从 deps.workDir(=create 用的
// cwd 基准)派生,不硬编码 homedir()。daemon 从非 $HOME 目录跑时,create 落
// $CWD/.anet/nodes(含 child ntok+env 密钥),按 homedir 去搬会扑空 → warn → 仍 ack
// stopped → hub 以为删了、密钥原地残留(违背"删后密钥不残留")。
//
// witnessed-red:workDir 设成一个 ≠ homedir 的临时目录、**不**注入 workdirRoot/
// deletedRoot(强制走派生),盘上放好 config。改后:密钥目录被搬进 <workDir>/.anet/
// deleted、原地清空;改前(homedir 派生)扑空 → childDir 仍在(残留)、无 backup_path。
describe("#1474 finding-1 — workdir root derives from workDir, not homedir (secret residue)", () => {
  test("delete with no injected root cleans $workDir/.anet/nodes/<alias> (not $HOME)", async () => {
    const workDir = mkdtempSync(join(tmpdir(), "anet-1474-cwd-"));   // ≠ homedir
    const alias = "cwd-child-1474";
    const childDir = join(workDir, ".anet", "nodes", alias);
    mkdirSync(childDir, { recursive: true });
    writeFileSync(join(childDir, "config.json"), JSON.stringify({ token: "ntok_secret", env_local: "leak" }), { mode: 0o600 });

    const acks: any[] = [];
    const deps: any = {
      workDir,   // ← create 的 cwd 基准;故意不注入 workdirRoot/deletedRoot → 测派生
      callCommHub: async (tool: string, args: any) => {
        if (tool === "get_stop_request") {
          return { ok: true, request_id: "sr_cwd", child_node_id: "node_cwd", child_alias: alias, action: "delete", delete_config: true, grace_seconds: 10, force: false };
        }
        acks.push(args); return { ok: true };
      },
      signalProcess: () => {}, log: () => {}, warn: () => {},
    };
    await handleStopDoorbell({ request_id: "sr_cwd" }, deps);

    expect(acks.at(-1)!.status).toBe("stopped");
    // 密钥目录被清出 $workDir/.anet/nodes(改前 homedir 派生 → 扑空 → 仍在 → 红)
    expect(existsSync(childDir)).toBe(false);
    // 搬进了从 workDir 派生的回收站(不是 homedir)
    const trash = join(workDir, ".anet", "deleted");
    expect(existsSync(trash) && readdirSync(trash).some(n => n.endsWith(alias))).toBe(true);
    expect((acks.at(-1)!.backup_path as string | undefined)?.startsWith(trash)).toBe(true);

    rmSync(workDir, { recursive: true, force: true });
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

// ── #1286 — 「先 stop 后 delete」这条真实路径 ───────────────────────
//
// stop 成功之后条目会被移出 childrenMap（本文件设计如此），而 delete 复用
// 同一张表 ⇒ 未命中是**必然**不是偶发。而未命中分支原本对两个 action 共用
// 一个早返回，于是 delete 什么都不做却 ack 出去，调用方零信号。
//
// 拿进程表决定文件系统清理是范畴错误：childrenMap 记的是运行中的进程，
// 配置目录是盘上的事实，两者生命周期不同。
describe("#1286 handleStopDoorbell — stop 之后再 delete", () => {
  function seedWorkdir(root: string, alias: string) {
    const dir = join(root, alias);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ alias }), "utf8");
    return dir;
  }

  test("🔴 stop 成功（条目已移除）后 delete：配置目录必须真的被移走，而不是静默 no-op", async () => {
    const workdirRoot = join(scratch, "nodes");
    const deletedRoot = join(scratch, "deleted");
    const alias = "child-1286";
    const childId = "node_child_1286";
    seedWorkdir(workdirRoot, alias);

    // 第一步：stop —— 走命中路径，结束后条目被移除
    recordSpawnedChild(childId, alias, 4242);
    const stopH = makeDeps({
      workdirRoot, deletedRoot,
      getStopReturn: {
        ok: true, request_id: "req-stop", child_node_id: childId, child_alias: alias,
        action: "stop", delete_config: false, grace_seconds: 10, force: false,
      },
    });
    await handleStopDoorbell({ request_id: "req-stop" }, stopH.deps as any);
    expect(stopH.acks.at(-1)!.args.status).toBe("stopped");
    // 前提断言：这条路径确实把条目移除了 —— 否则下面测的就不是那个场景
    expect(getChildrenSnapshot().length).toBe(0);

    // 第二步：delete —— childrenMap 必然未命中
    const delH = makeDeps({
      workdirRoot, deletedRoot,
      getStopReturn: {
        ok: true, request_id: "req-del", child_node_id: childId, child_alias: alias,
        action: "delete", delete_config: true, grace_seconds: 10, force: false,
      },
    });
    await handleStopDoorbell({ request_id: "req-del" }, delH.deps as any);

    const ack = delH.acks.at(-1)!.args;
    expect(ack.status).toBe("stopped");                 // hub 才会收敛（行删除 + 撤 ntok）
    expect(ack.backup_path).toBeTruthy();
    // 判据落在字节上：源目录消失、备份目录里能读到原文件
    expect(() => statSync(join(workdirRoot, alias))).toThrow();
    const moved = readdirSync(deletedRoot);
    expect(moved.length).toBe(1);
    expect(readdirSync(join(deletedRoot, moved[0]))).toContain("config.json");
  });

  // 🔴 这条我一开始写成期望 noop_not_my_child，验 hub 侧才发现那会复现原 bug：
  //    server/src/tools.ts 的 ack_stop_request 对 noop_not_my_child **没有分支**，
  //    只更新 request 行，nodes.lifecycle_state 停在 'deleting' —— 正是上报的症状。
  //    delete 的终态是「不在跑 + 配置不在」，盘上本来就没有时该终态已成立 ⇒ 必须收敛。
  test("未命中 + 盘上也没有该目录 ⇒ 仍 ack stopped 让 hub 收敛，但不给 backup_path", async () => {
    const workdirRoot = join(scratch, "nodes");
    const deletedRoot = join(scratch, "deleted");
    mkdirSync(workdirRoot, { recursive: true });
    const h = makeDeps({
      workdirRoot, deletedRoot,
      getStopReturn: {
        ok: true, request_id: "req-none", child_node_id: "node_absent", child_alias: "absent-1286",
        action: "delete", delete_config: true, grace_seconds: 10, force: false,
      },
    });
    await handleStopDoorbell({ request_id: "req-none" }, h.deps as any);
    const ack = h.acks.at(-1)!.args;
    expect(ack.status).toBe("stopped");
    expect(ack.backup_path).toBeUndefined();   // 区分「搬走了」和「本来就没有」
  });

  // 🔴 这条同样修正过：命中路径对「移动失败」的既有立场是**不让 delete 失败**
  //    （子进程已不在，行仍应收敛，本地回收站泄漏靠 warn 暴露）。新分支若更严，
  //    同一个条件在两条路径上就会有两种行为 —— 比任一种单独选择都差。
  test("未命中 + 移动失败 ⇒ 与命中路径同立场：仍 ack stopped、无 backup_path、warn 里有原因", async () => {
    const workdirRoot = join(scratch, "nodes");
    const deletedRoot = join(scratch, "deleted");
    const alias = "child-mvfail-1286";
    seedWorkdir(workdirRoot, alias);
    const h = makeDeps({
      workdirRoot, deletedRoot,
      getStopReturn: {
        ok: true, request_id: "req-mvfail", child_node_id: "node_mvfail", child_alias: alias,
        action: "delete", delete_config: true, grace_seconds: 10, force: false,
      },
    });
    const warns: string[] = [];
    (h.deps as any).warn = (m: string) => warns.push(m);
    (h.deps as any).renameDir = () => { throw new Error("EXDEV cross-device"); };
    await handleStopDoorbell({ request_id: "req-mvfail" }, h.deps as any);
    const ack = h.acks.at(-1)!.args;
    expect(ack.status).toBe("stopped");
    expect(ack.backup_path).toBeUndefined();
    expect(warns.join("\n")).toContain("EXDEV");
    // 目录没被搬走这件事必须仍然看得见，而不是被 ack 盖掉
    expect(statSync(join(workdirRoot, alias)).isDirectory()).toBe(true);
  });

  // #1448 finding-3 — stop 的收敛路径**绝不**动 config 目录(那是 delete 的语义)——即使盘上有目录、
  // 即使请求误带 delete_config,stop 都必须原样保留。
  test("#1448 finding-3: stop 未命中 map 时,盘上 config 目录被保留(不搬进回收站)", async () => {
    const workdirRoot = join(scratch, "nodes-f3-stop");
    const deletedRoot = join(scratch, "deleted-f3-stop");
    mkdirSync(workdirRoot, { recursive: true });
    const childDir = join(workdirRoot, "alias-f3-keep");
    mkdirSync(childDir);
    writeFileSync(join(childDir, "config.json"), JSON.stringify({ token: "ntok_keep" }), { mode: 0o600 });

    const { acks, deps } = makeDeps({
      workdirRoot, deletedRoot,
      getStopReturn: {
        ok: true, request_id: "req-stop-keep", child_node_id: "node_keep", child_alias: "alias-f3-keep",
        // 故意把 delete_config 设 true 也不能让 stop 搬目录——action 门挡住。
        action: "stop", delete_config: true, grace_seconds: 10, force: false,
      },
    });
    await handleStopDoorbell({ request_id: "req-stop-keep" }, deps);
    expect(acks.at(-1)!.args.status).toBe("stopped");
    expect(acks.at(-1)!.args.backup_path).toBeUndefined();
    // 原目录仍在，回收站没有它
    expect(statSync(childDir).isDirectory()).toBe(true);
    expect(existsSync(deletedRoot) ? readdirSync(deletedRoot).length : 0).toBe(0);
  });
});

// ─── #1286 —— 备份到 ack 之间那段的可观测性 ────────────────────────────
//
// 真机复现（两次，行为一致）：新建子节点 → 直接 delete_node，daemon 日志**每次都停在**
// `backed up child workdir`，之后 48 秒零输出，hub 行永远停在 lifecycle_state=deleting。
// 那段里只有三步（residual sweep → childrenMap.delete → ack_stop_request），
// 但三步在源码上都有 try/catch 或 .catch 保护，**静态读不出是哪一步**。
//
// 🔴 这两条测试不断言「#1286 已修好」—— 它没修好。它们断言的是：下一次复现能
//    直接从日志读出停在哪一步，而不是又一次「停住了」。
describe("#1286 — 备份到 ack 之间的每一步都要留痕", () => {
  test("delete 路径按顺序打出 进入清扫 / 清扫返回 / 已出 map / ack 被接受", async () => {
    const workdirRoot = join(scratch, "nodes");
    const deletedRoot = join(scratch, "deleted");
    mkdirSync(workdirRoot, { recursive: true });
    mkdirSync(join(workdirRoot, "alias-obs"));

    recordSpawnedChild("node_obs", "alias-obs", 5556);
    const { acks, deps } = makeDeps({
      workdirRoot, deletedRoot,
      getStopReturn: {
        ok: true, request_id: "sr_obs",
        child_node_id: "node_obs", child_alias: "alias-obs",
        action: "delete", delete_config: true, grace_seconds: 10, force: false,
      },
    });
    const lines: string[] = [];
    (deps as any).log = (m: string) => lines.push(m);
    (deps as any).warn = (m: string) => lines.push(m);

    await handleStopDoorbell({ request_id: "sr_obs" }, deps);
    expect(acks.length).toBe(1);

    const joined = lines.join("\n");
    // 复现时日志停在这一行 —— 它是这段的起点，必须还在。
    const iBackup = lines.findIndex(l => l.includes("backed up child workdir"));
    const iEnter  = lines.findIndex(l => l.includes("entering residual sweep"));
    const iReturn = lines.findIndex(l => l.includes("residual sweep returned"));
    const iMap    = lines.findIndex(l => l.includes("dropped from children map"));
    const iAck    = lines.findIndex(l => l.includes("ack accepted"));
    for (const [name, i] of [["backup", iBackup], ["enter", iEnter], ["return", iReturn], ["map", iMap], ["ack", iAck]] as const) {
      expect(`${name}=${i}\n${joined}`).not.toContain(`${name}=-1`);
    }
    // 顺序本身就是判据：只有严格递增，日志停在哪一行才等于停在哪一步。
    expect(iBackup).toBeLessThan(iEnter);
    expect(iEnter).toBeLessThan(iReturn);
    expect(iReturn).toBeLessThan(iMap);
    expect(iMap).toBeLessThan(iAck);
  });

  test("🔴 关键路径上的 execSync 必须带 timeout 和 maxBuffer", () => {
    const src = readFileSync(new URL("./stop-daemon.ts", import.meta.url), "utf8");
    // 正控：这一行确实在（否则下面的断言在文件被改名/重构后会空过）
    expect(src).toContain("pgrep -af 'agent-node'");
    const i = src.indexOf("pgrep -af 'agent-node'");
    const call = src.slice(i, i + 240);
    // 无 timeout ⇒ pgrep 卡住时 ack 永不发出，用户侧就是「删不掉」，且不报任何错。
    expect(call).toContain("timeout:");
    // 无 maxBuffer ⇒ 默认 1MB；`pgrep -af` 打完整命令行，进程多的机器会 ENOBUFS，
    // 那条路径被 catch 住 ⇒ 清扫**静默失效**（ack 照发，所以不会自曝）。
    expect(call).toContain("maxBuffer:");
  });
});
