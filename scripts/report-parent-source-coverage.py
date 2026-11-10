#!/usr/bin/env python3
"""`parent_task_id` 有了、`parent_source` 没有 ⇒ 有一格「不知道是谁挂的」的空格。

## 为什么需要

`#669` 加了 `meta_json.parent_source`（`explicit` / `inferred`），用来回答
「生产上有多少子任务是靠推断挂上的」。而它只写在**确实有 parent 的时候**：

    if (parentSource && parentTaskId) { meta.parent_source = parentSource }

这半条是对的（没有 parent 时不该有来源），但**只有这半条**时留了一个空格：

    parent_task_id 有值                       ⇒ 要求 parent_source 有值   ✅ 已断言
    parent_task_id 为空                       ⇒ 不要求                    ✅ 合理
    **parent_task_id 有值但来源缺失**          ⇒ 两个半条件同时放过        🔴 就是这个空格

后果是可读的而不是抽象的：`#669` 那张卡上的 `6.0% vs 0.5%`（推断 vs 显式的失败率）
分母取的是「**记了来源的**父任务」。若某条派发路径写了 `parent_task_id` 却没写来源，
它既不进 inferred 也不进 explicit ⇒ **分母静默变小，而比率看起来更干净**。

## 三态与处置

    parent + source      ⇒ 可分（explicit / inferred 各一个数）
    parent, no source    ⇒ **切口之前是历史，切口之后是缺口**
    source, no parent    ⇒ 不该存在（一条来源指向不存在的父）⇒ 直接报

「切口」= 本字段上线的部署日。之前的行为不是缺陷（当时没有这个字段），
之后的行为是缺陷（写了父却没写来源）。把两者混在一个数里，会让一个历史事实
永远出现在今天的报表上，于是它很快被忽略 —— 忽略一旦形成，与「从未触发」同形。

## 用法

    python3 scripts/report-parent-source-coverage.py [--assert]

    --assert  有「切口后的缺口」或「source 无 parent」⇒ 退出码 1（默认只报告）

退出码：0 = 没有切口后的缺口；1 = 有缺口；2 = 读不到库（**不是 0**：没读数 ≠ 没问题）。
"""
from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path

# 2026-10-29 —— `parent_source` 第一次进生产的部署日（0.9.0-preview.195）。
# 改这个常量的唯一理由是「确实是那一天上的线」；它不是「从今天往前数 N 天」，
# 那种写法会让缺口每天自动消失。
CUTOVER = "2026-10-29"

DEFAULT_DB = Path.home() / ".commhub" / "commhub.db"

HAS = "meta_json LIKE '%\"parent_source\":\"%'"


def main() -> int:
    db_path = Path(os.environ.get("COMMHUB_DB") or DEFAULT_DB)
    if not db_path.exists():
        print(f"✗ 读不到 {db_path}（COMMHUB_DB 未设置且默认路径不存在）", file=sys.stderr)
        print("  ⇒ 这是「没有读数」，不是「没有问题」", file=sys.stderr)
        return 2
    try:
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        rows = db.execute(f"""
            SELECT
              SUM(CASE WHEN parent_task_id IS NOT NULL AND {HAS} THEN 1 ELSE 0 END),
              SUM(CASE WHEN parent_task_id IS NOT NULL AND NOT ({HAS}) THEN 1 ELSE 0 END),
              SUM(CASE WHEN parent_task_id IS NULL AND {HAS} THEN 1 ELSE 0 END),
              SUM(CASE WHEN parent_task_id IS NOT NULL AND NOT ({HAS})
                        AND substr(created_at,1,10) >= ? THEN 1 ELSE 0 END),
              SUM(CASE WHEN parent_task_id IS NOT NULL AND substr(created_at,1,10) >= ? THEN 1 ELSE 0 END),
              COUNT(*)
            FROM tasks
        """, (CUTOVER, CUTOVER)).fetchone()
    except sqlite3.Error as exc:
        print(f"✗ 查询失败：{exc}", file=sys.stderr)
        return 2

    both, parent_only, source_only, gap_post, parented_post, total = [x or 0 for x in rows]
    print(f"库：{db_path}")
    print(f"tasks 总行数：{total}")
    print(f"  parent + source      {both}")
    print(f"  parent, **no source** {parent_only}   （其中切口 {CUTOVER} 之后 {gap_post}）")
    print(f"  source, no parent     {source_only}   （不该存在）")
    print(f"切口后的父任务合计 {parented_post} ⇒ 覆盖率 "
          f"{(parented_post - gap_post) / parented_post * 100 if parented_post else 100:.1f}%")
    print("  mutates: none（只读）")

    # 按天：让「缺口在切口当天停住」这件事可看，而不是只能相信一个总数。
    print("\n按天（父任务 / 其中有来源）：")
    for d, p, h in db.execute(f"""
            SELECT substr(created_at,1,10) d,
                   SUM(CASE WHEN parent_task_id IS NOT NULL THEN 1 ELSE 0 END),
                   SUM(CASE WHEN parent_task_id IS NOT NULL AND {HAS} THEN 1 ELSE 0 END)
            FROM tasks WHERE created_at > datetime('now','-10 day')
            GROUP BY d ORDER BY d DESC"""):
        mark = "" if (p == 0 or h == p or d < CUTOVER) else "  ← 缺口"
        print(f"  {d}  父 {p:>4} / 有来源 {h:>4}{mark}")

    bad = gap_post + source_only
    if bad:
        print(f"\n✗ 切口后有 {gap_post} 条「父有值、来源缺失」+ {source_only} 条「来源无父」", file=sys.stderr)
        print("  ⇒ 查所有写 parent_task_id 的地方：每条都要么同时写 parent_source，要么显式说明为什么不需要",
              file=sys.stderr)
        return 1 if "--assert" in sys.argv else 0
    print("\n✓ 切口之后没有缺口，且没有「来源无父」")
    return 0


if __name__ == "__main__":
    sys.exit(main())
