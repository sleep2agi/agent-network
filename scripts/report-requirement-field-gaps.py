#!/usr/bin/env python3
"""新建需求卡的「缺字段」读数：一天建了多少张、其中多少至少缺一项。

## 为什么需要它（#3068）

原来只有「我巡逻时撞上的补漏次数」（一天 27 次）。复测（2026-11-01，近 7 天）：

    新建 1162 张 · 至少缺一项 **576 张 = 50%**
    缺 project 329 · 缺 agent_owner 306 · 缺 due 338

⇒ 「补漏次数」是巡逻能看见的那部分，不是总量。本脚本给总量。

## 口径（写死）

    表   requirements
    窗口 created_at > now - N 天（默认 7）
    缺项 project_id 为空 / agent_owner_json 为空或 'null' / due_on 为空
    排除 archived（已归档的卡不再需要这些字段）

## 已知偏差

- 只统计**本库**里的卡；别的 network 的卡也在这个库里，所以这是全舰队口径。
- 「缺 agent_owner」对纯人卡（没有执行节点）是合理的 —— 本脚本**不判断该不该有**，
  只报「有没有」。要判定合理性得看卡的类型，而类型不在库里。

## 用法

    python3 scripts/report-requirement-field-gaps.py [--days 7] [--daily] [--assert --max 0.30]

--daily   只打每日一行（给定时巡检用，输出「日期 新建 缺字段」）
--assert  缺字段比例 > --max（默认 0.30）⇒ 退出码 1
退出码：0 = 有读数；1 = 超阈值；2 = 读不到库或窗口内 0 张新建（**没读数 ≠ 没问题**）
"""
from __future__ import annotations

import datetime as dt
import os
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path.home() / ".commhub" / "commhub.db"

GAP_SQL = ("(project_id IS NULL "
           "OR agent_owner_json IS NULL OR agent_owner_json IN ('', 'null') "
           "OR due_on IS NULL OR due_on = '')")


def main() -> int:
    days = 7
    if "--days" in sys.argv:
        days = int(sys.argv[sys.argv.index("--days") + 1])
    max_share = 0.30
    if "--max" in sys.argv:
        max_share = float(sys.argv[sys.argv.index("--max") + 1])

    db_path = Path(os.environ.get("COMMHUB_DB") or DEFAULT_DB)
    if not db_path.exists():
        print(f"✗ 读不到 {db_path}", file=sys.stderr)
        print("  ⇒ 这是「没有读数」，不是「没有问题」", file=sys.stderr)
        return 2
    try:
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        tot, gp, npj, nao, ndue = db.execute(f"""
            SELECT COUNT(*),
                   SUM(CASE WHEN {GAP_SQL} THEN 1 ELSE 0 END),
                   SUM(CASE WHEN project_id IS NULL THEN 1 ELSE 0 END),
                   SUM(CASE WHEN agent_owner_json IS NULL OR agent_owner_json IN ('','null') THEN 1 ELSE 0 END),
                   SUM(CASE WHEN due_on IS NULL OR due_on = '' THEN 1 ELSE 0 END)
            FROM requirements
            WHERE created_at > datetime('now', ?) AND archived = 0
        """, (f"-{days} day",)).fetchone()
        per_day = db.execute(f"""
            SELECT substr(created_at,1,10) d, COUNT(*),
                   SUM(CASE WHEN {GAP_SQL} THEN 1 ELSE 0 END)
            FROM requirements
            WHERE created_at > datetime('now', ?) AND archived = 0
            GROUP BY d ORDER BY d DESC
        """, (f"-{days} day",)).fetchall()
    except sqlite3.Error as exc:
        print(f"✗ 查询失败：{exc}", file=sys.stderr)
        return 2

    tot, gp, npj, nao, ndue = [x or 0 for x in (tot, gp, npj, nao, ndue)]
    if tot == 0:
        print(f"✗ 窗口内 0 张新建（近 {days} 天）—— 没有读数，不是「缺字段为 0」", file=sys.stderr)
        return 2
    share = gp / tot

    if "--daily" in sys.argv:
        if per_day:
            d, n, m = per_day[0]
            print(f"{d} 新建={n} 缺字段={m}")
        return 0

    print(f"窗口：近 {days} 天 · 新建 {tot} 张 · **至少缺一项 {gp} = {100 * share:.0f}%**"
          f"（阈值 {100 * max_share:.0f}%）")
    print(f"  缺 project_id    {npj}")
    print(f"  缺 agent_owner   {nao}")
    print(f"  缺 due           {ndue}")
    print("按天（新建 / 缺字段）：")
    for d, n, m in per_day:
        print(f"  {d}  {n:>4} / {m:>4}")
    print("  mutates: none（只读）")

    if share > max_share:
        print(f"✗ 缺字段比例 {100 * share:.0f}% > 阈值 {100 * max_share:.0f}%", file=sys.stderr)
        return 1 if "--assert" in sys.argv else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
