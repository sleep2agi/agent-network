/* 2026-08-30 —— 这句报错在真机上把人指错了方向。
 *
 * Mac mini,daemon 建的 grok-build-acp 节点,用户收到的原话是
 * 「grok CLI not found. Install Grok Build CLI」——
 * 而那台机器上 grok 就装在官方位置 `~/.grok/bin/grok`。
 * 真因是 daemon 的 PATH 没有它,子节点又继承 daemon 的 PATH。
 */
import { describe, expect, test } from "bun:test";
import { grokPreflightMessage } from "./grok-preflight.js";

const PATH_SAMPLE = "/opt/homebrew/bin:/usr/bin:/bin";

describe("🔴 grok 预检:三种失败必须说成三句不同的话", () => {
  const CASES = [
    { code: "ENOENT" },
    { code: "EACCES" },
    { status: 1, stderr: "boom" },
  ];

  test("三种各说各的", () => {
    const out = CASES.map(c => grokPreflightMessage(c, PATH_SAMPLE));
    expect(new Set(out).size).toBe(CASES.length);
  });

  /* 🔴 本体:找不到 ≠ 没装。修复前这句话是「Install Grok Build CLI」。 */
  test("🔴 ENOENT 明说「不等于没装」,并指向 PATH 而不是重装", () => {
    const s = grokPreflightMessage({ code: "ENOENT" }, PATH_SAMPLE);
    expect(s).toContain("不在 PATH 上");
    /* 断言串里不带 ** 之类的标记符 —— 第一版就是把星号放错了位置而假红。 */
    expect(s.replace(/\*/g, "")).toContain("不等于没装");
    expect(s).not.toContain("Install Grok Build CLI");
    expect(s).toContain("~/.grok/bin");
  });

  /* 🔴 真机上就是这一条把人坑了:在自己 shell 里 export 完全无效。 */
  test("🔴 ENOENT 必须点出 daemon 子节点继承 daemon 的 PATH", () => {
    const s = grokPreflightMessage({ code: "ENOENT" }, PATH_SAMPLE);
    expect(s).toContain("daemon");
    expect(s).toContain("继承");
  });

  /* 「PATH 里没有」不把 PATH 印出来,等于没说。 */
  test("🔴 ENOENT 回显当前 PATH", () => {
    expect(grokPreflightMessage({ code: "ENOENT" }, PATH_SAMPLE)).toContain(PATH_SAMPLE);
  });

  /* 🔴 GROK_BINARY 只有 grok-build-cli 那条路读,ACP 从没读过它。
   * 建议一个本运行时无效的开关 = 把这条报错的毛病换个方向再犯一次。 */
  test("🔴 任何一种都不许建议 GROK_BINARY(ACP 不读它)", () => {
    for (const c of CASES) {
      expect(grokPreflightMessage(c, PATH_SAMPLE)).not.toContain("GROK_BINARY");
    }
  });

  test("EACCES 说的是权限,不是找不到", () => {
    const s = grokPreflightMessage({ code: "EACCES" }, PATH_SAMPLE);
    expect(s).toContain("chmod +x");
    expect(s).not.toContain("不在 PATH 上");
  });

  test("非 ENOENT/EACCES:说清是 grok 自己起不来,并带上它的 stderr", () => {
    const s = grokPreflightMessage({ status: 127, stderr: "libfoo missing" }, PATH_SAMPLE);
    expect(s).toContain("exit 127");
    expect(s).toContain("libfoo missing");
    expect(s).toContain("不是找不到");
  });

  test("🔴 分母自证:确实覆盖了 3 种失败形状", () => {
    expect(CASES.length).toBe(3);
  });
});
