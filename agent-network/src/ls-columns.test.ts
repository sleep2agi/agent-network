import { describe, expect, it } from "bun:test";
import { SUPPORTED_RUNTIME_NAMES } from "./normalize-runtime";
import { displayWidth } from "./display-width";
import { lsHeaderRow, lsSeparatorRow, runtimeColumnWidth } from "./ls-columns";

describe("anet node ls 的 RUNTIME 列宽", () => {
  it("宽到装得下**每一个**受支持的 runtime —— 这是本条的立论", () => {
    const w = runtimeColumnWidth(SUPPORTED_RUNTIME_NAMES);
    for (const n of SUPPORTED_RUNTIME_NAMES) {
      expect(displayWidth(n)).toBeLessThanOrEqual(w);
    }
  });

  it("正控：真源里确实有比原先写死的 14 更长的名字（否则上一条会空过）", () => {
    const longest = Math.max(...SUPPORTED_RUNTIME_NAMES.map(displayWidth));
    expect(longest).toBeGreaterThan(14);   // claude-agent-sdk / codex-app-server = 16
    expect(SUPPORTED_RUNTIME_NAMES.length).toBeGreaterThanOrEqual(5);
  });

  it("至少留得下表头本身", () => {
    expect(runtimeColumnWidth([])).toBe(displayWidth("RUNTIME"));
    expect(runtimeColumnWidth(["ab"])).toBe(displayWidth("RUNTIME"));
  });

  it("表头与分隔线由同一个宽度生成,逐列对齐", () => {
    const w = runtimeColumnWidth(SUPPORTED_RUNTIME_NAMES);
    const head = lsHeaderRow(w);
    const sep = lsSeparatorRow(w);
    const starts = (s: string) => {
      const out: number[] = []; let i = 0, col = 0;
      while (i < s.length) {
        if (s[i] !== " ") { out.push(col); while (i < s.length && s[i] !== " ") { col += displayWidth(s[i]!); i++; } }
        else { col++; i++; }
      }
      return out;
    };
    expect(starts(sep)).toEqual(starts(head));
  });

  it("非字符串项被跳过,宽度仍由真实名字决定(不是被撑大也不是塌回表头)", () => {
    // codex-sdk = 9 > "RUNTIME" = 7,所以正确答案是 9。
    // (第一版我把它写成 7,红的是期望值不是代码。)
    expect(runtimeColumnWidth(["codex-sdk", null as any, undefined as any])).toBe(9);
  });
});
