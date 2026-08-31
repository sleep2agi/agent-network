import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { formatAgo, formatHubTime } from "./hub-time-display";

// 实测那一对:名册值 00:20:11 UTC,而 UTC 现在是 00:22:41 —— 2 分钟前。
const RAW = "2026-08-31 00:20:11";
const NOW = Date.UTC(2026, 7, 31, 0, 22, 41);

describe("formatHubTime", () => {
  test("🔴 实测那一对:说的是「分钟前」,不是「8 小时前」", () => {
    // 这条的立论不是某个具体数字,是**量级** —— 一个刚心跳过的节点不该看起来像 8 小时前。
    // (150 秒 → `Math.round(2.5)` = 3 分钟。我第一版把断言写成「2 分钟前」,
    //  是从 shell 的**整除**结果抄的;代码用四舍五入,比截断更诚实。测试抓住了我。)
    const s = formatHubTime(RAW, NOW);
    expect(s).toContain("分钟前");
    expect(s).not.toContain("小时前");
    expect(s).toContain("UTC");
    expect(s).toContain(RAW);
  });

  test("精确值另测,用一个干净的时间对", () => {
    const base = Date.UTC(2026, 7, 31, 0, 20, 11);
    expect(formatHubTime(RAW, base + 120_000)).toContain("2 分钟前");
    expect(formatHubTime(RAW, base + 150_000)).toContain("3 分钟前"); // 2.5 分 → 四舍五入
  });

  test("🔴 必须显式标 UTC —— 不标就会被当成本地时间读", () => {
    // 这条是整个模块的立论。去掉 UTC 标记,同一个串在 UTC+8 的用户眼里差 8 小时。
    expect(formatHubTime(RAW, NOW)).toContain("UTC");
  });

  test("解不出来就原样回显并说明,不编一个合理的时间", () => {
    expect(formatHubTime("不是时间", NOW)).toBe("不是时间（无法解析）");
    expect(formatHubTime("2026-13-45 99:99:99", NOW)).toContain("无法解析");
  });

  test("空/非字符串给 -", () => {
    for (const bad of ["", "   ", undefined, null, 42, {}]) expect(formatHubTime(bad as unknown, NOW)).toBe("-");
  });
});

describe("formatAgo 的档位（边界值校准，不用生产值）", () => {
  test.each([
    [0, "0 秒前"], [59_000, "59 秒前"], [60_000, "1 分钟前"],
    [59 * 60_000, "59 分钟前"], [60 * 60_000, "1 小时前"],
    [47 * 3600_000, "47 小时前"], [48 * 3600_000, "2 天前"],
  ])("%i ms → %s", (ms, want) => expect(formatAgo(ms as number)).toBe(want));

  test("🔴 未来时间如实说「时钟偏差？」,不折成 0 秒前", () => {
    expect(formatAgo(-5_000)).toContain("时钟偏差");
    expect(formatAgo(-5 * 60_000)).toContain("时钟偏差");
  });

  test("坏值不抛", () => {
    expect(formatAgo(NaN)).toBe("时长未知");
    expect(formatAgo(Infinity)).toBe("时长未知");
  });
});

describe("接线守卫", () => {
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8")
    .split("\n")
    .filter(l => { const c = l.trim(); return !c.startsWith("//") && !c.startsWith("*") && !c.startsWith("/*"); })
    .join("\n");

  test("🔴 两处裸打印都换掉了", () => {
    expect(cli).not.toContain("${session.updated_at || \"-\"}");
    expect(cli).not.toContain("${goal.updated_at || \"-\"}");
  });

  test("而且确实调用了 formatHubTime", () => {
    expect((cli.match(/formatHubTime\(/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
