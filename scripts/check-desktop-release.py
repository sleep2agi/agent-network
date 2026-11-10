#!/usr/bin/env python3
"""桌面端「线上」那一层：更新源报的是哪一版、几个平台、每个平台的 URL 是否指向同一版。

## 为什么需要它（#2887）

客户端发版有三层：构建/发布 → 制品 → 线上。前两层由客户端那边记录（run id、资产数），
第三层此前只能**转述**她的回读。本脚本把第三层变成一行可复算的读数。

独立读数的意义不是「更可信」，而是**谁先红**：她那边出错时，这里会不同步地红。

## 口径（写死）

    feed      https://anet.sh/desktop/update/latest.json   （307 → 必须跟随）
    version   feed 里的 version
    platforms feed 里 platforms 的键数
    一致性    每个平台的 url 必须包含 version 字符串（防止「版本号改了、链接没改」）

## 已知偏差

- 只读**更新源**，不校验下载内容的 md5（那要真下载 100MB+，属于发版方证据）。
- GitHub 的 302 跳转不跟随检查：feed 里的 url 是稳定的 release 地址，跳不跳不影响判据。
- 站点静态回退清单（site fallback）不在本脚本口径内 —— 那是另一层，需要单独读。

## 用法

    python3 scripts/check-desktop-release.py [--assert] [--min-platforms 7]

退出码：0 = 有读数且一致 / 1 = 不一致或低于阈值（--assert 时）/ 2 = 读不到 feed（**没读数 ≠ 没问题**）
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

FEED = "https://anet.sh/desktop/update/latest.json"


def main() -> int:
    min_platforms = 7
    if "--min-platforms" in sys.argv:
        min_platforms = int(sys.argv[sys.argv.index("--min-platforms") + 1])

    try:
        # 必须跟随跳转：不跟的话拿到的是 307 的 "Redirecting..." 页面，
        # 会被误判成「端点不存在」（2026-11-05 我自己就差点这么写）。
        with urllib.request.urlopen(FEED, timeout=20) as resp:
            raw = resp.read()
            status = resp.status
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        print(f"✗ 读不到 {FEED}：{exc}", file=sys.stderr)
        print("  ⇒ 这是「没有读数」，不是「没有问题」", file=sys.stderr)
        return 2

    try:
        feed = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"✗ feed 不是 JSON（HTTP {status}，{len(raw)} 字节）：{exc}", file=sys.stderr)
        return 2

    version = feed.get("version")
    platforms = feed.get("platforms") or {}
    if not version or not isinstance(platforms, dict) or not platforms:
        print(f"✗ feed 形状不对：version={version!r} platforms={type(platforms).__name__}", file=sys.stderr)
        return 2

    print(f"feed: {FEED}（HTTP {status}，{len(raw)} 字节）")
    print(f"version: {version} · platforms: {len(platforms)}")

    mismatched = []
    for name, meta in sorted(platforms.items()):
        url = (meta or {}).get("url") if isinstance(meta, dict) else None
        ok = isinstance(url, str) and version in url
        print(f"  {'✓' if ok else '✗'} {name:<26} {str(url)[:96]}")
        if not ok:
            mismatched.append(name)

    print("  mutates: none（只读）")

    problems = []
    if mismatched:
        problems.append(f"{len(mismatched)} 个平台的 URL 不含版本 {version}：{', '.join(mismatched)}")
    if len(platforms) < min_platforms:
        problems.append(f"平台数 {len(platforms)} < 阈值 {min_platforms}")

    if problems:
        for p in problems:
            print(f"✗ {p}", file=sys.stderr)
        return 1 if "--assert" in sys.argv else 0
    print(f"✓ 一致：{version} · {len(platforms)} 平台 · url 全部指向同一版")
    return 0


if __name__ == "__main__":
    sys.exit(main())
