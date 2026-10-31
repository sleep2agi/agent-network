#!/usr/bin/env python3
"""`/health` 里哪些字段在**多次读数之间从不变化**，以及那份"不变"有没有被声明。

2026-10-31 起因（外部复核）：
    「一组在所有权重下同变的字段，是同一个读数被印了几遍。」
    他们那侧实测：`status` / `db` / `mineruProxy` 三条渲染同一个 `dbReady()` ⇒ 一致时零证据。

同一件事在载荷层面更容易测：**在 N 次读数里，哪些字段一个字节都没变。**
    · 变     ⇒ 它是活读数（不管它变得对不对）
    · 不变   ⇒ 它可能是常量、也可能是死读数 —— 两者在载荷上同形

所以本脚本把「不变」的两类分开：
    documented  —— `server/src/server.ts` 的 HEALTH_FIELD_META 里写了 `constant_by_design`（有理由）
    undocumented—— 没写理由却不变 ⇒ **值得看一眼**：它可能是忘了接线的读数

用法：
    python3 scripts/report-health-liveness.py                 # 打生产（http://127.0.0.1:9200）
    python3 scripts/report-health-liveness.py --url URL --samples 6 --interval 0.3
    python3 scripts/report-health-liveness.py --json

退出码：0 有读数；2 采样失败（**没有读数**，不是「全部不变」）。
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SERVER = REPO / "server" / "src" / "server.ts"


def documented_constants() -> set[str]:
    """从 HEALTH_FIELD_META 里读出「声明了 constant_by_design」的字段名。

    刻意用文本扫描而不是跑 TS：这个脚本要在没有 bun 的机器上也能读。
    扫不到就返回空集 —— 那会把所有常量都报成 undocumented（**偏保守的方向**：
    多报一次需要人看一眼，少报一次会让死读数永远藏着）。
    """
    try:
        src = SERVER.read_text(encoding="utf-8")
    except OSError:
        return set()
    start = src.find("export const HEALTH_FIELD_META")
    if start < 0:
        return set()
    end = src.find("\n};", start)
    block = src[start:end if end > 0 else len(src)]
    out: set[str] = set()
    # 逐个 `name: { … }` 粗切，块内出现 constant_by_design 才算
    for m in re.finditer(r"^\s{2}([a-z_][a-z0-9_]*):\s*\{", block, re.M):
        name = m.group(1)
        body_start = m.end()
        nxt = block.find("\n  ", body_start)
        body = block[body_start: nxt if nxt > 0 else len(block)]
        if "constant_by_design" in body:
            out.add(name)
    return out


def sample(url: str, samples: int, interval: float) -> list[dict] | None:
    got: list[dict] = []
    for i in range(samples):
        try:
            with urllib.request.urlopen(url, timeout=10) as r:
                got.append(json.loads(r.read().decode()))
        except Exception as exc:  # noqa: BLE001
            print(f"✗ 第 {i + 1} 次采样失败：{exc}", file=sys.stderr)
            return None
        if i + 1 < samples:
            time.sleep(interval)
    return got


def main(argv: list[str]) -> int:
    url = "http://127.0.0.1:9200/health"
    samples = 5
    interval = 0.3
    for i, a in enumerate(argv):
        if a == "--url" and i + 1 < len(argv):
            url = argv[i + 1]
        if a == "--samples" and i + 1 < len(argv):
            samples = max(2, int(argv[i + 1]))
        if a == "--interval" and i + 1 < len(argv):
            interval = float(argv[i + 1])

    got = sample(url, samples, interval)
    if not got:
        return 2                      # 没有读数 ≠ 全部不变
    keys = sorted(set().union(*[set(d) for d in got]))
    constant, varying = [], []
    for k in keys:
        vals = [json.dumps(d.get(k), sort_keys=True) for d in got]
        (constant if len(set(vals)) == 1 else varying).append(k)

    documented = documented_constants()
    undoc = [k for k in constant if k not in documented]
    res = {
        "instrument": "report-health-liveness",
        "evidence_domain": "wire",
        "url": url,
        "samples": samples,
        "counts": {"fields": len(keys), "constant": len(constant), "varying": len(varying),
                   "constant_documented": len(constant) - len(undoc), "constant_undocumented": len(undoc)},
        "constant_undocumented": undoc,
        "covers": "一眼 /health 载荷在 N 次读数里哪些字段从不变化",
        "does_not_cover": [
            "「不变」不等于「错」：常量可能是有意的",
            "只采匿名投影（带 token 的字段不在样本里）",
            "N 次采样之间若某项恰好没变（例如空闲期的计数），也会被算作不变 ⇒ 需人再看一眼",
        ],
    }
    if "--json" in argv:
        print(json.dumps(res, ensure_ascii=False, indent=2))
        return 0

    c = res["counts"]
    print(f"HEALTH-LIVENESS v1 url={url} samples={samples} fields={c['fields']} "
          f"constant={c['constant']} varying={c['varying']} "
          f"constant_undocumented={c['constant_undocumented']}")
    print("  ⚠ **首要读法**：空闲负载下，计数器本来就该不变 —— 那些「不变」不构成结论。")
    print("     要看结论，请在**有流量**时采（--samples 6 边跑边采），或只看下面这组：")
    print("     构造上是常量的字段（HEALTH_FIELD_META 里写了 constant_by_design）："
          + (", ".join(sorted(k for k in constant if k in documented)) or "（解析不到，见 stderr）"))
    if undoc:
        print("  不变且**没有** constant_by_design 声明的字段（空闲期它们也该不变 ⇒ 需在有流量时再看一眼）：")
        for k in undoc:
            print(f"    · {k}")
    print("  口径：只采匿名投影；「不变」不等于「错」——常量可能是有意的，也可能从没接过线。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
