#!/usr/bin/env python3
"""REST 端点的**静态**清单 —— 给 #3214 造分母的第一步（并如实标出它看得见/看不见什么）。

2026-10-31 —— 为什么需要它：

    MCP 侧有注册表（server.tool(...)）⇒ 分母 = 88，覆盖率有意义
    REST 侧是手写 `url.pathname` 匹配 ⇒ 分母不可数 ⇒ 覆盖率只能是 0/0
    ⇒ 而 0/0 在报表里会被写成「无违规」或「N/A」

这份脚本**不是**那个分母（真正的分母要抽路由表），但它能把「今天散落的手写匹配」
列成一份可读清单，让「还差多少」这件事第一次有形状。

它看得见（以 server.ts 为对象）：
    · `url.pathname === "/x"` / `!== "/x"`
    · `url.pathname.startsWith("/x")`
    · `url.pathname.match(/^\\/x/)` 的**字面前缀**（只取 pattern 里的静态前缀）

它看不见（所以这不是分母）：
    · 由变量拼出来的路径、正则里的动态段、位于其它文件里的匹配
    · 中间件与兜底（`app.all` 之类）的真实覆盖顺序

用法：python3 scripts/report-rest-endpoints.py [--json]
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TARGET = REPO / "server" / "src" / "server.ts"

PATTERNS = (
    ("eq", re.compile(r'url\.pathname\s*===\s*"([^"]+)"')),
    ("eq_neg", re.compile(r'url\.pathname\s*!==\s*"([^"]+)"')),
    ("starts_with", re.compile(r'url\.pathname\.startsWith\(\s*"([^"]+)"')),
    ("regex_prefix", re.compile(r'url\.pathname\.match\(\s*/\^\\/([^/\\$?(]+)')),
)


def main() -> int:
    if not TARGET.exists():
        print(f"✗ 找不到 {TARGET}", file=sys.stderr)
        return 2
    text = TARGET.read_text(encoding="utf-8", errors="replace")

    found: dict[str, set[str]] = {}
    for kind, pat in PATTERNS:
        for m in pat.finditer(text):
            found.setdefault(kind, set()).add(m.group(1))

    total = sum(len(v) for v in found.values())
    if "--json" in sys.argv:
        print(json.dumps({
            "object": "server/src/server.ts",
            "by_kind": {k: sorted(v) for k, v in found.items()},
            "total": total,
            "not_a_denominator_because": [
                "variable-built paths are invisible",
                "dynamic segments inside regexes are cut at the first variable char",
                "matches living in other files are not scanned",
                "middleware/fallback ordering is not modelled",
            ],
        }, ensure_ascii=False, indent=1))
        return 0

    print("对象        : server/src/server.ts（**只是这一个文件**，不是整个 REST 面）")
    print(f"匹配点合计  : {total}")
    for kind, _ in PATTERNS:
        vals = sorted(found.get(kind, ()))
        if not vals:
            continue
        print(f"\n[{kind}] {len(vals)} 处")
        for v in vals[:40]:
            print(f"    {v}")
        if len(vals) > 40:
            print(f"    …（共 {len(vals)} 处）")

    prefixes = Counter()
    for vals in found.values():
        for v in vals:
            seg = v.strip("/").split("/")[0]
            prefixes[seg] += 1
    print("\n按首段分布（用来估「一张路由表大概要写多少条」）：")
    for seg, n in prefixes.most_common(12):
        print(f"    {seg or '(root)':20s} {n}")

    print("\n⚠️ 这不是分母：")
    print("    · 变量拼出来的路径看不见")
    print("    · 正则里的动态段被截到第一个变量字符")
    print("    · 其它文件里的匹配没扫")
    print("    · 中间件与兜底的覆盖顺序没有建模")
    print("⇒ 它能回答「散落的手写匹配大概有多少」，不能回答「一共有多少个端点」。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
