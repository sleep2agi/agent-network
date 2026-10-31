#!/usr/bin/env python3
"""「更具体的判别必须排在通用分支之前」——一条**可从源码算出**的顺序不变量。

2026-10-31 —— 背景（#3214）：
  `/api/messages` 出现两次：`:5581` 是 `?scope=user`，`:5648` 是通用分支。
  这类「同一 path、不同判别」的分支里，**顺序承载语义**：
  若通用分支被挪到前面，带 `?scope=user` 的请求会被通用分支吃掉，
  而响应形状仍然是一个合法的 200 —— 于是「行为变了」与「行为没变」在测试里往往同形。

不变量（本脚本检查的就是它）：
  对同一个 path，任何**带 query 判别**的匹配行，其行号必须小于该 path 下**不带 query** 的匹配行。
  没有 query 判别的同 path 行之间不约束（它们通常靠 method 区分）。

这是静态不变量，不替代行为测试；它挡的是「重构时顺手排序」这一类改动。

用法：python3 scripts/check-rest-route-order.py [--json]
退出码：0 = 不变量成立；1 = 违反；2 = 拿不到读数（生成器失败）。
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GEN = REPO / "scripts" / "report-rest-endpoints.py"


def load() -> dict | None:
    try:
        res = subprocess.run([sys.executable, str(GEN), "--table-json"],
                             cwd=REPO, capture_output=True, text=True, timeout=120)
    except Exception as exc:  # noqa: BLE001
        print(f"✗ 生成器跑不起来：{exc}", file=sys.stderr)
        return None
    if res.returncode != 0:
        print(f"✗ 生成器 exit={res.returncode}", file=sys.stderr)
        return None
    try:
        return json.loads(res.stdout)
    except Exception:  # noqa: BLE001
        print("✗ 生成器 stdout 不是 JSON", file=sys.stderr)
        return None


# 2026-10-31 —— 光有「若存在则必须在前」是不够的：
# 把判别**去掉**（改键名/改条件）也会让它跳过检查，而跳过与成立同形。
# ⇒ 把「哪些 path 应该有 query 判别」也钉住；少一个就红。
EXPECTED_DISCRIMINATED: dict[str, str] = {
    "/api/messages": "scope",
}


def main() -> int:
    doc = load()
    if doc is None:
        return 2
    rows = doc.get("rows") or []
    if not rows:
        print("✗ 没有行 ⇒ 没有读数", file=sys.stderr)
        return 2

    by_path: dict[str, list[dict]] = {}
    for r in rows:
        by_path.setdefault(r["path"], []).append(r)

    # 判别消失 = 静默跳过 ⇒ 先查这一格
    missing = []
    for path, key in EXPECTED_DISCRIMINATED.items():
        got = [r for r in by_path.get(path, []) if key in (r.get("query") or [])]
        if not got:
            missing.append((path, key))

    violations = []
    checked = 0
    for path, items in by_path.items():
        with_q = [i for i in items if i.get("query")]
        without_q = [i for i in items if not i.get("query")]
        if not with_q or not without_q:
            continue
        checked += 1
        latest_specific = max(i["line"] for i in with_q)
        earliest_generic = min(i["line"] for i in without_q)
        if latest_specific > earliest_generic:
            violations.append({
                "path": path,
                "specific_line": latest_specific,
                "generic_line": earliest_generic,
            })

    if missing:
        print("✗ 这些 path 的 query 判别**不见了**（被改名/改条件/删掉）——", file=sys.stderr)
        for path, key in missing:
            print(f"    · {path} 期望有 `{key}` 判别，实际没有", file=sys.stderr)
        print("  ⇒ 判别消失会让「顺序」这条不变量静默跳过，而跳过与成立同形。", file=sys.stderr)
        return 1

    # 2026-10-31 —— 反向：**代码里有判别组，而登记表是空的** ⇒ 这不是「不适用」，是「登记丢了」。
    # 两者处置相反：「不适用」要换测试，「登记丢了」要补登记。
    if checked > 0 and not EXPECTED_DISCRIMINATED:
        print(f"✗ 代码里有 {checked} 个判别组，但 EXPECTED_DISCRIMINATED 是空的 ⇒ "
              f"登记表被清空/漏登记（不是「不适用」）", file=sys.stderr)
        for path in sorted(by_path):
            with_q = [r for r in by_path[path] if r.get("query")]
            if with_q:
                print(f"    · {path}（判别键：{sorted({k for r in with_q for k in (r.get('query') or [])})}）", file=sys.stderr)
        print("  ⇒ 把它们加回 EXPECTED_DISCRIMINATED；否则这条不变量会在没人注意时失去约束。", file=sys.stderr)
        return 1

    if checked == 0 and not EXPECTED_DISCRIMINATED:
        # 2026-10-31 —— **「不适用」不能渲染成「通过」**（外部复核：verdict 至少四值
        # pass / fail / unknown / not-applicable；「不适用」要换测试，「不可判」要补读数，处置相反）。
        # 本门：一个「同 path 既有 query 判别又有通用分支」的组都没有 ⇒ 这条不变量无处可验。
        print("not-applicable：没有任何『同 path、既有 query 判别又有通用分支』的组 ⇒ "
              "本判据在当前代码上不适用（不是通过，也不是失败）", file=sys.stderr)
        print("  ⇒ 若确实新增了这类组，请同时把它加进 EXPECTED_DISCRIMINATED。", file=sys.stderr)
        return 3

    if "--json" in sys.argv:
        print(json.dumps({"checked_paths": checked, "violations": violations}, ensure_ascii=False, indent=2))
        return 1 if violations else 0

    print(f"顺序不变量：检查了 {checked} 个『同 path、既有 query 判别又有通用分支』的路径")
    if violations:
        print("✗ 有判别被排到了通用分支之后 ⇒ 带 query 的请求会被通用分支吃掉：", file=sys.stderr)
        for v in violations:
            print(f"    · {v['path']}：判别在 :{v['specific_line']}，通用在 :{v['generic_line']}", file=sys.stderr)
        print("  ⇒ 把带 query 的那条挪回前面；改完必须重跑 server 的 HTTP 测试。", file=sys.stderr)
        return 1
    print("✓ 不变量成立：所有带 query 判别的分支都排在通用分支之前")
    print("  check : 重跑本脚本；有人重排这两行 ⇒ 这里会红。")
    print("  局限  : 这是**静态**不变量，不证明运行时行为正确；它挡的是『重构时顺手排序』。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
