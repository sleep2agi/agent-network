#!/usr/bin/env python3
"""节点 Token 用量排行（直接读生产库，不需要人令牌）。

## 为什么需要它（#3952 / #3950）

Hub 有了 `/api/token-usage`，但那个口要**人令牌**；而巡检机上没有。
审计的第一眼是"谁用得最多"，这件事只需要库，不需要接口。

## 口径（写死，与表一致）

    表      node_token_usage(network_id, node_id, hour, model,
                             input_tokens, output_tokens, cache_read_tokens, turns, cost_usd)
    窗口    hour >= now - N 小时（UTC 小时桶）
    total   **input + output**，不含 cache
    cache   cache_read_tokens 单列 —— 实测 opencode 上它是 total 的 289 倍，
            混进去排行会从「谁最贵」变成「谁最老」

## 已知偏差

- 只统计**上报过**的节点：没接线的运行时（或没升级的节点）在这里不可见，
  分母不是"所有节点"。所以脚本会同时打印「窗口内有用的节点数」，别把它当覆盖率。
- `turns` / `cost_usd` 在存储层 NOT NULL DEFAULT 0 ⇒「没报」与「报了 0」同形。
- `turns` 现在只覆盖 **claude（num_turns）与 codex（每次 outcome 记 1）**；
  opencode 走的是「按会话增量轮询」，一次上报≠一轮 ⇒ 它的 turns 仍是 0。
  **读这一列时先看节点 runtime**：0 在 opencode 上表示「不适用」，不是「没跑过」。
- 老 Hub 的表没有 `cache_read_tokens` 列时，本脚本会明说「这一列还不存在」，而不是当 0。

## 用法

    python3 scripts/report-node-token-usage.py [--hours 24] [--top 10] [--node 名称]

退出码：0 = 有读数；1 = --assert 且有人超阈值（--max-total）；2 = 读不到库或表（**没读数 ≠ 没问题**）
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path.home() / ".commhub" / "commhub.db"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--top", type=int, default=10)
    ap.add_argument("--node", help="只看这个名字（alias 子串匹配）")
    ap.add_argument("--assert", dest="do_assert", action="store_true")
    ap.add_argument("--max-total", type=int, default=0, help="total_tokens 上限（单节点），配合 --assert")
    args = ap.parse_args()

    db_path = Path(os.environ.get("COMMHUB_DB") or DEFAULT_DB)
    if not db_path.exists():
        print(f"✗ 读不到 {db_path}（COMMHUB_DB 未设置且默认路径不存在）", file=sys.stderr)
        print("  ⇒ 这是「没有读数」，不是「没有问题」", file=sys.stderr)
        return 2

    since = (dt.datetime.now(dt.UTC) - dt.timedelta(hours=max(1, args.hours))).strftime("%Y-%m-%dT%H")
    try:
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        has_table = db.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='node_token_usage'").fetchone()[0]
    except sqlite3.Error as exc:
        print(f"✗ 查询失败：{exc}", file=sys.stderr)
        return 2
    if not has_table:
        print("✗ 库里没有 node_token_usage 表 ⇒ Hub 还没部署到含该表的那一版（.271+）", file=sys.stderr)
        print("  ⇒ 这是「还没有这个能力」，不是「用量为 0」", file=sys.stderr)
        return 2

    cols = [r[1] for r in db.execute("PRAGMA table_info(node_token_usage)")]
    has_cache = "cache_read_tokens" in cols
    if not has_cache:
        print("⚠ 这张表还没有 cache_read_tokens 列（.273 才加）—— 下面不显示 cache，不等于 cache 为 0",
              file=sys.stderr)

    cache_expr = "SUM(u.cache_read_tokens)" if has_cache else "0"
    rows = db.execute(f"""
        SELECT u.node_id,
               COALESCE(n.alias, s.alias) AS alias,
               SUM(u.input_tokens)  AS input_tokens,
               SUM(u.output_tokens) AS output_tokens,
               {cache_expr}         AS cache_read_tokens,
               SUM(u.turns)         AS turns,
               SUM(u.cost_usd)      AS cost_usd,
               MIN(u.hour) AS first_hour, MAX(u.hour) AS last_hour
          FROM node_token_usage u
          LEFT JOIN nodes n ON n.node_id = u.node_id AND n.network_id = u.network_id
          LEFT JOIN sessions s ON s.node_id = u.node_id AND s.network_id = u.network_id
         WHERE u.hour >= ?
         GROUP BY u.node_id
         ORDER BY (SUM(u.input_tokens) + SUM(u.output_tokens)) DESC
    """, (since,)).fetchall()

    if args.node:
        rows = [r for r in rows if args.node.lower() in str(r[1] or r[0]).lower()]

    print(f"窗口：近 {args.hours}h（hour >= {since}）· 有用量的节点 {len(rows)} 个")
    if not rows:
        print("  （空：这个窗口里没有任何节点上报过用量 —— 不是「用量为 0」）")
        print("  mutates: none（只读）")
        return 0

    print(f"\n{'节点':<22}{'input':>14}{'output':>12}{'total':>14}{'cache_read':>16}{'cost $':>10}{'turns*':>8}")
    worst = 0
    for node_id, alias, inp, outp, cache, turns, cost, _f, _l in rows[: args.top]:
        total = (inp or 0) + (outp or 0)
        worst = max(worst, total)
        name = (alias or node_id)[:20]
        print(f"{name:<22}{inp or 0:>14,}{outp or 0:>12,}{total:>14,}{cache or 0:>16,}{cost or 0:>10.2f}{turns or 0:>8}")
    print("\n  total = input + output（**不含 cache**）；cache 单列，混算会把排行变成「谁最老」")
    print("  分母是「窗口内上报过的节点」，不是全网节点数 ⇒ 别把这个数当覆盖率")
    print("  mutates: none（只读）")

    if args.do_assert and args.max_total and worst > args.max_total:
        print(f"✗ 单节点 total 最高 {worst:,} > 阈值 {args.max_total:,}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
