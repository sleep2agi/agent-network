/* #1353 —— daemon 的 anet 二进制 pin:`anet daemon start` 与 `anet node start <daemon>`
 * (开机 sweep 的 `anet project up` 走的就是后者)必须用同一套解析与校验。
 *
 * 缺陷形态:daemon 被 `node start` / `project up` / `node restart` 拉起时从不解析 pin,
 * 起来后在线、注册,却报 can_create_nodes=false —— 每次机器重启(sweep)都会这样。
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  checkDaemonAnetBin, daemonAnetBinEnv, shouldPinDaemonOnNodeStart,
} from "./daemon-anet-bin.js";

let root = "";
function fakeAnetPackage(name: string, opts: { mode?: number; pkgName?: string } = {}) {
  const dir = join(root, name);
  mkdirSync(join(dir, "dist", "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: opts.pkgName ?? "@sleep2agi/agent-network",
    bin: { anet: "dist/bin/anet.cjs" },
  }));
  const bin = join(dir, "dist", "bin", "anet.cjs");
  writeFileSync(bin, "#!/usr/bin/env node\n");
  chmodSync(bin, opts.mode ?? 0o755);
  const argv1 = join(dir, "dist", "bin", "cli.js"); // anet.cjs rewrites argv[1] to cli.js
  writeFileSync(argv1, "");
  return { bin: realpathSync(bin), argv1 };
}

beforeAll(() => { root = mkdtempSync(join(tmpdir(), "anet-daemon-bin-1353-")); });
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe("#1353 checkDaemonAnetBin —— 与 `anet daemon start` 同一套规则,非致命返回", () => {
  test("无 env、从 argv[1] 旁自解析 ⇒ ok,pin 指向包的 anet.cjs,env 三键齐", () => {
    const pkg = fakeAnetPackage("ok");
    const r = checkDaemonAnetBin({ argv1: pkg.argv1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bin).toBe(pkg.bin);
    expect(daemonAnetBinEnv(r.bin)).toEqual({
      ANET_BIN_ABS: pkg.bin,
      ANET_DAEMON_ALLOW_ENV_BIN: "1",
      ANET_DAEMON_ALLOW_NON_ROOT_BIN: "1",
    });
  });

  test("🔴 二进制组/他人可写(umask 0002 装出的 775)⇒ 拒绝,并给出 chmod go-w 修法", () => {
    const pkg = fakeAnetPackage("writable", { mode: 0o775 });
    const r = checkDaemonAnetBin({ argv1: pkg.argv1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.lines.join("\n")).toContain("group/other writable (mode=775)");
    expect(r.lines.join("\n")).toContain("chmod go-w");
  });

  test("🔴 不是 anet 包(包名不对)⇒ 拒绝:身份检查仍在,信任根没有放宽", () => {
    const pkg = fakeAnetPackage("impostor", { pkgName: "not-anet" });
    const r = checkDaemonAnetBin({ argv1: pkg.argv1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.lines[0]).toContain("is not an anet package bin");
  });

  test("argv[1] 旁没有 anet.cjs、也没有 env ⇒ 拒绝,并给出重装修法", () => {
    const r = checkDaemonAnetBin({ argv1: join(root, "nowhere", "cli.js") });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.lines[0]).toContain("no self-resolved anet package bin");
    expect(r.lines[0]).toContain("npm i -g @sleep2agi/agent-network@latest");
  });
});

describe("#1353 shouldPinDaemonOnNodeStart —— 只给 daemon、只在还没解析过时", () => {
  test("host_supervisor 且本进程未解析 ⇒ 要解析", () => {
    expect(shouldPinDaemonOnNodeStart({ role: "host_supervisor", alreadyPrepared: false })).toBe(true);
  });
  test("已由 `anet daemon start` 解析过 ⇒ 不重复", () => {
    expect(shouldPinDaemonOnNodeStart({ role: "host_supervisor", alreadyPrepared: true })).toBe(false);
  });
  test("普通节点(无 role / worker / leader)⇒ 从不碰 pin", () => {
    for (const role of [undefined, "worker", "leader", "member"]) {
      expect(shouldPinDaemonOnNodeStart({ role, alreadyPrepared: false })).toBe(false);
    }
  });
});

describe("#1353 接线契约 —— 每一种拉起 daemon 的路径都经过同一个检查", () => {
  const cli = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");

  test("startCommand 在解析出节点后、spawn 之前调用 pinDaemonAnetBinForNodeStart", () => {
    const start = cli.indexOf("async function startCommand()");
    const resolveAt = cli.indexOf("const resolvedForCopresence = resolveNodeRef(id);", start);
    const pinAt = cli.indexOf("pinDaemonAnetBinForNodeStart(id,", start);
    const end = cli.indexOf("\nasync function ", start + 10);
    const firstSpawnAt = cli.indexOf("spawn(", start);
    expect(start).toBeGreaterThan(0);
    expect(resolveAt).toBeGreaterThan(start);
    expect(pinAt).toBeGreaterThan(resolveAt);
    // inside startCommand, and before anything in it spawns a child (the #1353
    // env passthrough copies process.env into the child env at spawn time)
    expect(pinAt).toBeLessThan(end);
    expect(pinAt).toBeLessThan(firstSpawnAt);
  });

  test("`anet project up`(开机 sweep)用 `anet node start <alias>` 起节点 ⇒ 走 startCommand", () => {
    const fn = cli.slice(cli.indexOf("function startNodeTmuxSession("), cli.indexOf("function tmuxSessionRunning("));
    expect(fn).toContain("anet node start ${shellQuote(alias)}");
  });

  test("两条入口共用 checkDaemonAnetBin,旧的内联解析已删除(不会有第二套规则)", () => {
    expect(cli).toContain("function prepareDaemonAnetBin(): void {");
    expect(cli).toContain("function pinDaemonAnetBinForNodeStart(");
    expect((cli.match(/checkDaemonAnetBin\(\{ envBin: process\.env\.ANET_BIN_ABS, argv1: process\.argv\[1\] \}\)/g) || []).length).toBe(2);
    expect(cli).not.toContain("function resolveCurrentAnetBinForDaemon(");
    expect(cli).not.toContain("function verifyDaemonAnetBinIdentity(");
  });

  test("node start 路径失败不退出(daemon 照常起来,由 hub 侧看到 blocked);daemon start 路径仍退出", () => {
    const pin = cli.slice(cli.indexOf("function pinDaemonAnetBinForNodeStart("), cli.indexOf("async function daemonCommand()"));
    const prep = cli.slice(cli.indexOf("function prepareDaemonAnetBin(): void {"), cli.indexOf("function pinDaemonAnetBinForNodeStart("));
    expect(pin).not.toContain("process.exit");
    expect(pin).toContain("cannot create nodes");
    expect(prep).toContain("process.exit(1)");
  });
});
