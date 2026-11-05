#!/usr/bin/env python3
"""list_tasks 的耗时对照：stats 开 / 省，增量窗口开 / 关。

## 为什么需要它（#3119）

2026-11-05 `.270` 把「节点令牌默认省略 stats」上线了。这条改动的**理由是**
「省掉一次没人读的全表 GROUP BY」—— 但理由不等于结果：
不测一次，"变便宜了"只是推断。

本脚本在**同一个 Hub、同一台机器、同一个调用者**上交替跑四组，各 N 次，
报 p50 / p90 / min / max。它不是回归门（阈值随批次波动），是把「推断」换成「读数」。

## 用法

    python3 scripts/bench-list-tasks.py --alias 通信欧 --runs 15

令牌从环境变量 `ANET_NODE_TOKEN` 或 `~/.anet/nodes/<alias>/config.json` 的 token 读，
**不打印**。Hub 地址默认 `http://127.0.0.1:9200`（`ANET_HUB_URL` 可覆盖）。

退出码：0 = 有读数；2 = 拿不到令牌或 Hub 不可达（**没读数 ≠ 没问题**）。
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
import urllib.request
from pathlib import Path


def load_token(alias: str) -> str | None:
    token = os.environ.get("ANET_NODE_TOKEN")
    if token:
        return token
    # 节点目录可能在 ~/.anet、也可能在某个项目工作区（.anet/nodes/…）——
    # 两处都找；找不到就叫 NT_ 里的「没有读数」，不是"没有节点"。
    candidates = [
        Path.home() / ".anet" / "nodes" / alias / "config.json",
        Path.cwd() / ".anet" / "nodes" / alias / "config.json",
        Path(os.environ.get("ANET_NODES_DIR", str(Path.home() / "comm-ou-v2/.anet/nodes"))) / alias / "config.json",
    ]
    for path in candidates:
        try:
            return json.loads(path.read_text()).get("token") or None
        except Exception:
            continue
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--alias", required=True)
    ap.add_argument("--runs", type=int, default=15)
    ap.add_argument("--limit", type=int, default=20)
    args = ap.parse_args()

    token = load_token(args.alias)
    if not token:
        print("✗ 拿不到节点令牌（ANET_NODE_TOKEN 未设，且 config.json 里也没有）", file=sys.stderr)
        return 2
    hub = os.environ.get("ANET_HUB_URL", "http://127.0.0.1:9200").rstrip("/")

    def call(extra: dict) -> float:
        body = json.dumps({
            "jsonrpc": "2.0", "id": 1, "method": "tools/call",
            "params": {"name": "list_tasks",
                       "arguments": {"alias": args.alias, "limit": args.limit, **extra}},
        }).encode()
        req = urllib.request.Request(hub + "/mcp", data=body, headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        })
        started = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                resp.read()
        except Exception as exc:
            raise SystemExit(f"✗ 调用失败：{exc}") from exc
        return (time.perf_counter() - started) * 1000

    scenarios = [
        ("stats 开 (omit_stats=false)", {"omit_stats": False}),
        ("stats 省 (节点令牌默认)", {}),
        ("stats 开 + 增量空窗", {"omit_stats": False, "created_since": "2099-01-01T00:00:00Z"}),
        ("stats 省 + 增量空窗", {"omit_stats": True, "created_since": "2099-01-01T00:00:00Z"}),
    ]
    print(f"Hub {hub} · alias={args.alias} · runs={args.runs} · limit={args.limit}")
    for label, extra in scenarios:
        samples = sorted(call(extra) for _ in range(args.runs))
        p50 = statistics.median(samples)
        p90 = samples[max(0, int(args.runs * 0.9) - 1)]
        print(f"  {label:<26} p50={p50:6.1f}ms  p90={p90:6.1f}ms  "
              f"min={samples[0]:6.1f}  max={samples[-1]:6.1f}")
    print("  mutates: none（只读；不写任务、不改水位 —— 未传 since_last）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
