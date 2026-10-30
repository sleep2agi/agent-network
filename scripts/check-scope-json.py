#!/usr/bin/env python3
"""SCOPE JSON 的**自动消费者** —— 让 `--json` 不只是「能读」，而是「有人在读」。

2026-10-31 —— 起因（外部复核两条，同一条的两个方向）：
    「一个可引用的读数要四件：测的什么、用的哪把尺、尺子在什么环境里、谁在用它」
    「consumers 为空时要读作『我们不知道有没有人用』，不是『没人用』」

上一轮我给 check-keyset-join.py 加了 `--json`，但 consumers 那一栏只写了人。
⇒ 一个只为「人读」存在的 JSON，与散文的差别只剩格式：它照样可以被悄悄改坏而无人发现。

这个脚本就是那个消费者。它做三件事：
    ① 结构：必需键都在（缺就红）
    ② 归属：measured_by 的 script/sha/env 三项都在（缺 env ⇒ 读数只能读不能引）
    ③ 寿命：invalidates_on 每项都有 (id, type, check)，type 在封闭集合里

用法：python3 scripts/check-scope-json.py [--json]
退出码：0 = 全部满足；1 = 有缺口；2 = 被消费者自己跑不起来（拿不到 JSON）。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PRODUCER = REPO / "scripts" / "check-keyset-join.py"

REQUIRED = [
    "instrument", "gate_state", "counts", "covers", "does_not_cover",
    "scan_domain", "measured_on", "measured_by", "invalidates_on", "consumers",
]
INVALIDATE_TYPES = {"ref_dirty", "behavior", "domain"}


def load() -> dict | None:
    try:
        res = subprocess.run(
            [sys.executable, str(PRODUCER), "--json"],
            cwd=REPO, capture_output=True, text=True, timeout=180,
        )
    except Exception as exc:  # noqa: BLE001
        print(f"✗ 跑不起生产者：{exc}", file=sys.stderr)
        return None
    # 2 = 生产者自己说「没有读数」⇒ 消费者也必须说没有，不许把空当成合规
    if res.returncode not in (0, 1):
        print(f"✗ 生产者 exit={res.returncode}（2 = 没有读数）⇒ 消费者不读", file=sys.stderr)
        return None
    try:
        return json.loads(res.stdout)
    except Exception:  # noqa: BLE001
        print("✗ 生产者的 stdout 不是 JSON（有人在里面 print 了散文）", file=sys.stderr)
        print(res.stdout[:400], file=sys.stderr)
        return None


def check(doc: dict) -> list[str]:
    gaps: list[str] = []
    for k in REQUIRED:
        if k not in doc:
            gaps.append(f"缺键 {k}")

    mb = doc.get("measured_by") or {}
    for k in ("script", "sha256_12", "env"):
        if not mb.get(k):
            gaps.append(f"measured_by.{k} 为空 ⇒ 这个读数只能读，不能引")
    env = mb.get("env") or {}
    for k in ("python", "os"):
        if not env.get(k):
            gaps.append(f"measured_by.env.{k} 为空 ⇒ 尺子不止是代码")

    inv = doc.get("invalidates_on")
    if not isinstance(inv, list) or not inv:
        gaps.append("invalidates_on 为空 ⇒ 读者无法判断读数是否仍有效")
    else:
        for item in inv:
            for k in ("id", "type", "check"):
                if not item.get(k):
                    gaps.append(f"invalidates_on[{item.get('id', '?')}].{k} 为空")
            if item.get("type") and item["type"] not in INVALIDATE_TYPES:
                gaps.append(f"invalidates_on[{item.get('id', '?')}].type 不在封闭集合：{item['type']}")

    cons = doc.get("consumers")
    if not cons:
        gaps.append("consumers 为空 ⇒ 按口径这是「不知道有没有人用」，不是「没人用」")

    dom = doc.get("scan_domain") or {}
    if not dom:
        gaps.append("scan_domain 为空 ⇒ 「0 处」会被读成「全仓没有」")

    counts = doc.get("counts") or {}
    if "scanned_files" in counts and counts["scanned_files"] == 0:
        gaps.append("counts.scanned_files=0 ⇒ 扫描域空了，此时的「0 阻塞」不是结论")
    return gaps


def main() -> int:
    doc = load()
    if doc is None:
        return 2
    gaps = check(doc)
    if "--json" in sys.argv:
        print(json.dumps({
            "ok": not gaps,
            "gaps": gaps,
            "consumer": Path(__file__).name,
            "reads": str(PRODUCER.relative_to(REPO)),
        }, ensure_ascii=False, indent=2))
        return 1 if gaps else 0
    if gaps:
        print("✗ SCOPE JSON 有缺口（这个消费者不通过 ⇒ 那份 JSON 还不能被引用）：", file=sys.stderr)
        for g in gaps:
            print(f"    · {g}", file=sys.stderr)
        return 1
    print(f"✓ SCOPE JSON 自洽：{len(REQUIRED)} 个必需键齐；"
          f"measured_by 带 env={doc['measured_by']['env']}；"
          f"invalidates_on {len(doc['invalidates_on'])} 条；"
          f"consumers {len(doc['consumers'])} 个（含本脚本）")
    print("  check  : 重跑本脚本；若上述任一栏变空 ⇒ 红（这就是「有人在读」）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
