#!/usr/bin/env python3
"""MCP 工具的「响应键集断言」覆盖率 —— 单位是**工具**，不是 grep 次数。

2026-10-31 —— 起因：一次复核里，两边都拿「grep 命中次数」当覆盖率（34 / 38 / 0/27），
而没人能说清分母是什么。后来定下来：

    单位该是「接受外部形状的端点」，不是「某个函数名出现了几次」。

本脚本把这条落到本仓：
    分子 = 有「精确键集断言」的 MCP 工具
    分母 = 全部 MCP 工具（按 `server.tool("<name>"` 注册处计数）

⚠️ 归因是**启发式**：断言写在测试文件里，靠「同文件里提到该工具名 + 出现精确键集断言」
   来归属，不解析 AST。所以它给的是**下界**，且明确标注为下界 ——
   宁可少报，也不要为了好看把它报成精确值。

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

    test_mentions: dict[str, list[str]] = {}
    for path in tracked(["server/src/*.test.ts"]):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if not EXACT_KEYSET.search(text):
            continue
        for name in tools:
            if re.search(rf"""["']{re.escape(name)}["']""", text):
                test_mentions.setdefault(name, []).append(path.name)

    covered = sorted(test_mentions)
    uncovered = sorted(set(tools) - set(covered))

    if "--json" in sys.argv:
        print(json.dumps({
            "tools_total": len(tools),
            "tools_with_exact_key_set_assertion": len(covered),
            "covered": covered,
            "uncovered": uncovered,
            "attribution": "heuristic: same test file mentions the tool name AND contains an exact key-set assertion (lower bound)",
        }, ensure_ascii=False, indent=1))
        return 0

    print(f"MCP 工具：{len(tools)} 个（分母 = 注册点，不是 grep 次数）")
    print(f"有精确键集断言：{len(covered)} 个（**下界**：按「同文件提及 + 该文件有精确键集断言」归因）")
    if tools:
        print(f"比例：{len(covered)}/{len(tools)} = {len(covered) / len(tools):.1%}")
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
