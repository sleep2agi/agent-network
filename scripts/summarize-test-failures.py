#!/usr/bin/env python3
"""把一批测试失败按**根因**归并，而不是按条数。

2026-10-31 —— 起因：一次单进程全量跑给出 812 条 fail，而根因只有 1 条
（某个测试关掉了共享 db，后面全部连锁）。若按条修，工作量被高估 812 倍；
而修完第一条之后其余 811 条会自己消失。

⇒ 判据：**一次批量失败里先找「最早的那条」，再判其余是否由它导致。**
  不归并时，修 812 次也不会少 812 个。

用法：
    bun test 2>&1 | python3 scripts/summarize-test-failures.py
    python3 scripts/summarize-test-failures.py < captured.log
    ... --json

归并口径（刻意保守，宁可少归并也不要把两个原因说成一个）：
  · 用 bun 的 `(fail)` 行拿到失败用例；
  · 用它**上面最近的一条** `error:` / `RangeError:` / `TypeError:` 行作为签名；
  · 同一签名归为一组；没有签名的归到 "(no error line captured)"。
⇒ 输出是「组数 + 每组条数 + 每组第一条」，不是「一共多少条」。
"""
from __future__ import annotations

import json
import re
import sys
from collections import OrderedDict

FAIL = re.compile(r"^\(fail\)\s+(.*)$")
ERR = re.compile(r"^(?:error|RangeError|TypeError|ReferenceError|SyntaxError|AssertionError)\s*:\s*(.*)$")


def main() -> int:
    lines = sys.stdin.read().splitlines()
    groups: "OrderedDict[str, list[str]]" = OrderedDict()
    pending = "(no error line captured)"
    for line in lines:
        m = ERR.match(line.strip())
        if m:
            pending = m.group(1).strip()[:160] or pending
            continue
        f = FAIL.match(line.strip())
        if f:
            # 注意：**不重置** pending —— bun 的输出里一条 error 行之后常跟多条 (fail)
            #（同一根因的连锁）。重置会把它们拆成多个「无签名」组，正是这次事故的形状。
            groups.setdefault(pending, []).append(f.group(1).strip())

    total = sum(len(v) for v in groups.values())
    if "--json" in sys.argv:
        print(json.dumps({
            "failures": total,
            "root_causes": len(groups),
            "groups": [{"signature": k, "count": len(v), "first": v[0]} for k, v in groups.items()],
        }, ensure_ascii=False, indent=1))
        return 0

    if total == 0:
        print("没有 (fail) 行 ⇒ 0 条失败（注意：这也可能是输出没被完整捕获）")
        return 0
    print(f"失败 {total} 条 ⇒ 归并后 **{len(groups)} 个根因**")
    for sig, items in sorted(groups.items(), key=lambda kv: -len(kv[1])):
        print(f"\n  ×{len(items)}  {sig}")
        print(f"        首条：{items[0]}")
    print("\n⚠️ 归并按「最近一条 error 行」做签名，是启发式：")
    print("   同一原因打不同文案 ⇒ 会被分成多组（少归并）；不同原因共用文案 ⇒ 会被并成一组（多归并）。")
    print("   ⇒ 修之前先看首条，再看这一组里是否真有同一个栈。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
