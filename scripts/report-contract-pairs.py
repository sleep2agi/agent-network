#!/usr/bin/env python3
"""同名契约文件在两处实现时，**容错方向**是否相反。

2026-10-31 —— 起因（外部复核，原话）：
    「同一个契约有两份实现、容错方向相反、两边测试都绿 ——
      服务端的宽松路径产出的形状正好是客户端 exact-keyset 必拒的形状。」

这类缺陷的特征是：两边都「对」，只是对的是不同的东西。
它不会红，因为每一边的测试都在测自己那一侧的行为。

本脚本只能查**可静态看见的那一半**：字面同名的文件里，宽松标记（`.catch(`、`.optional()`、
`??`、`||`）与严格标记（`.strict()`、`z.literal(`、`exact`）的**方向差**。

它不能查：语义上同名但文件不同名的实现、跨语言实现、运行期才合并的契约。
⇒ 所以它是读数，不是门：报「哪几对同名文件在容错方向上不一致」，
   判断哪一侧才是契约的那一侧，需要人（或一张卡）。

用法：python3 scripts/report-contract-pairs.py [--json]
退出码：0 总是（读数脚本）；2 = 扫描域为空（没有读数）。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GROUPS = {
    "server": REPO / "server" / "src",
    "agent-node": REPO / "agent-node" / "src",
    "agent-network": REPO / "agent-network" / "src",
}
LENIENT = (
    (".catch(", re.compile(r"\.catch\(")),
    (".optional()", re.compile(r"\.optional\(\s*\)")),
    ("??(空值合并)", re.compile(r"\?\?")),
)
STRICT = (
    (".strict()", re.compile(r"\.strict\(\)")),
    ("z.literal(", re.compile(r"z\.literal\(")),
    ("exact 键集", re.compile(r"EXACT|exact_keyset|exactKeySet")),
)


def scan(path: Path) -> dict[str, int]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return {}
    out: dict[str, int] = {}
    for name, rx in LENIENT:
        n = len(rx.findall(text))
        if n:
            out[f"lenient:{name}"] = n
    for name, rx in STRICT:
        n = len(rx.findall(text))
        if n:
            out[f"strict:{name}"] = n
    return out


def main() -> int:
    files: dict[str, dict[str, Path]] = {}
    for group, root in GROUPS.items():
        if not root.is_dir():
            continue
        for p in root.rglob("*.ts"):
            if p.name.endswith(".test.ts"):
                continue
            files.setdefault(p.name, {})[group] = p

    shared = {name: side for name, side in files.items() if len(side) >= 2}
    if not shared:
        print("扫描域为空：没有任何同名契约文件 ⇒ 没有读数（不是「一致」）", file=sys.stderr)
        return 2

    rows = []
    for name, side in sorted(shared.items()):
        marks = {group: scan(p) for group, p in side.items()}
        tot = {g: sum(v for k, v in m.items() if k.startswith("lenient:")) for g, m in marks.items()}
        st = {g: sum(v for k, v in m.items() if k.startswith("strict:")) for g, m in marks.items()}
        groups = sorted(marks)
        # 方向差：一侧宽松标记多、另一侧严格标记多
        opposite = any(
            (tot[a] > tot[b] and st[b] > st[a]) or (tot[b] > tot[a] and st[a] > st[b])
            for i, a in enumerate(groups) for b in groups[i + 1:]
        )
        rows.append({
            "file": name,
            "sides": groups,
            "lenient": tot,
            "strict": st,
            "opposite_direction": opposite,
            "detail": marks,
        })

    if "--json" in sys.argv:
        print(json.dumps({"pairs": rows, "object": "basename-matched .ts（不含 *.test.ts）"}, ensure_ascii=False, indent=2))
        return 0

    print("同名契约文件（basename 相同、非测试）—— 只查**可静态看见的**容错方向")
    print(f"对象：server/src · agent-node/src · agent-network/src（不含 *.test.ts）⇒ 共 {len(rows)} 对/组")
    print()
    print("| 文件 | 侧 | 宽松标记 | 严格标记 | 方向相反 |")
    print("|---|---|---|---|---|")
    for r in rows:
        for g in r["sides"]:
            print(f"| {r['file']} | {g} | {r['lenient'][g]} | {r['strict'][g]} | "
                  f"{'⚠️ 是' if r['opposite_direction'] else '—'} |")
    opp = [r for r in rows if r["opposite_direction"]]
    print()
    print(f"⇒ 方向相反的共 {len(opp)} 组：{[r['file'] for r in opp] or '（无）'}")
    print("⚠️ 这不是判据：同名的两侧**不一定是同一个契约**（也可能是两个各自独立的模块同名）。")
    print("   已知假阳（2026-10-31 人工核过）：opencode-v2-catalog.ts")
    print("     server 侧 = zod 快照 schema（strict/literal）；agent-node 侧 = 读端点目录（JSON.parse + ?? 默认值）")
    print("     ⇒ 两个不同契约同名，不是「容错方向相反」的那一类。")
    print("   要判定「哪一侧是契约的那一侧」，必须再读一次调用方 —— 本脚本没有那个能力。")
    print("check  : 重跑本脚本；新增同名文件会出现在表里，方向差也要显式看一眼。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
