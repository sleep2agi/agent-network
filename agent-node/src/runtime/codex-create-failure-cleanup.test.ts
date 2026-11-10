// #1650 — codex 共存建节点:post-spawn 校验失败必须收尸,而且**只在身份标记在盘上时**才收。
//
// 这个文件是门级(doorbell)证据,三条锁:
//   1. marker 不在盘上 → 绝不调 `anet node stop`(CLI 会退回按显示名清扫),ack 只能说
//      `cleanup=no_live_generation`;
//   2. marker 在盘上 + 启动器失败 → 走 `anet node stop <alias>`,ack 带 `cleanup=reaped`;
//   3. 反向:`exit 0` + marker 的正常路径仍然 ack `started`,且**从不**调 stop。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _prependChildPathForTest,
  _resetAnetBinAbsForTest,
  _resetDaemonExtraPathForTest,
  handleCreateNodeDoorbell,
  serializeEnvLocalDaemon,
} from "./create-node-daemon.js";

let home = "";
let workDir = "";
let pinRoot = "";
let binDir = "";
const killPids: number[] = [];
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "HOME", "XDG_CONFIG_HOME", "ANET_BIN_ABS", "ANET_DAEMON_ALLOW_ENV_BIN",
  "ANET_BIN_SHA256", "ANET_DAEMON_PATH_CONF", "ANET_DAEMON_STRICT_ROOT_BIN",
];

/** 假 anet:只关心 `node stop`。cwd = childWorkDir,所以用 $PWD 落日志(最小 env 不带测试变量)。 */
function writeFakeAnet(root: string): string {
  const pkg = join(root, "pkg");
  const bin = join(pkg, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@sleep2agi/agent-network",
    bin: { anet: "bin/anet.cjs" },
  }));
  const abs = join(bin, "anet.cjs");
  writeFileSync(abs, [
    "#!/bin/sh",
    "# #1650 test shim: record `node stop` in the cwd, then exit 0",
    'if [ "$1" = "node" ] && [ "$2" = "stop" ]; then',
    '  printf "%s\\n" "$*" >> "$PWD/.anet-stop-called"',
    "fi",
    "exit 0",
    "",
  ].join("\n"), { mode: 0o755 });
  chmodSync(abs, 0o755);
  return realpathSync(abs);
}

function writeFakeCodex(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, "codex"), "#!/bin/sh\necho 'codex-cli 9.9.9'\n", { mode: 0o755 });
  chmodSync(join(dir, "codex"), 0o755);
}

beforeEach(() => {
  _resetDaemonExtraPathForTest();
  home = realpathSync(mkdtempSync(join(tmpdir(), "t1650-home-")));
  workDir = join(home, "daemon");
  mkdirSync(workDir, { recursive: true, mode: 0o700 });
  pinRoot = mkdtempSync(join(tmpdir(), "t1650-pin-"));
  binDir = mkdtempSync(join(tmpdir(), "t1650-bin-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { refresh_token: "placeholder" } }), { mode: 0o600 });
  writeFakeCodex(binDir);
  _prependChildPathForTest([binDir]);

  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  process.env.ANET_DAEMON_PATH_CONF = join(pinRoot, "missing-path.conf");
  process.env.ANET_DAEMON_ALLOW_ENV_BIN = "1";
  process.env.ANET_BIN_ABS = writeFakeAnet(pinRoot);
  delete process.env.ANET_BIN_SHA256;
  delete process.env.ANET_DAEMON_STRICT_ROOT_BIN;
  _resetAnetBinAbsForTest();
});

afterEach(() => {
  for (const pid of killPids.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  _resetAnetBinAbsForTest();
  _resetDaemonExtraPathForTest();
  rmSync(home, { recursive: true, force: true });
  rmSync(pinRoot, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
});

const NODE_NAME = "cleanup-node";
const nodeDir = () => join(workDir, ".anet", "nodes", NODE_NAME);
const stopLog = () => join(workDir, ".anet-stop-called");

/** 启动器写 identity marker(启动器在起任何 tmux 会话之前就写它)。 */
function writeIdentityMarker(): void {
  mkdirSync(nodeDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(nodeDir(), "copresence-identity.json"),
    JSON.stringify({ marker: "11111111-2222-4333-8444-555555555555" }), { mode: 0o600 });
}

type Ack = Record<string, unknown>;

async function runCreate(opts: {
  requestId: string;
  capabilityCheckMs: number;
  spawnChild: (bin: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv }) => any;
}): Promise<Ack[]> {
  const acks: Ack[] = [];
  await handleCreateNodeDoorbell({ request_id: opts.requestId }, {
    callCommHub: async (tool: string, args: Record<string, unknown>) => {
      if (tool === "get_create_request") {
        return {
          ok: true,
          request_id: opts.requestId,
          node_spec: { name: NODE_NAME, runtime: "codex-app-server", flags: { copresence: true } },
          child_token: "ntok_placeholder_1650",
        };
      }
      if (tool === "ack_create_request") { acks.push(args); return { ok: true }; }
      throw new Error(`unexpected tool ${tool}`);
    },
    workDir,
    hubUrl: "http://127.0.0.1:9",
    log: () => {},
    warn: () => {},
    serializeEnvLocal: serializeEnvLocalDaemon,
    capabilityCheckMs: opts.capabilityCheckMs,
    spawnChild: opts.spawnChild,
  });
  return acks;
}

/** 真实子进程:先活过 spawn 的 kill-0,再在能力检查前退出。 */
function launchShell(script: string): any {
  const child = spawn("sh", ["-c", script], { stdio: "ignore", detached: true });
  if (child.pid) killPids.push(child.pid);
  return child;
}

describe("#1650 codex 失败分支收尸", () => {
  test("没有 identity marker:绝不调用 anet node stop,ack 只说 cleanup=no_live_generation", async () => {
    const acks = await runCreate({
      requestId: "cr_t1650nomarker",
      capabilityCheckMs: 900,
      spawnChild: () => launchShell("sleep 0.6; exit 3"),
    });
    expect(acks.map((a) => a.status)).toEqual(["runtime_capability_check_failed"]);
    expect(String(acks[0].error)).toContain("cleanup=no_live_generation");
    // 🔴 主锁:marker 不在盘上时,`anet node stop` 会退回按显示名清扫(按名字杀)。
    expect(existsSync(stopLog())).toBe(false);
  });

  test("marker 在盘上 + 启动器失败:走 anet node stop,ack 说 cleanup=reaped", async () => {
    const acks = await runCreate({
      requestId: "cr_t1650reap",
      capabilityCheckMs: 900,
      spawnChild: () => { writeIdentityMarker(); return launchShell("sleep 0.6; exit 3"); },
    });
    expect(acks.map((a) => a.status)).toEqual(["runtime_capability_check_failed"]);
    expect(String(acks[0].error)).toContain("cleanup=reaped");
    expect(existsSync(stopLog())).toBe(true);
    expect(readFileSync(stopLog(), "utf8")).toContain(`node stop ${NODE_NAME}`);
  });

  test("反向锁:exit 0 + marker 仍然 ack started,且从不调用 stop", async () => {
    const acks = await runCreate({
      requestId: "cr_t1650started",
      capabilityCheckMs: 900,
      spawnChild: () => { writeIdentityMarker(); return launchShell("sleep 0.5"); },
    });
    expect(acks.map((a) => a.status)).toEqual(["started"]);
    expect(existsSync(stopLog())).toBe(false);
    // 正常路径不该被 #1650 的收尸粘住
    expect(String(acks[0].error ?? "")).toBe("");
  });
});
