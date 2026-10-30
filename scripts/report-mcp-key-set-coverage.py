#!/usr/bin/env python3
"""MCP 工具的「响应键集断言」覆盖率 —— 单位是**工具**，不是 grep 次数。

2026-10-31 —— 起因：一次复核里，两边都拿「grep 命中次数」当覆盖率（34 / 38 / 0/27），
而没人能说清分母是什么。后来定下来：

    单位该是「接受外部形状的端点」，不是「某个函数名出现了几次」。

本脚本把这条落到本仓：
    分子 = 有「精确键集断言」的 MCP 工具
    分母 = 全部 MCP 工具（按 `server.tool("<name>"` 注册处计数）

⚠️ 归因是**启发式**，而且**误差方向未知** —— 这一点比「是下界」重要得多：
   · 可能少算：间接断言、运行期生成、共享测试助手都不认
   · 也可能多算：同一个测试文件里提到该工具名、而精确键集断言是为**别的**工具写的
⇒ 所以这里**故意给两个口径**并排印：
     文件级（宽）  ：文件里提到工具名 + 文件里有精确键集断言
     邻近级（严）  ：工具名与该断言相距 ≤ WINDOW 行
⇒ 两个数之间的差额，就是「文件级代理的误报面」。
   只印一个数，读的人会以为它是精确值；印两个，差额自己会说话。

用法：python3 scripts/report-mcp-key-set-coverage.py [--json]
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TOOL_DEF = re.compile(r"""server\.tool\(\s*"([a-z0-9_]+)\"""")
EXACT_KEYSET = re.compile(r"Object\.keys\([^)]*\)\.sort\(\)\)\.toEqual\(\[")
WINDOW = 30  # 邻近级口径：工具名与断言之间允许的最大行距


def tracked(patterns: list[str]) -> list[Path]:
    out = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", *patterns],
        capture_output=True, text=True,
    ).stdout.split()
    return [REPO / p for p in out if p.endswith(".ts")]


def main() -> int:
    tools: dict[str, Path] = {}
    for path in tracked(["server/src/*.ts"]):
        if path.name.endswith(".test.ts"):
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for name in TOOL_DEF.findall(text):
            tools.setdefault(name, path)

    file_level: dict[str, list[str]] = {}
    near_level: dict[str, list[str]] = {}
    for path in tracked(["server/src/*.test.ts"]):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        lines = text.splitlines()
        assert_lines = [i for i, ln in enumerate(lines) if EXACT_KEYSET.search(ln)]
        if not assert_lines:
            continue
        for name in tools:
            hits = [i for i, ln in enumerate(lines) if re.search(rf"""["']{re.escape(name)}["']""", ln)]
            if not hits:
                continue
            file_level.setdefault(name, []).append(path.name)
            if any(abs(a - h) <= WINDOW for a in assert_lines for h in hits):
                near_level.setdefault(name, []).append(path.name)

    covered = sorted(file_level)
    uncovered = sorted(set(tools) - set(covered))

    near = sorted(near_level)
    if "--json" in sys.argv:
        print(json.dumps({
            "tools_total": len(tools),
            "covered_file_level": len(covered),
            "covered_near_level": len(near),
            "evidence_class": "proxy; error direction unknown (can both under- and over-count)",
            "near_names": near,
            "uncovered": uncovered,
        }, ensure_ascii=False, indent=1))
        return 0

    print(f"MCP 工具：{len(tools)} 个（分母 = 注册点，不是 grep 次数）")
    print(f"文件级（宽）：{len(covered)} 个 ⇒ 比例 {len(covered)}/{len(tools)} = {len(covered) / max(len(tools), 1):.1%}")
    print(f"邻近级（严，≤{WINDOW} 行）：{len(near)} 个 ⇒ 比例 {len(near)}/{len(tools)} = {len(near) / max(len(tools), 1):.1%}")
    print(f"⇒ 两个数之差 {len(covered) - len(near)} 就是「文件级代理的误报面」。")
    print("⚠️ 这不是下界：多算与少算都可能发生，所以**误差方向未知**，只能当代理读。")
    if covered:
        print("\n已覆盖：")
        for name in covered:
            print(f"  {name}  ← {', '.join(test_mentions[name])}")
    if uncovered:
        print(f"\n未覆盖（{len(uncovered)}）：")
        for name in uncovered:
            print(f"  {name}  ({tools[name].relative_to(REPO)})")
    print("\n⚠️ 这是启发式下界：解析器只认「工具名出现在含精确键集断言的测试文件里」，")
    print("   不认间接断言、不认运行期生成的键集、不认跨文件共享的测试助手。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
