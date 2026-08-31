import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { displayWidth } from "./display-width";

// `anet demo` 的清单是**手敲在模板字符串里的空格**。sci-team 是后加的,
// 补齐写成了 4 个空格而其余三项是 8/5/7(名字+空格 = 16),于是它的说明列
// 比别人靠左 4 列。
//
// 判据不看空格数,看**每一行的名字段占多少显示列** —— 那才是用户看到的东西。
// 下一个人加 demo 时补错了空格,这条会红。
//
// 🔴 顺带钉住另一件同处发现的事:这一块原先带着 8 处**缺了 ESC 前缀**的颜色码
// (`[32m` / `[0m` 的纯文本),用户跑 `anet demo` 看到的是字面量乱码而不是绿点。
// 本文件其余地方 0 处真 ANSI 上色 —— 状态一律用 ✅/🔴/● 这类字符,所以修法是**删掉**,
// 不是补 ESC。下面单独一条守着它不再回来。

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");

/** 从 demoListCommand 的模板里取出每一行的「名字 + 其后的空格」宽度。 */
export function demoNameFieldWidths(src: string): { name: string; width: number }[] {
  const start = src.indexOf("Available demos:");
  if (start < 0) throw new Error("找不到 `Available demos:` —— demo 清单被改写了");
  const end = src.indexOf("See 'anet demo", start);
  if (end < 0) throw new Error("找不到清单结尾的 See 'anet demo …'");
  const block = src.slice(start, end);
  const out: { name: string; width: number }[] = [];
  for (const line of block.split("\n")) {
    const m = /●\s+([a-z][a-z-]*)( +)/.exec(line);
    if (!m) continue;
    out.push({ name: m[1]!, width: displayWidth(m[1]!) + m[2]!.length });
  }
  return out;
}

describe("anet demo 清单的名字列", () => {
  const rows = demoNameFieldWidths(CLI);

  it("取集正控:确实解析出了多行(0 行会让下面那条空过)", () => {
    expect(rows.length).toBeGreaterThanOrEqual(4);
    expect(rows.map(r => r.name)).toContain("debate");
    expect(rows.map(r => r.name)).toContain("sci-team");
  });

  it("🔴 每一行的名字列占同样多的显示列 —— 否则说明文字会错位", () => {
    const widths = [...new Set(rows.map(r => r.width))];
    expect(widths).toHaveLength(1);
  });

  it("🔴 清单里不留缺了 ESC 前缀的颜色码 —— 那是用户眼里的乱码", () => {
    const start = CLI.indexOf("Available demos:");
    const end = CLI.indexOf("See 'anet demo", start);
    const block = CLI.slice(start, end);
    expect(block.match(/\[[0-9;]{1,4}m/g) ?? []).toEqual([]);
  });
});
