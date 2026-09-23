// #1353 —— daemon 的 anet 二进制 pin:解析 + 校验,集中在一处。
//
// 这段逻辑原来只在 `anet daemon start/up/init/restart` 的入口
// (`prepareDaemonAnetBin()`)里跑。而 daemon 在**别的起法**下也会被拉起:
//
//   - 开机 sweep(deploy/fleet/anet-nodes-boot.sh)用 `anet project up`,
//     它对每个节点起一个 tmux 会话跑 `anet node start <alias>`;
//   - 人手一句 `anet node start <daemon>` / `anet node restart <daemon>`。
//
// 这些路径都不经过 `prepareDaemonAnetBin()`,于是 daemon 起来了、注册了、在线了,
// 却没有 `ANET_BIN_ABS` —— #1353 的「重启就丢建节点能力」在今天的 main 上
// 就剩这一种形态(daemon start 自己每次都会重新自解析,不会丢)。
//
// 🔴 为什么**不**把 pin 持久化进 daemon 自己的节点目录:issue 评论已论证过,
//    pin 决定 daemon 执行哪个二进制,落在 daemon 用户可写的文件里 = 信任根
//    可被该用户重定向,后面的 symlink / mode / 身份检查就只剩形状检查。
//    这里的做法不存任何状态:**每次启动都按同一套规则从正在运行的 anet 包
//    自解析一次**,和 `anet daemon start` 完全相同,信任根不变。
//
// 失败时 `node start` 路径**不退出**:daemon 照常起来,由 agent-node 按
// #1371/#1377 把 `can_create_nodes=false` + 类别码上报 hub,hub 在派发前拦下
// (#1510),Dashboard 置灰(#1511)。这里只负责在启动那一刻打出一行修法。

import { existsSync, readFileSync, realpathSync, statSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }

export function daemonAnetBinRepairCommand(reason: string, target?: string): string {
  if (reason === "missing") {
    return "npm i -g @sleep2agi/agent-network@latest && anet daemon up";
  }
  if (reason === "relative") {
    return "ANET_BIN_ABS=$(node -e \"console.log(require('fs').realpathSync(process.argv[1]))\" $(command -v anet)) anet daemon up";
  }
  if (reason === "symlink" && target) {
    return `ANET_BIN_ABS=${shellQuote(target)} anet daemon up`;
  }
  if (reason === "writable" && target) {
    return `chmod go-w ${shellQuote(target)} && anet daemon up`;
  }
  if (reason === "not-executable" && target) {
    return `chmod +x ${shellQuote(target)} && anet daemon up`;
  }
  return "anet daemon up";
}

function findPackageJsonDirForDaemonBin(start: string): string | null {
  let dir = dirname(start);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function verifyDaemonAnetBinIdentity(abs: string): void {
  const pkgDir = findPackageJsonDirForDaemonBin(abs);
  if (!pkgDir) {
    throw new Error(`ANET_BIN_ABS is not an anet package bin: no package.json above ${abs}. Run: unset ANET_BIN_ABS && anet daemon up`);
  }
  let pkg: any;
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
  } catch (e: any) {
    throw new Error(`ANET_BIN_ABS is not an anet package bin: cannot read package.json (${e?.message || e}). Run: npm i -g @sleep2agi/agent-network@latest`);
  }
  if (pkg?.name !== "@sleep2agi/agent-network") {
    throw new Error(`ANET_BIN_ABS is not an anet package bin: package name is ${JSON.stringify(pkg?.name)}. Run: unset ANET_BIN_ABS && anet daemon up`);
  }

  const binRel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.anet;
  if (binRel) {
    try {
      if (realpathSync(resolve(pkgDir, binRel)) === abs) return;
    } catch { /* fall through to shim marker check */ }
  }

  // Source-tree/dev fallback: bin/anet.cjs is copied verbatim to dist/bin/anet.cjs
  // at build time, but package.json points at the dist path.
  const body = readFileSync(abs, "utf-8");
  if (abs.endsWith("/anet.cjs") && body.includes("anet 的 bin 入口垫片") && body.includes("PARSE_FLOOR")) return;

  throw new Error(`ANET_BIN_ABS is not an anet package bin: package.json bin.anet does not point at ${abs}. Run: unset ANET_BIN_ABS && anet daemon up`);
}

export function resolveCurrentAnetBinForDaemon(input: { envBin?: string; argv1?: string }): string {
  const fromEnv = input.envBin;
  const argvEntry = input.argv1;
  const packageBin = argvEntry ? join(dirname(argvEntry), "anet.cjs") : "";
  // bin/anet.cjs intentionally rewrites argv[1] to dist/bin/cli.js before
  // importing this file. The daemon must pin the package bin shim itself
  // (the executable named by package.json), not the ESM implementation file.
  const candidate = fromEnv || (packageBin && existsSync(packageBin) ? packageBin : "");
  if (!candidate) {
    throw new Error(`no self-resolved anet package bin found next to ${argvEntry || "(missing argv[1])"}. Run: ${daemonAnetBinRepairCommand("missing")}`);
  }
  if (!isAbsolute(candidate)) {
    throw new Error(`${fromEnv ? "ANET_BIN_ABS" : "self-resolved anet binary"} is not absolute: ${candidate}. Run: ${fromEnv ? "unset ANET_BIN_ABS && anet daemon up" : daemonAnetBinRepairCommand("relative")}`);
  }
  let real: string;
  try {
    real = realpathSync(candidate);
  } catch (e: any) {
    throw new Error(`cannot resolve anet binary ${candidate}: ${e?.message || e}. Run: ${daemonAnetBinRepairCommand("missing")}`);
  }
  if (fromEnv && real !== fromEnv) {
    throw new Error(`ANET_BIN_ABS points at a symlink: ${fromEnv} -> ${real}. Run: ${daemonAnetBinRepairCommand("symlink", real)}`);
  }
  verifyDaemonAnetBinIdentity(real);
  return real;
}

export type DaemonAnetBinCheck =
  | { ok: true; bin: string; notes: string[] }
  | { ok: false; code: "resolve" | "writable" | "not-executable"; lines: string[] };

/** Non-fatal resolve + verify: the exact checks `anet daemon start` applies,
 *  returned instead of `process.exit`. `prepareDaemonAnetBin()` exits on
 *  `ok:false`; the `anet node start <daemon>` path logs and continues. */
export function checkDaemonAnetBin(input: { envBin?: string; argv1?: string }): DaemonAnetBinCheck {
  let anetBin: string;
  try {
    anetBin = resolveCurrentAnetBinForDaemon(input);
  } catch (e: any) {
    return { ok: false, code: "resolve", lines: [String(e?.message || e)] };
  }
  const st = statSync(anetBin);
  if ((st.mode & 0o022) !== 0) {
    const before = (st.mode & 0o777).toString(8);
    return {
      ok: false,
      code: "writable",
      lines: [
        `anet binary is group/other writable (mode=${before}); daemon requires a non-writable binary.`,
        `Run this once, then retry:`,
        `  ${daemonAnetBinRepairCommand("writable", anetBin)}`,
      ],
    };
  }
  if ((st.mode & 0o111) === 0) {
    return {
      ok: false,
      code: "not-executable",
      lines: [
        `anet binary is not executable: ${anetBin}`,
        `Run: ${daemonAnetBinRepairCommand("not-executable", anetBin)}`,
      ],
    };
  }
  const notes: string[] = [];
  if (st.uid !== 0) {
    notes.push(`anet binary is owned by uid=${st.uid}; accepting it as a user-managed nvm/homebrew/npm install.`);
  }
  return { ok: true, bin: anetBin, notes };
}

/** The env the daemon (and, via the #1353 passthrough, its spawned agent-node)
 *  needs once the pin is verified. Same three keys `prepareDaemonAnetBin()` set. */
export function daemonAnetBinEnv(bin: string): Record<string, string> {
  return {
    ANET_BIN_ABS: bin,
    ANET_DAEMON_ALLOW_ENV_BIN: "1",
    ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
  };
}

/** Should `anet node start` resolve a pin for this profile?
 *  Only for daemons (role=host_supervisor), and only when the `anet daemon …`
 *  entry has not already done it in this process (it sets the env). */
export function shouldPinDaemonOnNodeStart(input: { role?: string; alreadyPrepared: boolean }): boolean {
  return input.role === "host_supervisor" && !input.alreadyPrepared;
}
