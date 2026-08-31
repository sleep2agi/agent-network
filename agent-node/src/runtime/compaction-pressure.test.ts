import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { COMPACTION_WARN_RATIO, compactionPressure } from "./compaction-pressure";

const LIMIT = 200_000;

describe("compactionPressure (#1645)", () => {
  test("🔴 实测那次的数:195436/200000 = 98%,必须提醒", () => {
    const p = compactionPressure(195_436, LIMIT);
    expect(p.pct).toBe(98);
    expect(p.warn).toBe(true);
    expect(p.text).toContain("195436/200000");
  });

  test("阈值用边界值校准,不用生产值", () => {
    expect(compactionPressure(LIMIT * COMPACTION_WARN_RATIO, LIMIT).warn).toBe(true);
    expect(compactionPressure(LIMIT * COMPACTION_WARN_RATIO - 1, LIMIT).warn).toBe(false);
  });

  test("未越线时 text 为空串 —— 调用方据此不打印", () => {
    const p = compactionPressure(50_000, LIMIT);
    expect(p.pct).toBe(25);
    expect(p.warn).toBe(false);
    expect(p.text).toBe("");
  });

  test("🔴 上限拿不到时不算百分比 —— 不要拿猜的分母算出一个像样的数", () => {
    for (const badLimit of [0, -1, NaN, undefined, null, "200000"]) {
      const p = compactionPressure(195_436, badLimit as unknown);
      expect(p.pct).toBe(0);
      expect(p.warn).toBe(false);
    }
  });

  test("token 数是坏值时按 0 处理,不抛", () => {
    for (const bad of [-5, NaN, Infinity, undefined, "1000"]) {
      expect(compactionPressure(bad as unknown, LIMIT).warn).toBe(false);
    }
  });

  test("🔴 文案不承诺「一定会失败」", () => {
    const t = compactionPressure(195_436, LIMIT).text;
    expect(t).toContain("可能");
    for (const w of ["一定", "必然", "will fail", "肯定"]) expect(t).not.toContain(w);
  });
});

describe("接线守卫", () => {
  // 剥注释行再断言 —— 源码里既有那个东西,也有关于它的说明。
  const cli = readFileSync(new URL("../cli.ts", import.meta.url), "utf8")
    .split("\n")
    .filter(l => { const c = l.trim(); return !c.startsWith("//") && !c.startsWith("*") && !c.startsWith("/*"); })
    .join("\n");

  test("🔴 打在**成功路径**上 —— 只在失败时说话的仪表警告不了任何人", () => {
    // 成功路径那一行是 `[codex] done | …`;压力提醒必须紧随其后。
    const doneAt = cli.indexOf("[codex] done |");
    const pressureAt = cli.indexOf("compactionPressure(");
    expect(doneAt).toBeGreaterThan(-1);
    expect(pressureAt).toBeGreaterThan(doneAt);
    expect(pressureAt - doneAt).toBeLessThan(400); // 就在它附近,不是文件另一头
  });

  test("用的是我们自己设的那个上限,不是写死的数字", () => {
    expect(cli).toContain("CODEX_CONFIG.model_auto_compact_token_limit");
  });
});
