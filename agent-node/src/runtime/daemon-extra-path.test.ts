// #648 — daemon 子节点 PATH 只追加 config.json 里写明的绝对目录。
// codex 只放在 /opt/x/bin。不配置时就绪是 missing_cli 且建节点在 spawn 前被拒;
// 配置之后就绪是 ready,并且 spawn 出去的环境能跑到这个 codex。
// 网络探测打桩,避免出网把结论从 ready 打成 no_network。CLI 解析和 --version 是真的。

import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _prependChildPathForTest,
  _resetAnetBinAbsForTest,
  _resetDaemonExtraPathForTest,
  appendExtraPath,
  applyDaemonExtraPath,
  computeChildPath,
  DAEMON_EXTRA_PATH_FIELD,
  handleCreateNodeDoorbell,
  minimalEnv,
  parseDaemonExtraPath,
  serializeEnvLocalDaemon,
} from "./create-node-daemon.js";
import { probeRuntimeReadiness, realReadinessDeps } from "./runtime-readiness.js";

const CODEX = "/opt/x/bin/codex";
const MARKER = "board648-fake-codex";
const TOKEN = "rt-demo-placeholder";

test("parseDaemonExtraPath: 只要绝对路径,去重,不接受字符串", () => {
  expect(parseDaemonExtraPath(["/opt/x/bin/", "/opt/x/bin", "rel/bin", "~/bin", ""], "linux"))
    .toEqual(["/opt/x/bin"]);
  expect(parseDaemonExtraPath("/opt/x/bin", "linux")).toEqual([]);
  expect(parseDaemonExtraPath(["/opt/x/bin:/usr/bin"], "linux")).toEqual([]);
  expect(parseDaemonExtraPath(["C:\\Tools\\codex\\", "rel", "C:\\Tools\\codex"], "win32"))
    .toEqual(["C:\\Tools\\codex"]);
  expect(appendExtraPath("/usr/bin:/bin", ["/usr/bin", "/opt/x/bin"], "linux"))
    .toBe("/usr/bin:/bin:/opt/x/bin");
});

test("cli.ts 在启动和热更新时都把 daemonExtraPath 交给同一份 PATH", () => {
  const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8");
  const n = cli.split("applyDaemonExtraPath(fileConfig.daemonExtraPath)").length - 1;
  expect(n).toBe(2);
  const src = readFileSync(new URL("./create-node-daemon.ts", import.meta.url), "utf8");
  expect(src).toContain("appendExtraPath(computeChildPath(platform), daemonExtraPathDirs, platform)");
  expect(src).toContain(DAEMON_EXTRA_PATH_FIELD);
});

test("test-only child PATH prefix is searched first and is absent unless a test sets it", () => {
  _resetDaemonExtraPathForTest();
  const planted = "/tmp/planted-opencode-bin";
  expect(minimalEnv({}, "linux", { HOME: "/home/user" }).PATH ?? "").not.toContain(planted);
  expect(_prependChildPathForTest([planted], "linux")).toEqual([planted]);
  const prefixed = minimalEnv({}, "linux", { HOME: "/home/user" }).PATH ?? "";
  expect(prefixed.startsWith(`${planted}:`)).toBe(true);
  expect(prefixed.slice(planted.length + 1)).toBe(computeChildPath("linux"));
  _resetDaemonExtraPathForTest();
  expect(minimalEnv({}, "linux", { HOME: "/home/user" }).PATH).toBe(computeChildPath("linux"));
});

test("codex 只在 /opt/x/bin: 不配置则 missing_cli 且拒绝建节点; 配置后 ready 且能建", async () => {
  if (existsSync(CODEX) && !readFileSync(CODEX, "utf8").includes(MARKER)) {
    throw new Error("refusing to overwrite existing /opt/x/bin/codex");
  }
  mkdirSync("/opt/x/bin", { recursive: true });
  writeFileSync(CODEX, `#!/bin/sh\n# ${MARKER}\necho 'codex-cli 9.9.9'\n`, { mode: 0o755 });
  chmodSync(CODEX, 0o755);

  const home = mkdtempSync(join(tmpdir(), "board648-home-"));
  const rejectDir = mkdtempSync(join(tmpdir(), "board648-reject-"));
  const createDir = mkdtempSync(join(tmpdir(), "board648-create-"));
  const pinRoot = mkdtempSync(join(tmpdir(), "board648-pin-"));
  mkdirSync(join(home, ".codex"), { recursive: true });
  writeFileSync(join(home, ".codex", "auth.json"), JSON.stringify({ tokens: { refresh_token: TOKEN } }), { mode: 0o600 });

  const saved = {
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    ANET_BIN_ABS: process.env.ANET_BIN_ABS,
    ANET_DAEMON_ALLOW_ENV_BIN: process.env.ANET_DAEMON_ALLOW_ENV_BIN,
    ANET_BIN_SHA256: process.env.ANET_BIN_SHA256,
    ANET_DAEMON_PATH_CONF: process.env.ANET_DAEMON_PATH_CONF,
    ANET_DAEMON_STRICT_ROOT_BIN: process.env.ANET_DAEMON_STRICT_ROOT_BIN,
  };
  let sleepPid = 0;
  const restoreEnv = () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };

  try {
    process.env.HOME = home;
    process.env.PATH = `/opt/x/bin:${saved.PATH ?? "/usr/bin:/bin"}`;
    _resetDaemonExtraPathForTest();

    const bare = minimalEnv();
    expect(bare.PATH ?? "").not.toContain("/opt/x/bin");
    expect(bare.PATH).toBe(computeChildPath());

    const missing = await probeCodex();
    expect(missing.state).toBe("missing_cli");
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain("codex");
    expect(missing.reason).toContain(DAEMON_EXTRA_PATH_FIELD);
    expect(JSON.stringify(missing)).not.toContain(TOKEN);
    expect(JSON.stringify(missing)).not.toContain("/opt/x/bin");

    let spawned = false;
    const rejected: Record<string, unknown>[] = [];
    await handleCreateNodeDoorbell({ request_id: "cr_board648miss" }, doorbell(rejectDir, rejected, () => {
      spawned = true;
      throw new Error("spawned");
    }));
    expect(spawned).toBe(false);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].status).toBe("rejected");
    expect(String(rejected[0].error)).toContain("codex");
    expect(String(rejected[0].error)).toContain(DAEMON_EXTRA_PATH_FIELD);
    expect(String(rejected[0].error)).toContain("config.json");
    expect(String(rejected[0].error)).not.toContain("/opt/x/bin");
    expect(existsSync(join(rejectDir, ".anet", "nodes", "demo-node", "config.json"))).toBe(false);

    applyDaemonExtraPath("/opt/x/bin");
    expect(minimalEnv().PATH ?? "").not.toContain("/opt/x/bin");

    applyDaemonExtraPath(["rel/bin", "~/bin", "/usr/bin", "/opt/x/bin", "/opt/x/bin/"]);
    const parts = (minimalEnv().PATH ?? "").split(":");
    expect(parts.filter((p) => p === "/usr/bin")).toHaveLength(1);
    expect(parts.filter((p) => p === "/opt/x/bin")).toHaveLength(1);
    expect(parts.at(-1)).toBe("/opt/x/bin");
    expect(parts.slice(0, -1).join(":")).toBe(computeChildPath());

    const ready = await probeCodex();
    expect(ready.state).toBe("ready");
    expect(ready.ok).toBe(true);
    expect(ready.cli).toBe("found");
    expect(ready.version).toBe("9.9.9");
    expect(JSON.stringify(ready)).not.toContain(TOKEN);
    expect(JSON.stringify(ready)).not.toContain(home);

    const anet = writeFakeAnet(pinRoot);
    _resetAnetBinAbsForTest();
    process.env.ANET_DAEMON_PATH_CONF = join(pinRoot, "missing-path.conf");
    process.env.ANET_DAEMON_ALLOW_ENV_BIN = "1";
    process.env.ANET_BIN_ABS = anet;
    delete process.env.ANET_BIN_SHA256;
    delete process.env.ANET_DAEMON_STRICT_ROOT_BIN;

    let seenPath = "";
    const started: Record<string, unknown>[] = [];
    await handleCreateNodeDoorbell({ request_id: "cr_board648ok" }, doorbell(createDir, started, (_bin, _args, opts) => {
      seenPath = opts.env.PATH ?? "";
      const out = execFileSync("codex", ["--version"], { env: opts.env, encoding: "utf8" });
      expect(out).toContain("9.9.9");
      const child = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
      sleepPid = child.pid ?? 0;
      return child;
    }, 200));
    expect(started.map((a) => a.status)).toEqual(["started"]);
    expect(seenPath).toBe(minimalEnv().PATH);
    expect(seenPath.endsWith(":/opt/x/bin")).toBe(true);
    expect(existsSync(join(createDir, ".anet", "nodes", "demo-node", "config.json"))).toBe(true);
  } finally {
    if (sleepPid > 0) {
      try { process.kill(sleepPid, "SIGKILL"); } catch { /* already gone */ }
    }
    _resetDaemonExtraPathForTest();
    _resetAnetBinAbsForTest();
    restoreEnv();
    try { unlinkSync(CODEX); } catch { /* ok */ }
    rmSync(home, { recursive: true, force: true });
    rmSync(rejectDir, { recursive: true, force: true });
    rmSync(createDir, { recursive: true, force: true });
    rmSync(pinRoot, { recursive: true, force: true });
  }
}, 20_000);

async function probeCodex() {
  const env = minimalEnv() as Record<string, string | undefined>;
  const deps = realReadinessDeps({ childEnv: env, daemonEnv: {}, platform: process.platform });
  deps.httpHead = async () => "reachable";
  const r = await probeRuntimeReadiness(["codex-app-server"], deps, { stepTimeoutMs: 2_000, runtimeDeadlineMs: 5_000 });
  return r["codex-app-server"];
}

function doorbell(
  workDir: string,
  acks: Record<string, unknown>[],
  spawnChild: (bin: string, args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv }) => {
    pid?: number;
    stdin?: { destroy(): void } | null;
    stdout?: { destroy(): void } | null;
    stderr?: { destroy(): void } | null;
    once(event: "exit", cb: (code: number | null, signal: NodeJS.Signals | null) => void): void;
    unref(): void;
  },
  capabilityCheckMs?: number,
) {
  return {
    callCommHub: async (tool: string, args: Record<string, unknown>) => {
      if (tool === "get_create_request") {
        return {
          ok: true,
          node_spec: { name: "demo-node", runtime: "codex-app-server" },
          child_token: "ntok_demo_placeholder",
        };
      }
      if (tool === "ack_create_request") {
        acks.push(args);
        return { ok: true };
      }
      throw new Error(`unexpected tool ${tool}`);
    },
    workDir,
    hubUrl: "http://127.0.0.1:9",
    log: () => {},
    warn: () => {},
    serializeEnvLocal: serializeEnvLocalDaemon,
    spawnChild,
    capabilityCheckMs,
  };
}

function writeFakeAnet(root: string): string {
  const pkg = join(root, "pkg");
  const binDir = join(pkg, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({
    name: "@sleep2agi/agent-network",
    bin: { anet: "bin/anet.cjs" },
  }));
  const abs = join(binDir, "anet.cjs");
  writeFileSync(abs, "#!/usr/bin/env node\n// anet 的 bin 入口垫片\n// PARSE_FLOOR\n");
  chmodSync(abs, 0o755);
  return realpathSync(abs);
}
