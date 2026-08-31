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

  it("🔴 消息里那条 shell 必须真能跑 —— 验的是消息本身,不是源码里的字符串", () => {
    const msg = messageFor({ ANET_DAEMON_PATH_CONF: "/nonexistent-xyz-1635" });
    const m = /no sudo\): ([\s\S]*?) \(put ANET_DAEMON_PATH_CONF/.exec(msg);
    expect(m).not.toBeNull();
    const cmd = m![1];
    expect(cmd.length).toBeGreaterThan(80);
    // bash -n:只查语法,不执行
    expect(() => execFileSync("bash", ["-n", "-c", cmd], { stdio: "pipe" })).not.toThrow();
  });

  it("另一条 reason(设了 ANET_BIN_ABS 但没开 ALLOW_ENV_BIN)也给同一条免 root 路", () => {
    const msg = messageFor({ ANET_BIN_ABS: "/tmp/whatever", ANET_DAEMON_PATH_CONF: "/nonexistent-xyz-1635" });
    expect(msg).toContain("no /etc, no sudo");
  });
});
