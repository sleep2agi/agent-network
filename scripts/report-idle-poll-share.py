#!/usr/bin/env python3
"""「问状态/问活」占了全部工具调用的多少 —— 一条会退化的读数。

## 为什么需要它（#3119）

2026-11-01 近 6h（生产库）：全部 90 个节点 23,273 次调用里，

    mcp:org_whoami      6,943  29.8%
    mcp:get_all_status  6,141  26.4%
    mcp:list_tasks      4,480  19.2%
    mcp:get_task        2,193   9.4%
    ⇒ 四项合计 19,757 = **84.9%**

它们回答的是同一个问题「现在有没有新东西」，而 Hub 已经用推送回答过了。

提示词侧已改（`agent-node` 2.5.0-preview.172/173）。但「改完之后有没有变好」需要一条
可复算的读数 —— 否则只会在下一次有人想起时才知道。

## 口径（写死，不许临时换）

    表   node_tool_calls（network_id, node_id, tool, hour, hits）
    窗口 hour >= now - W（小时桶，UTC）
    分子 tool IN ('mcp:org_whoami','mcp:get_all_status','mcp:list_tasks','mcp:get_task')
    分母 全部 tool 的 hits 之和

## 已知偏差

- `hour` 是**小时桶**：窗口边界那一小时会被整段计入或整段排除（6h 窗口最多 ±1h 误差）。
- 只统计**上报了的**调用：不报的客户端在这里不可见（分母可能偏小）。
- 这个比例**不是**「浪费的比例」：其中 get_task 在真的等子任务时是合理的。
  它衡量的是「问的频率」，不是「问的对错」。

## 用法

    python3 scripts/report-idle-poll-share.py [--hours 6] [--assert --max 0.90]

`--assert`：比例 **> --max** 时退出码 1（默认 0.90）。
退出码：0 = 有读数；1 = 超过阈值；2 = 读不到库（**不是 0**：没读数 ≠ 没问题）。
"""
from __future__ import annotations

import datetime as dt
import os
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path.home() / ".commhub" / "commhub.db"
ASK_TOOLS = ("mcp:org_whoami", "mcp:get_all_status", "mcp:list_tasks", "mcp:get_task")


def main() -> int:
    hours = 6
    if "--hours" in sys.argv:
        hours = int(sys.argv[sys.argv.index("--hours") + 1])
    max_share = 0.90
    if "--max" in sys.argv:
        max_share = float(sys.argv[sys.argv.index("--max") + 1])

    db_path = Path(os.environ.get("COMMHUB_DB") or DEFAULT_DB)
    if not db_path.exists():
        print(f"✗ 读不到 {db_path}（COMMHUB_DB 未设置且默认路径不存在）", file=sys.stderr)
        print("  ⇒ 这是「没有读数」，不是「没有问题」", file=sys.stderr)
        return 2
    since = (dt.datetime.now(dt.UTC) - dt.timedelta(hours=hours)).strftime("%Y-%m-%dT%H")
    try:
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        rows = db.execute(
            "SELECT tool, SUM(hits) FROM node_tool_calls WHERE hour >= ? GROUP BY tool",
            (since,)).fetchall()
    except sqlite3.Error as exc:
        print(f"✗ 查询失败：{exc}", file=sys.stderr)
        return 2

    total = sum(n or 0 for _, n in rows)
    if total == 0:
        print(f"✗ 窗口内 0 次调用（since {since}）—— 没有读数，不是「比例为 0」", file=sys.stderr)
        return 2
    by_tool = {t: (n or 0) for t, n in rows}
    ask = sum(by_tool.get(t, 0) for t in ASK_TOOLS)
    share = ask / total

    print(f"窗口：近 {hours}h（hour >= {since}）· 总调用 {total}")
    for t in ASK_TOOLS:
        n = by_tool.get(t, 0)
        print(f"  {t:<22} {n:>7}  {100 * n / total:5.1f}%")
    print(f"  ⇒ 四项合计 {ask} = **{100 * share:.1f}%**（阈值 {100 * max_share:.0f}%）")
    print("  mutates: none（只读）")

    if share > max_share:
        print(f"✗ 比例 {100 * share:.1f}% > 阈值 {100 * max_share:.0f}%"
              f" ⇒ 「问状态/问活」又涨回去了", file=sys.stderr)
        print("  ⇒ 先看是不是提示词版本没生效（agent-node < 2.5.0-preview.173）", file=sys.stderr)
        return 1 if "--assert" in sys.argv else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
