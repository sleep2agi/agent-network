import { describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { loadAndVerifyAnetBin } from "./create-node-daemon";

// #1635 —— `anet_bin_source` 的报错原先只给出**需要 root** 的那条修法,
// 而 `ANET_DAEMON_PATH_CONF` 这条免 root、活得过重启的路一直在代码里
// (`confPath = env.ANET_DAEMON_PATH_CONF || trustRoot`),却从没出现在任何
// 面向用户的文案里。
//
// 🔴 第二条是跑出来才看见的,issue 里没有:读的是 `confPath`,报的却是
// `trustRoot` —— 用户一旦设了这个变量,报错会把他指向一个**从没被读过**的文件。

function messageFor(env: Record<string, string>): string {
  try {
    loadAndVerifyAnetBin(env as any, "linux");
  } catch (e: any) {
    return String(e?.message || e);
  }
  throw new Error("期待抛出 anet_bin_unsafe_path,但它没抛");
}

describe("#1635 anet_bin_source 的报错", () => {
  it("点名的是它真读的那个文件,不是默认值", () => {
    const msg = messageFor({ ANET_DAEMON_PATH_CONF: "/nonexistent-xyz-1635" });
    expect(msg).toContain("/nonexistent-xyz-1635");
    // 🔴 反向见证:修之前这里是默认值。没有这一条,把 confPath 写回 trustRoot 也照样绿。
    expect(msg).not.toContain("resolved from /etc/anet-daemon/path.conf");
  });

  it("给出免 root 的那条路", () => {
    const msg = messageFor({ ANET_DAEMON_PATH_CONF: "/nonexistent-xyz-1635" });
    expect(msg).toContain("ANET_DAEMON_PATH_CONF");
    expect(msg).toContain("no /etc, no sudo");
  });

  // 🔴 2026-08-31:这一条原本切的是「no sudo): … (put ANET_DAEMON_PATH_CONF」之间那一小段,
  //    也就是**只验我新加的那半句**。于是当我把说明文字直接拼在命令后面之后
  //    (`(no /etc, no sudo)` 里的括号不配对),**整条 Fix 从 bash -n rc=0 变成 rc=2,
  //    而这条测试照样绿** —— 它的提取形状结构上观察不到自己要防的缺陷。
  //    用户复制的是整条 `Fix:` 尾巴,所以判据必须是整条。
  it("🔴 整条 Fix 都必须是合法 shell —— 用户复制的是整条,不是其中一段", () => {
    const msg = messageFor({ ANET_DAEMON_PATH_CONF: "/nonexistent-xyz-1635" });
    const i = msg.indexOf("Fix: ");
    expect(i).toBeGreaterThan(-1);
    const whole = msg.slice(i + "Fix: ".length);
    expect(whole.length).toBeGreaterThan(200);
    // bash -n:只查语法,不执行
    expect(() => execFileSync("bash", ["-n", "-c", whole], { stdio: "pipe" })).not.toThrow();
  });

  // 保留原来的子串断言:它管的是**免 root 那条命令本身**能不能单独粘贴跑。
  // 两层各管各的 —— 整条合法 ≠ 其中那条免 root 的命令还在。
  it("免 root 那条命令单独拿出来也必须能跑", () => {
    const msg = messageFor({ ANET_DAEMON_PATH_CONF: "/nonexistent-xyz-1635" });
    const m = /so it survives a restart:\n([\s\S]*)$/.exec(msg);
    expect(m).not.toBeNull();
    const cmd = m![1].trim();
    expect(cmd.length).toBeGreaterThan(80);
    expect(cmd).toContain("ANET_DAEMON_PATH_CONF=");
    expect(() => execFileSync("bash", ["-n", "-c", cmd], { stdio: "pipe" })).not.toThrow();
  });

  // 🔴 正控:证明上面那条整条断言真的能红。把一段不配对的括号塞进去,必须被 bash -n 拒。
  it("正控 —— 括号不配对的说明文字拼进命令后,bash -n 必须拒", () => {
    const bad = 'echo ok (no /etc, no sudo): echo more';
    expect(() => execFileSync("bash", ["-n", "-c", bad], { stdio: "pipe" })).toThrow();
  });

  it("另一条 reason(设了 ANET_BIN_ABS 但没开 ALLOW_ENV_BIN)也给同一条免 root 路", () => {
    const msg = messageFor({ ANET_BIN_ABS: "/tmp/whatever", ANET_DAEMON_PATH_CONF: "/nonexistent-xyz-1635" });
    expect(msg).toContain("no /etc, no sudo");
  });
});
