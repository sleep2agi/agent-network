import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { formatHubVersionDetail } from "./hub-version-skew";

const HUB = "http://127.0.0.1:9200";
const PIN = "0.9.0-preview.44";

describe("formatHubVersionDetail (#1595)", () => {
  test("一致时不多说一句", () => {
    expect(formatHubVersionDetail(HUB, PIN, PIN)).toBe(`${HUB} v${PIN}`);
  });

  test("🔴 不一致时必须把 pin 也摆出来 —— 今天实测的那一对", () => {
    const s = formatHubVersionDetail(HUB, "0.9.0-preview.38", PIN);
    expect(s).toContain("v0.9.0-preview.38");
    expect(s).toContain(PIN);
  });

  test("hub 比 pin 新也要说 —— 不是只报「旧」", () => {
    // 判据是「不一致」,不是「更旧」。故意钉在旧版是合理用法。
    expect(formatHubVersionDetail(HUB, "0.9.0-preview.99", PIN)).toContain(PIN);
  });

  test("拿不到版本时显示 ? 并仍摆出 pin", () => {
    for (const bad of [undefined, null, "", "   ", 42, {}]) {
      const s = formatHubVersionDetail(HUB, bad as unknown, PIN);
      expect(s).toContain("v?");
      expect(s).toContain(PIN);
    }
  });

  test("🔴 不发警告、不给判定 —— 只有事实", () => {
    const s = formatHubVersionDetail(HUB, "0.9.0-preview.38", PIN);
    for (const word of ["警告", "过期", "应当", "必须", "不匹配", "mismatch", "outdated"]) {
      expect(s).not.toContain(word);
    }
  });

  test("空白被裁掉,不产生 v  的双空格", () => {
    expect(formatHubVersionDetail(HUB, "  0.9.0-preview.38  ", PIN)).toContain("v0.9.0-preview.38；");
  });
});

describe("接线守卫", () => {
  // 剥掉注释行 —— 源码里既有那个东西,也有关于它的说明。
  const cli = readFileSync(new URL("../bin/cli.ts", import.meta.url), "utf8")
    .split("\n")
    .filter(l => { const c = l.trim(); return !c.startsWith("//") && !c.startsWith("*") && !c.startsWith("/*"); })
    .join("\n");

  test("doctor 的 CommHub reachable 用了这个函数", () => {
    expect(cli).toContain("formatHubVersionDetail(gc.hub");
  });

  test("🔴 旧的裸拼接不再存在 —— 「用了新函数」也可能是两处并存", () => {
    expect(cli).not.toContain("`${gc.hub} v${health.version || \"?\"}`");
  });
});
