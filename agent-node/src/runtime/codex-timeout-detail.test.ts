import { describe, expect, test } from "bun:test";
import { codexTimeoutDetail } from "./codex-timeout-detail";

describe("codexTimeoutDetail (#1645)", () => {
  test("0 事件 → 指向连接/握手层", () => {
    // 这就是 2026-08-31 实测那次:rmcp worker 因 `unknown variant \`max\`` 致命退出,
    // 一个事件都没流出来。
    expect(codexTimeoutDetail(0, 0)).toBe("期间 0 个事件(连接/握手层就没通)");
  });

  test("有事件 → 指向 turn 自己,并带上停了多久", () => {
    expect(codexTimeoutDetail(12, 287_000)).toBe("期间 12 个事件,最后一个在 287s 前(turn 中途停住)");
  });

  test("两种情形必须给出**不同**的字符串 —— 否则这个函数没有存在意义", () => {
    expect(codexTimeoutDetail(0, 0)).not.toBe(codexTimeoutDetail(12, 287_000));
  });

  test("🔴 不再提 OPENAI_BASE_URL / vendor 负载 —— 实测中它们没被牵涉", () => {
    for (const s of [codexTimeoutDetail(0, 0), codexTimeoutDetail(5, 1_000)]) {
      expect(s).not.toContain("OPENAI_BASE_URL");
      expect(s).not.toContain("vendor");
    }
  });

  test("1 个事件也走「有事件」那支(边界,不是生产值)", () => {
    expect(codexTimeoutDetail(1, 999)).toContain("1 个事件");
    expect(codexTimeoutDetail(1, 999)).toContain("turn 中途停住");
  });
});
