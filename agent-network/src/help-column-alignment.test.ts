import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `anet` 的帮助文本是手写模板字面量 + 手数空格。实测(2026-08-31)：11 段里 4 段
// **段内**描述起始列不一致 —— 例如 Session 段主列 41，而 `anet session ls` 在 32，差 9 列。
//
// 🔴 这条测试钉的是「**段内**一致」，不是「全局一致」：不同段本来就可以有不同列宽
//    （段内最长命令不同）。我第一次把所有段混在一起数，得出一个看起来很严重但
//    没有意义的数字 —— 分组错了，判据再对也没用。
//
// 判据对着**源码里的帮助模板**，而不是对着运行输出：这样它在 CI 里不需要起进程。

const CLI = readFileSync(join(import.meta.dir, "..", "bin", "cli.ts"), "utf-8");

type Row = { section: string; col: number; cmd: string };

function helpRows(src: string): Row[] {
  const out: Row[] = [];
  let section = "";
  for (const raw of src.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^[A-Z][A-Za-z /&]*:$/.test(line.trim())) { section = line.trim(); continue; }
    const m = /^(  anet [^\s].*?)(\s{2,})(\S.*)$/.exec(line);
    if (m && section) out.push({ section, col: m[1].length + m[2].length, cmd: m[1].trim() });
  }
  return out;
}

describe("anet 帮助文本的列对齐", () => {
  const rows = helpRows(CLI);

  it("🔴 取集自检：确实抓到了帮助行（否则下面的断言恒真）", () => {
    expect(rows.length).toBeGreaterThan(40);
    expect(new Set(rows.map(r => r.section)).size).toBeGreaterThan(3);
  });

  it("🔴 每一段内部，描述的起始列必须一致", () => {
    const bySection = new Map<string, Row[]>();
    for (const r of rows) {
      if (!bySection.has(r.section)) bySection.set(r.section, []);
      bySection.get(r.section)!.push(r);
    }
    const offenders: string[] = [];
    for (const [section, group] of bySection) {
      const cols = new Set(group.map(r => r.col));
      if (cols.size > 1) {
        const counts = [...cols].map(c => `${c}×${group.filter(r => r.col === c).length}`).join(" ");
        offenders.push(`${section} → ${counts}（例：${group.find(r => r.col !== group[0].col)?.cmd}）`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("描述与命令之间至少留两个空格", () => {
    for (const r of rows) expect(r.col).toBeGreaterThan(r.cmd.length + 2);
  });
});
