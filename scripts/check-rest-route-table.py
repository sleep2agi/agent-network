#!/usr/bin/env python3
"""`docs/rest-route-table.json` 的**消费者**：它必须等于「现在重新生成一次」的结果。

2026-10-31 —— 为什么需要：生成物自己写着「重跑后不一致 ⇒ 本文档过期」，
但没有任何东西去重跑。⇒ 一份生成物的唯一风险不是它错，是它**停在过去某一天**，
而它读起来和今天一样。

口径：
  重新跑 `scripts/report-rest-endpoints.py --table-json`，与仓库里的文件逐字节比。
  不一致 ⇒ 红，并打印**差在哪**（行数、增删的 path、order 变化）。
  与 source 的 ref 不一致但内容相同（只有 provenance 里的 ref 变了）⇒ 也只报这一格，
  因为那说明「源码没动，只是换了提交」——仍然要更新，否则 ref 是假的。

用法：python3 scripts/check-rest-route-table.py [--update]
退出码：0 = 一致；1 = 过期；2 = 拿不到读数（生成器失败）。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GEN = REPO / "scripts" / "report-rest-endpoints.py"
DATAFILE = REPO / "docs" / "rest-route-table.json"


def generate() -> str | None:
    try:
        res = subprocess.run([sys.executable, str(GEN), "--table-json"],
                             cwd=REPO, capture_output=True, text=True, timeout=120)
    except Exception as exc:  # noqa: BLE001
        print(f"✗ 生成器跑不起来：{exc}", file=sys.stderr)
        return None
    if res.returncode != 0:
        print(f"✗ 生成器 exit={res.returncode}", file=sys.stderr)
        print(res.stderr[:400], file=sys.stderr)
        return None
    try:
        json.loads(res.stdout)
    except Exception:  # noqa: BLE001
        print("✗ 生成器 stdout 不是 JSON", file=sys.stderr)
        return None
    return res.stdout


def main() -> int:
    fresh = generate()
    if fresh is None:
        return 2
    if "--update" in sys.argv:
        DATAFILE.write_text(fresh, encoding="utf-8")
        print(f"✓ 已写入 {DATAFILE.relative_to(REPO)}")
        # 2026-10-31 —— **证据列加一格：这次执行有没有改动被观测对象**。
        # 「可重跑」不等于「幂等」：带 --update 的这一次**改变了仓库内容**，
        # 于是它与上一次「只比较」的读数描述的不是同一个对象。
        print(f"  mutates_subject: YES（写入 {DATAFILE.relative_to(REPO)}；"
              f"下一次比较的基线已被这次执行改变）")
        return 0
    if not DATAFILE.exists():
        print(f"✗ 缺 {DATAFILE.relative_to(REPO)}；先跑 --update", file=sys.stderr)
        return 1
    committed = DATAFILE.read_text(encoding="utf-8")
    if committed == fresh:
        n = len(json.loads(fresh)["rows"])
        print(f"✓ 路由表草稿与源码一致（{n} 行）")
        print("  mutates_subject: no（只读比较；本次执行未改变被观测文件）")
        print("  check: 重跑本脚本；源码里新增/移动一条匹配 ⇒ 这里会红，直到 --update。")
        return 0

    # 差在哪：行数与增删的 path
    try:
        a = json.loads(committed)
        b = json.loads(fresh)
    except Exception:  # noqa: BLE001
        print("✗ 有一侧不是合法 JSON ⇒ 无法给出差异，只能说过期", file=sys.stderr)
        return 1
    ra = {(r["path"], r.get("method"), tuple(r.get("query") or []), r["line"]) for r in a.get("rows", [])}
    rb = {(r["path"], r.get("method"), tuple(r.get("query") or []), r["line"]) for r in b.get("rows", [])}
    gone, new = sorted(ra - rb), sorted(rb - ra)
    print("  mutates_subject: no（只读比较；未写入任何文件）")
    print(f"✗ 路由表草稿**已过期**：文件 {len(a.get('rows', []))} 行 / 现在 {len(b.get('rows', []))} 行", file=sys.stderr)
    for g in gone[:5]:
        print(f"    文件里有、源码里没有：{g}", file=sys.stderr)
    for n in new[:5]:
        print(f"    源码里有、文件里没有：{n}", file=sys.stderr)
    if a.get("provenance") != b.get("provenance"):
        print(f"    provenance 也变了：{a.get('provenance', [None])[0]} → {b.get('provenance', [None])[0]}", file=sys.stderr)
    print("  ⇒ python3 scripts/check-rest-route-table.py --update", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
