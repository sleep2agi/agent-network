import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { handleStartDoorbell } from "./start-daemon.js";
import { supportsCodexForkRecovery } from "./codex-fork-capability.js";
import { writeAdoptedChild } from "./adopt-registry.js";
import { _resetChildrenMapForTest } from "./stop-daemon.js";

let root: string;
const REQUEST = "str_recovery";
const OLD = "01a11846-d796-72f1-af68-8d9215a65dc8";
const NEW = "01a11900-0000-7000-8000-000000000001";
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "fork-start-")); _resetChildrenMapForTest(); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

function fixture() {
  const nodeDir = join(root, "child-a");
  mkdirSync(nodeDir);
  const config = { node_id: "node_child_a", alias: "child-a", runtime: "codex-app-server", codexCopresence: true };
  const saveConfig = () => writeFileSync(join(nodeDir, "config.json"), JSON.stringify(config), { mode: 0o600 });
  saveConfig();
  const envelope: any = { ok: true, request_id: REQUEST, child_node_id: config.node_id, child_alias: config.alias,
    start_completion_capable: true, managed: "created", fork_recovery: { kind: "fork_on_missing_ordinal", confirmed: true } };
  const child = Object.assign(new EventEmitter(), { pid: 4242, unref() {} });
  const acks: any[] = [], spawns: any[] = [], probes: any[] = [];
  const deps: any = {
    workDir: root, nodesRoot: root, anetBin: () => "/trusted/anet",
    spawnChild: (bin: string, args: string[]) => { spawns.push({ bin, args }); return child; },
    probeCodexForkRecovery: async (bin: string, cwd: string) => { probes.push({ bin, cwd }); return true; },
    log() {}, warn() {},
    callCommHub: async (tool: string, args: any) => {
      if (tool === "get_start_request") {
        expect(args).toEqual({ request_id: REQUEST, fork_recovery_capable: true });
        return envelope;
      }
      acks.push(args); return { ok: true, status: args.status };
    },
  };
  const saveMapping = () => writeFileSync(join(nodeDir, "codex-fork-recovery.json"), JSON.stringify({ forks: [
    { requestId: REQUEST, oldThreadId: OLD, newThreadId: NEW, snapshot: "/private/snapshot" },
  ] }));
  return { config, saveConfig, envelope, child, acks, spawns, probes, deps, saveMapping, nodeDir };
}

test.each([0, 7])("confirmed recovery passes exact argv and retains fork evidence even on exit %s", async code => {
  const f = fixture();
  const pending = handleStartDoorbell({ request_id: REQUEST }, f.deps);
  await tick();
  expect(f.probes).toEqual([{ bin: "/trusted/anet", cwd: root }]);
  expect(f.spawns).toEqual([{ bin: "/trusted/anet", args: ["node", "start", "child-a",
    "--fork-on-resume-failure", "--yes", "--fork-recovery-request-id", REQUEST] }]);
  expect(f.acks.map(a => a.status)).toEqual(["starting"]);
  f.saveMapping(); f.child.emit("exit", code, null); await pending;
  expect(f.acks.at(-1)).toMatchObject({ status: code === 0 ? "started" : "start_failed",
    fork_recovery: { state: "forked", old_thread_id: OLD, new_thread_id: NEW } });
  expect(JSON.stringify(f.acks)).not.toContain("/private");
});

test("unconfirmed/malformed or mismatched request never probes or launches", async () => {
  const f = fixture();
  for (const recovery of [null, {}, { kind: "fork_on_missing_ordinal", confirmed: false }, { kind: "other", confirmed: true }]) {
    f.envelope.fork_recovery = recovery;
    await handleStartDoorbell({ request_id: REQUEST }, f.deps);
    expect(f.acks.at(-1).error).toBe("codex_fork_confirmation_invalid");
  }
  f.envelope.fork_recovery = { kind: "fork_on_missing_ordinal", confirmed: true };
  f.envelope.request_id = "str_different";
  await handleStartDoorbell({ request_id: REQUEST }, f.deps);
  expect(f.acks.at(-1).error).toBe("codex_fork_confirmation_invalid");
  expect(f.probes).toEqual([]); expect(f.spawns).toEqual([]);
});

test("old protocol, adopted binding and other runtime cannot downgrade to ordinary start", async () => {
  const f = fixture();
  for (const patch of [{ start_completion_capable: false }, { managed: "adopted" }, { managed: undefined }]) {
    Object.assign(f.envelope, { start_completion_capable: true, managed: "created" }, patch);
    await handleStartDoorbell({ request_id: REQUEST }, f.deps);
    expect(f.acks.at(-1).error).toBe("codex_fork_recovery_unsupported");
  }
  f.envelope.managed = "created";
  f.config.runtime = "codex-sdk"; f.saveConfig();
  await handleStartDoorbell({ request_id: REQUEST }, f.deps);
  expect(f.acks.at(-1).error).toBe("codex_fork_recovery_unsupported");
  f.config.runtime = "codex-app-server"; f.saveConfig();
  writeAdoptedChild(root, "child-a", { adopted: true, request_id: "adr_one", node_id: "node_child_a",
    workdir: root, nodeDir: f.nodeDir, launch_mode: "bare" });
  await handleStartDoorbell({ request_id: REQUEST }, f.deps);
  expect(f.acks.at(-1).error).toBe("codex_fork_recovery_unsupported");
  expect(f.probes).toEqual([]); expect(f.spawns).toEqual([]);
});

test("pinned CLI lacking capability fails without launching", async () => {
  const f = fixture(); f.deps.probeCodexForkRecovery = async () => false;
  await handleStartDoorbell({ request_id: REQUEST }, f.deps);
  expect(f.acks).toEqual([{ request_id: REQUEST, status: "start_failed", error: "codex_fork_cli_unsupported",
    fork_recovery: { state: "not_observed" } }]);
  expect(f.spawns).toEqual([]);
});

test("no mapping is not_observed, and lost ack replays cached evidence without a second launch", async () => {
  const f = fixture(); const call = f.deps.callCommHub; let lost = true;
  f.deps.callCommHub = async (tool: string, args: any) => {
    if (args.status === "start_failed" && lost) { lost = false; throw Error("offline"); }
    return call(tool, args);
  };
  const pending = handleStartDoorbell({ request_id: REQUEST }, f.deps).catch(error => error);
  await tick(); f.child.emit("exit", 7, null);
  expect((await pending).message).toBe("offline");
  // History may change after completion; a same-daemon replay returns its
  // original result, not a new interpretation of an unrelated later write.
  f.saveMapping();
  await handleStartDoorbell({ request_id: REQUEST }, f.deps);
  expect(f.acks.at(-1).fork_recovery).toEqual({ state: "not_observed" });
  expect(f.spawns.length).toBe(1); expect(f.probes.length).toBe(1);
});

test("capability probe executes only pinned CLI help and rejects old/failed help", async () => {
  const bin = join(root, "fake-anet");
  const help = "--fork-on-resume-failure\n--fork-recovery-request-id <str_…>\n(non-interactive: also pass --yes)";
  for (const [output, exitCode, expected] of [[help, 0, true], ["--fork-on-resume-failure --yes", 0, false],
    [help.replace("--yes)", "--yes-danger-full-access)"), 0, false], [help, 2, false]] as const) {
    writeFileSync(bin, `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== '["node","start","--help"]') process.exit(3);\nconsole.log(${JSON.stringify(output)}); process.exit(${exitCode});\n`, { mode: 0o700 });
    expect(await supportsCodexForkRecovery(bin, root)).toBe(expected);
  }
  expect(await supportsCodexForkRecovery(join(root, "absent"), root)).toBe(false);
});
