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

// ── anet status / anet tasks 的 STATUS 列 ──
// 这一列的值域在 server/ 里(另一个包),CLI import 不到,所以宽度从**要打印的那批行**算。
import { columnWidth } from "./ls-columns";
import { readFileSync as readCli } from "node:fs";
import { join as joinCli } from "node:path";

describe("STATUS 列宽", () => {
  it("🔴 'delivered' 是 9 —— 写死的 8 装不下它,这正是表歪掉的原因", () => {
    expect(columnWidth(["delivered"], "STATUS")).toBe(9);
    expect(columnWidth(["running", "replied"], "STATUS")).toBe(7);  // 都比表头短 → 取表头
  });

  it("值域将来变长也跟得上(不是又写死一个 9)", () => {
    expect(columnWidth(["in_progress"], "STATUS")).toBe(11);
  });

  it("空行集时至少留得下表头", () => {
    expect(columnWidth([], "STATUS")).toBe(6);
  });

  it("非字符串项跳过,不把列撑坏", () => {
    expect(columnWidth([null, undefined, 42, "delivered"] as any, "STATUS")).toBe(9);
  });
});

describe("接线:两张表不再各写各的表头字面量", () => {
  const cli = readCli(joinCli(import.meta.dir, "..", "bin", "cli.ts"), "utf-8")
    .split("\n").filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

  it("写死的 STATUS 表头字面量一个都不剩", () => {
    const literals = [...cli.matchAll(/console\.log\("  STATUS {2,}FROM[^"]*"\)/g)];
    expect(literals.map(m => m[0])).toEqual([]);
  });

  it("正控:确实接上了 —— 两张表各自算 stW", () => {
    expect((cli.match(/const stW = columnWidth\(/g) || []).length).toBe(2);
  });

  it("🔴 每一处 status 数据行都用 stW —— 不能有任何一处还写死宽度", () => {
    // 第一版这里写的是 `.padEnd(stW) 至少 2 次`,而它实际有 4 次(2 表头 + 2 数据行),
    // 退回一处还剩 3 仍然过 —— 判据太松,朝「没问题」错。改成直接盯 status 那个表达式。
    const statusPads = [...cli.matchAll(/\(t\.status \|\| "\?"\)\.padEnd\((\w+)\)/g)].map(m => m[1]);
    expect(statusPads.length).toBe(2);
    expect(statusPads).toEqual(["stW", "stW"]);
  });
});
