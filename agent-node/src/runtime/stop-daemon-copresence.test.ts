// #596 — daemon stop/delete of a Codex TUI co-presence child it created.
//
// The child's `anet node start` is only a launcher: it starts three tmux
// sessions (TUI / app-server / bridge) that carry the node's ANET_NODE_MARKER,
// writes <node>/copresence-identity.json, and exits. Nothing the daemon used to
// do (process-group signal of the recorded launcher pid, `--alias + --config`
// sweep) reaches those sessions, so they kept running after stop/delete.
//
// These tests pin the daemon-side decision: when (and only when) the config this
// daemon wrote says codexCopresence:true for THIS node_id and the identity
// marker is on disk, the daemon hands the teardown to the product's
// `anet node stop <alias>` in the child's workdir — before the trash move — and
// fails closed if that teardown fails. The end-to-end proof (real tmux + real
// codex) is tests/qa-daemon-stop-codex-copresence.
//
// Imported as a namespace on purpose: on a build without the fix the new export
// is simply undefined and each assertion goes red on its own, instead of the
// whole file dying at import.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as sd from "./stop-daemon";
import * as cnd from "./create-node-daemon";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let scratch = "";
let workDir = "";
let workdirRoot = "";
let deletedRoot = "";
beforeEach(() => {
  sd._resetChildrenMapForTest();
  scratch = mkdtempSync(join(tmpdir(), "stop-daemon-cp-"));
  workDir = join(scratch, "wd");
  workdirRoot = join(workDir, ".anet", "nodes");
  deletedRoot = join(workDir, ".anet", "deleted");
  mkdirSync(workdirRoot, { recursive: true });
});
afterEach(() => { if (scratch) rmSync(scratch, { recursive: true, force: true }); });

const ALIAS = "cx-shared";
const NODE_ID = "node_cp596";

function writeChild(opts: { copresence?: boolean; marker?: boolean; nodeId?: string } = {}) {
  const dir = join(workdirRoot, ALIAS);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify({
    node_id: opts.nodeId ?? NODE_ID, node_name: ALIAS, alias: ALIAS, runtime: "codex-app-server",
    ...(opts.copresence === false ? {} : { codexCopresence: true }),
  }), { mode: 0o600 });
  if (opts.marker !== false) {
    writeFileSync(join(dir, "copresence-identity.json"), JSON.stringify({ marker: "11111111-2222-4333-8444-555555555555" }), { mode: 0o600 });
  }
  return dir;
}

function harness(action: "stop" | "delete", teardown: { ok: boolean; detail: string } = { ok: true, detail: "Stopped" }) {
  const acks: any[] = [];
  const events: string[] = [];
  const calls: Array<{ alias: string; cwd: string }> = [];
  const signals: Array<{ pid: number; sig: any }> = [];
  let now = 1_700_000_000_000;
  const deps: any = {
    callCommHub: async (tool: string, args: any) => {
      if (tool === "get_stop_request") {
        return { ok: true, request_id: "sr_cp", child_node_id: NODE_ID, child_alias: ALIAS, action, delete_config: action === "delete", grace_seconds: 1 };
      }
      events.push(`ack:${args.status}`);
      acks.push({ tool, args });
      return { ok: true };
    },
    log: () => {}, warn: () => {},
    workDir, workdirRoot, deletedRoot,
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
    readPgid: () => null,
    signalProcess: (pid: number, sig: any) => {
      signals.push({ pid, sig });
      if (sig === 0 && signals.some(s => s.sig === "SIGTERM")) { const e: any = new Error("ESRCH"); e.code = "ESRCH"; throw e; }
    },
    renameDir: (src: string, dst: string) => {
      events.push("move");
      mkdirSync(deletedRoot, { recursive: true });
      require("node:fs").renameSync(src, dst);
    },
    stopCopresenceNode: async (alias: string, cwd: string) => {
      events.push("teardown");
      calls.push({ alias, cwd });
      return teardown;
    },
  };
  return { deps, acks, events, calls, signals };
}

describe("#596 copresenceTeardownFor — which children get the identity teardown", () => {
  test("codexCopresence:true + this node_id + marker on disk → yes", () => {
    writeChild();
    expect(typeof sd.copresenceTeardownFor).toBe("function");
    expect(sd.copresenceTeardownFor?.(workdirRoot, ALIAS, NODE_ID)).toBe(true);
  });
  test("marker missing → no (anet node stop would fall back to a tmux-NAME sweep)", () => {
    writeChild({ marker: false });
    expect(sd.copresenceTeardownFor?.(workdirRoot, ALIAS, NODE_ID)).toBe(false);
  });
  test("ordinary node (no codexCopresence) → no", () => {
    writeChild({ copresence: false });
    expect(sd.copresenceTeardownFor?.(workdirRoot, ALIAS, NODE_ID)).toBe(false);
  });
  test("config belongs to another node_id → no", () => {
    writeChild({ nodeId: "node_someone_else" });
    expect(sd.copresenceTeardownFor?.(workdirRoot, ALIAS, NODE_ID)).toBe(false);
  });
  test("alias that is not a single path segment → no", () => {
    writeChild();
    expect(sd.copresenceTeardownFor?.(workdirRoot, "../" + ALIAS, NODE_ID)).toBe(false);
  });
});

describe("#596 handleStopDoorbell — co-presence child, no children-map entry (launcher already exited)", () => {
  test("stop → `anet node stop <alias>` in the child's workdir, ack stopped, config kept", async () => {
    const dir = writeChild();
    const h = harness("stop");
    await sd.handleStopDoorbell({ request_id: "sr_cp" }, h.deps);
    expect(h.calls).toEqual([{ alias: ALIAS, cwd: workDir }]);
    expect(h.acks.map(a => a.args.status)).toEqual(["stopped"]);
    expect(existsSync(join(dir, "config.json"))).toBe(true);
  });

  test("delete → teardown runs BEFORE the workdir moves to the trash (marker lives in it)", async () => {
    writeChild();
    const h = harness("delete");
    await sd.handleStopDoorbell({ request_id: "sr_cp" }, h.deps);
    expect(h.events).toEqual(["teardown", "move", "ack:stopped"]);
    expect(readdirSync(deletedRoot).length).toBe(1);
  });

  test("teardown fails → stop_failed with the reason, node dir NOT moved (fail closed)", async () => {
    const dir = writeChild();
    const h = harness("delete", { ok: false, detail: "anet node stop exit=1: identity teardown incomplete" });
    await sd.handleStopDoorbell({ request_id: "sr_cp" }, h.deps);
    expect(h.calls.length).toBe(1);
    expect(h.acks.map(a => a.args.status)).toEqual(["stop_failed"]);
    expect(String(h.acks[0].args.error)).toContain("identity teardown incomplete");
    expect(existsSync(join(dir, "copresence-identity.json"))).toBe(true);
    expect(h.events).not.toContain("move");
  });

  test("marker missing → no teardown call (never a name-based sweep), ack stopped as before", async () => {
    writeChild({ marker: false });
    const h = harness("stop");
    await sd.handleStopDoorbell({ request_id: "sr_cp" }, h.deps);
    expect(h.calls).toEqual([]);
    expect(h.acks.map(a => a.args.status)).toEqual(["stopped"]);
  });

  test("ordinary (non-co-presence) child → behaviour unchanged, no teardown call", async () => {
    writeChild({ copresence: false, marker: false });
    const h = harness("delete");
    await sd.handleStopDoorbell({ request_id: "sr_cp" }, h.deps);
    expect(h.calls).toEqual([]);
    expect(h.events).toEqual(["move", "ack:stopped"]);
  });
});

describe("#596 handleStopDoorbell — co-presence child still in the map (launcher mid-start)", () => {
  test("signals the launcher group first, then the identity teardown, then acks", async () => {
    writeChild();
    sd.recordSpawnedChild(NODE_ID, ALIAS, 424242);
    const h = harness("stop");
    await sd.handleStopDoorbell({ request_id: "sr_cp" }, h.deps);
    expect(h.signals.some(s => s.sig === "SIGTERM")).toBe(true);
    expect(h.calls).toEqual([{ alias: ALIAS, cwd: workDir }]);
    expect(h.acks.map(a => a.args.status)).toEqual(["stopped"]);
    expect(sd.getChildrenSnapshot().length).toBe(0);
  });

  test("teardown failure on the hit path → stop_failed", async () => {
    writeChild();
    sd.recordSpawnedChild(NODE_ID, ALIAS, 424242);
    const h = harness("stop", { ok: false, detail: "boom" });
    await sd.handleStopDoorbell({ request_id: "sr_cp" }, h.deps);
    expect(h.acks.map(a => a.args.status)).toEqual(["stop_failed"]);
  });
});

describe("#596 forgetSpawnedChildIfPid — a launcher's exit drops only its own entry", () => {
  test("matching pid → removed; a newer generation's pid → kept", () => {
    expect(typeof sd.forgetSpawnedChildIfPid).toBe("function");
    sd.recordSpawnedChild(NODE_ID, ALIAS, 100);
    expect(sd.forgetSpawnedChildIfPid?.(NODE_ID, 999)).toBe(false);
    expect(sd.getChildrenSnapshot().map(c => c.pid)).toEqual([100]);
    expect(sd.forgetSpawnedChildIfPid?.(NODE_ID, 100)).toBe(true);
    expect(sd.getChildrenSnapshot()).toEqual([]);
  });
});

describe("#596 copresenceLauncherVerdict — the +5 s check on a co-presence launcher", () => {
  test("exit 0 with the identity marker on disk is a start, not a capability failure", () => {
    expect(typeof cnd.copresenceLauncherVerdict).toBe("function");
    expect(cnd.copresenceLauncherVerdict?.({ code: 0, signal: null }, true)).toEqual({ started: true });
  });
  test("exit 3 (needs codex login), a signal, an unobserved exit, or 0 without marker → failed, with how", () => {
    const v = cnd.copresenceLauncherVerdict;
    expect(v?.({ code: 3, signal: null }, true)).toEqual({ started: false, how: "exit code 3" });
    expect(v?.({ code: null, signal: "SIGKILL" }, true)).toEqual({ started: false, how: "signal SIGKILL" });
    expect(v?.(null, true)).toEqual({ started: false, how: "exit not observed" });
    expect(v?.({ code: 0, signal: null }, false)).toEqual({ started: false, how: "exit code 0, no identity marker written" });
  });
});
