#!/usr/bin/env python3
"""「当前 provider / 模型」这一格，客户端今天能填上多少 —— 一条可复算的读数。

## 为什么需要它（#3143 ② 显 / #3144 ① 读）

客户端要显示「这个节点现在用哪个 provider、哪个模型」，前提是 Hub 手里的
`sessions.model` 能还原出 provider。两种可能：

    `deepseek/deepseek-flash`  ⇒ 能（provider=deepseek, model=deepseek-flash）
    `gpt-5.5`                  ⇒ 不能（只有模型名，provider 无从得知）

而 `sessions.model` 是**各 runtime 自己报的**，格式不统一。于是「面板能不能显示」
不是界面问题，是**上报格式问题**。

2026-11-01 实测（生产库，381 个会话）：

    provider/model   52   （全部来自 agent-node:opencode）
    bare_model      175
    absent          154
    ⇒ 能给出 provider 的只有 52/381 = 14%

对本期范围（只做 OpenCodeV2-CLI 共存）而言这是个**好消息**：
    agent-node:opencode 53 个会话里 51 个是 provider/model（96%），另 2 个是空。

## 口径（写死）

    表    sessions（agent, model）
    分档  provider/model  恰好一个 '/'，两侧都非空
          bare_model      没有 '/'（只有模型名）
          odd             有 '/' 但不是恰好一个（多段 / 首尾为空）—— 目前为 0，保留这一档
          absent          model 为 NULL 或 ''

## 已知偏差

- 客户端不该为了这两档去「猜」：bare_model 的 provider **不可知**，界面上应显示
  「未知」而不是取个默认值 —— 猜出来的 provider 比空着更坏（切换时会切错）。
- 只统计 sessions 表里已存在的节点；从未上报过的节点不在这里（也不在别处）。

## 用法

    python3 scripts/report-model-ref-shape.py [--max-bare 0.50] [--assert]

`--assert`：bare_model + odd 占比 > --max-bare（默认 0.50）⇒ 退出码 1。
退出码：0 = 有读数；1 = 超阈；2 = 读不到库或表里 0 个会话（**没读数 ≠ 没问题**）
"""
from __future__ import annotations

import collections
import os
import sqlite3
import sys
from pathlib import Path

DEFAULT_DB = Path.home() / ".commhub" / "commhub.db"


def shape(model: str | None) -> str:
    if not model:
        return "absent"
    slashes = model.count("/")
    if slashes == 1:
        provider, _, name = model.partition("/")
        return "provider/model" if provider and name else "odd"
    return "bare_model" if slashes == 0 else "odd"


def main() -> int:
    max_bare = 0.50
    if "--max-bare" in sys.argv:
        max_bare = float(sys.argv[sys.argv.index("--max-bare") + 1])

    db_path = Path(os.environ.get("COMMHUB_DB") or DEFAULT_DB)
    if not db_path.exists():
        print(f"✗ 读不到 {db_path}", file=sys.stderr)
        print("  ⇒ 这是「没有读数」，不是「没有问题」", file=sys.stderr)
        return 2
    try:
        db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
        rows = db.execute("SELECT COALESCE(agent, '<none>') a, model FROM sessions").fetchall()
    except sqlite3.Error as exc:
        print(f"✗ 查询失败：{exc}", file=sys.stderr)
        return 2
    if not rows:
        print("✗ sessions 表里 0 行 —— 没有读数，不是「全部可解析」", file=sys.stderr)
        return 2

    agg: dict[str, collections.Counter[str]] = collections.defaultdict(collections.Counter)
    for agent, model in rows:
        agg[agent][shape(model)] += 1
    total = collections.Counter()
    print(f"{'agent':<26}{'provider/model':>15}{'bare_model':>12}{'absent':>8}{'odd':>5}")
    for agent, counts in sorted(agg.items(), key=lambda kv: -sum(kv[1].values())):
        print(f"{agent:<26}{counts['provider/model']:>15}{counts['bare_model']:>12}"
              f"{counts['absent']:>8}{counts['odd']:>5}")
        total.update(counts)
    n = sum(total.values())
    print(f"{'合计':<26}{total['provider/model']:>15}{total['bare_model']:>12}"
          f"{total['absent']:>8}{total['odd']:>5}")
    print(f"\n能给出 provider 的：{total['provider/model']}/{n} = "
          f"{100 * total['provider/model'] / n:.0f}%")
    print("  mutates: none（只读）")

    unparseable = (total["bare_model"] + total["odd"]) / n
    if unparseable > max_bare:
        print(f"✗ 无法还原 provider 的占 {100 * unparseable:.0f}% > 阈值 {100 * max_bare:.0f}%",
              file=sys.stderr)
        print("  ⇒ 客户端只能显示模型名；要显示 provider，必须让对应 runtime 上报 provider/model",
              file=sys.stderr)
        return 1 if "--assert" in sys.argv else 0
    return 0


if __name__ == "__main__":
    sys.exit(main())
