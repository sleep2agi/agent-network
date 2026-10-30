#!/usr/bin/env python3
"""每个 workflow 到底会不会自己跑起来 —— 「可触发」是三态，不是布尔。

2026-10-31 —— 起因（来自一次外部复核，原文）：
    对方把某个门写成「可触发（未接入 CI）」，
    而实际情况是：ci.yml 存在、也跑测试，但文件头写着 `on: workflow_dispatch`
    ⇒ **不再自动触发**。所以一句「未接入 CI」是错的，正解是三态：

        自动（push / pull_request / schedule / workflow_run）
        手动（只有 workflow_dispatch）
        不跑（没有 on:，或已被禁用）

    而「手动」这一态最危险：**它看起来在保护我们，实际只在有人记得点时保护我们。**

用法：
    python3 scripts/report-workflow-triggers.py            # 打印三态清单
    python3 scripts/report-workflow-triggers.py --assert   # 门类 workflow 不许只手动

为什么要有 --assert：
    名字里带 gate / qa / check 的 workflow，如果只在手动触发，
    那它就是「一个不会自己响的门」。允许少数例外（要真机、要花钱），
    但例外必须写在下面的 ALLOWLIST 里并写明理由 —— 否则它只是被忘了。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
WF = REPO / ".github" / "workflows"

AUTO = re.compile(r"\b(push|pull_request|pull_request_target|schedule|release|workflow_run|merge_group)\b")
GATE_NAME = re.compile(r"(gate|qa|check)", re.I)

# 例外：名字像门、但确实只能手动。**必须写理由**，否则下一个人不知道它是故意的还是忘了。
ALLOWLIST = {
    "windows-real-codex-gate.yml": "需要一台真 Windows 机器与真实 codex 登录，成本与可用性都不允许自动跑",
}


def triggers(text: str) -> tuple[str, str]:
    """→ (state, detail)。state ∈ {"auto", "manual", "none"}。"""
    m = re.search(r"^on:\s*(.*)$", text, re.M)
    if not m:
        return "none", "没有 on:"
    inline = m.group(1).strip()
    block = text[m.start(): m.start() + 600]
    if AUTO.search(inline) or AUTO.search(block.split("jobs:")[0]):
        found = sorted(set(AUTO.findall(inline) or AUTO.findall(block.split("jobs:")[0])))
        return "auto", ",".join(found)
    if "workflow_dispatch" in block:
        return "manual", "workflow_dispatch"
    return "none", "未识别的触发条件"


def main() -> int:
    if not WF.is_dir():
        print(f"✗ 找不到 {WF}", file=sys.stderr)
        return 2

    buckets: dict[str, list[tuple[str, str]]] = {"auto": [], "manual": [], "none": []}
    for path in sorted(WF.glob("*.yml")):
        state, detail = triggers(path.read_text(encoding="utf-8", errors="replace"))
        buckets[state].append((path.name, detail))

    for state, label in (("auto", "自动"), ("manual", "**只手动**"), ("none", "不跑 / 未识别")):
        rows = buckets[state]
        print(f"{label}：{len(rows)}")
        if state != "auto":
            for name, detail in rows:
                print(f"  {name}  （{detail}）")
    total = sum(len(v) for v in buckets.values())
    print(f"\n合计 {total} 个 workflow")

    flagged = [
        (name, detail) for name, detail in buckets["manual"] + buckets["none"]
        if GATE_NAME.search(name) and name not in ALLOWLIST
    ]
    if flagged:
        print("\n✗ 名字像门、但不会自己跑：", file=sys.stderr)
        for name, detail in flagged:
            print(f"    {name}  （{detail}）", file=sys.stderr)
        print("  ⇒ 要么给它加自动触发，要么写进 ALLOWLIST 并说明理由。", file=sys.stderr)
        if "--assert" in sys.argv:
            return 1

    for name, reason in sorted(ALLOWLIST.items()):
        print(f"\n· 例外：{name} —— {reason}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
