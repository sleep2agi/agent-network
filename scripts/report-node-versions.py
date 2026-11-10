#!/usr/bin/env python3
"""节点版本分布 + 升级清单（只读）。

2026-10-31 —— 为什么需要它：

「182 条因共享会话忙未提交」这件事，卡上一度写成「某几台老节点没升级」。
实际读下来是 **57/62 台 agent-node 都在 .166 之前** —— 不是坏节点，是升级没铺开。
而这条读数有一个**分母陷阱**：

    sessions.version 把两个产品族放在同一列：
      2.5.0-preview.*    ← agent-node
      1.20.12-alpha.*    ← 另一条产品线
    直接对整列做「< 2.5.0-preview.166」会把 alpha 也数进去（我第一次就数成了 81 台）。

⇒ 所以本脚本**先分族，再比较**。跨族比较没有意义，而它看起来完全正常。

用法：
    python3 scripts/report-node-versions.py [--db PATH] [--since 2026-10-29]
                                            [--min-preview 166] [--json]

只读：以 SQLite `mode=ro` 打开，不建表、不写库。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
from collections import Counter

FAMILY_PATTERNS = (
    (re.compile(r"^2\.5\.0-preview\.(\d+)$"), "agent-node"),
    (re.compile(r"^1\.20\.12-alpha\.(\d+)$"), "desktop-alpha"),
)


def classify(version: str) -> tuple[str, int | None]:
    """→ (族名, 序号)。认不出的族给 ("other", None) —— 不猜。"""
    for pattern, name in FAMILY_PATTERNS:
        m = pattern.match(version or "")
        if m:
            return name, int(m.group(1))
    return "other", None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.expanduser("~/.commhub/commhub.db"))
    ap.add_argument("--since", default="2026-10-29", help="只看这个时刻之后还活着的 session")
    ap.add_argument("--min-preview", type=int, default=166,
                    help="agent-node 的最低可接受 preview 序号")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not os.path.exists(args.db):
        print(f"✗ 找不到 {args.db}", file=sys.stderr)
        return 2

    con = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    rows = list(con.execute(
        "SELECT alias, version, last_seen_at FROM sessions "
        "WHERE coalesce(version,'') <> '' AND coalesce(last_seen_at,'') >= ?",
        (args.since,),
    ))
    con.close()

    fam_counts: Counter[str] = Counter()
    an_rows: list[tuple[str, str, int | None, str]] = []
    for alias, version, seen in rows:
        fam, num = classify(version or "")
        fam_counts[fam] += 1
        if fam == "agent-node":
            an_rows.append((alias, version or "", num, seen or ""))

    old = sorted((r for r in an_rows if (r[2] is None or r[2] < args.min_preview)),
                 key=lambda r: (r[2] is not None, r[2] or -1))
    new = sorted((r for r in an_rows if r[2] is not None and r[2] >= args.min_preview),
                 key=lambda r: -(r[2] or 0))

    if args.json:
        print(json.dumps({
            "families": dict(fam_counts),
            "agent_node_total": len(an_rows),
            "below_min": [{"alias": a, "version": v} for a, v, _, _ in old],
            "at_or_above_min": [{"alias": a, "version": v} for a, v, _, _ in new],
        }, ensure_ascii=False, indent=1))
        return 0

    print(f"库：{args.db}")
    print(f"活跃 session：{len(rows)} 条（since {args.since}）")
    if not rows:
        # 0 条不等于「没有节点」：最常见的原因是 --db 指到了另一个库
        #（本机节点自己的 HOME 下也有一个 .commhub），或 --since 太新。
        print("⚠ 读到 0 条 —— 先确认上面这个库是不是你要的那个；"
              "「0 条」与「没有节点」在输出上同形。", file=sys.stderr)
    print("按产品族拆分（**跨族版本号不可比**）：")
    for fam, n in fam_counts.most_common():
        print(f"  {fam:16s} {n}")
    print()
    print(f"agent-node {len(an_rows)} 台：< preview.{args.min_preview} = {len(old)}，"
          f">= preview.{args.min_preview} = {len(new)}")
    if old:
        print("\n需要升级（按版本分组）：")
        for ver, n in Counter(v for _, v, _, _ in old).most_common():
            print(f"  {ver:24s} {n} 台")
    if new:
        print("\n已在门槛之上：")
        for alias, ver, _, _ in new:
            print(f"  {alias}  {ver}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
