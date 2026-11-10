#!/usr/bin/env python3
"""表驱动测试的「遍历 0 个对象也是通过」检查（报告用，不阻塞）。

2026-10-31 —— 起因（一次外部复核的原话）：
    那条断言已经在这个仓里了，而且是绿的。
    它绿的原因不是对象不在，是对象被换成了合成上游 —— 合成品永远不会漂移。
    顺带提醒给 cases 数组加 `assert.equal(cases.length, 5)`：
    **遍历 0 个对象也是通过。**

本仓同类：`for (const x of SOME_TABLE)` —— 若 SOME_TABLE 是**从 src 导入的生产常量**，
它退化/被清空时，测试会安静地通过（0 次迭代），而它看起来「覆盖了整张表」。

口径（刻意保守）：
  只看**本文件里没有定义**的常量（即像是 import 来的），因为本地字面量表清空会写在 diff 里，
  而导入的常量被清空时，读测试的人看不见。
  且文件里没有任何 `NAME.length` 断言。

用法：python3 scripts/report-table-driven-nonempty.py [--json]
退出码恒为 0（报告）；要不要变成门由人决定。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
LOOP = re.compile(r"for \(const \w+ of ([A-Z][A-Z0-9_]*)\)")


def main() -> int:
    files = subprocess.run(["git", "-C", str(REPO), "ls-files", "*.test.ts"],
                           capture_output=True, text=True).stdout.split()
    hits: list[tuple[str, str]] = []
    for rel in files:
        path = REPO / rel
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for name in set(LOOP.findall(text)):
            # 本文件里定义了它 ⇒ 本地字面量表，清空会出现在 diff 里（不在本检查范围）
            if re.search(rf"^\s*(?:const|let|var)\s+{re.escape(name)}\b", text, re.M):
                continue
            if re.search(rf"{re.escape(name)}\s*\.length|\.length\s*\)[^\n]*{re.escape(name)}", text):
                continue
            hits.append((rel, name))

    if "--json" in sys.argv:
        print(json.dumps({"count": len(hits),
                          "hits": [{"file": f, "table": n} for f, n in hits]},
                         ensure_ascii=False, indent=1))
        return 0

    print(f"遍历**导入常量**、且文件里没有 `NAME.length` 断言的：{len(hits)}")
    if not hits:
        print("✓ 没有「遍历 0 个也通过」的形态")
        return 0
    for rel, name in sorted(set(hits)):
        print(f"  {rel}  …of {name}")
    print("\n⚠️ 这不是说它们都错了：导入常量若在别处被断言过，风险已经被覆盖。")
    print("   但它至少说明：**这些测试自己不会因为表变空而红**。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
