r"""合并一个 PR 之前,把「可以合」这件事判成一次、判对一次。

🔴 为什么需要它(2026-08-18,同一天里两次)
==========================================

**① 我把轮询和合并写在同一个命令块里,轮询最后一行打印了 `readiness=FAILURE`,
   `gh pr merge` 照样执行了。** 结果是 dashboard 的 main 被我弄红。
   打印一个检查结果,不等于拿它当判据。

**② 我手写的那句 jq 判据把「进行中」算成了「失败」。**

       select(.conclusion != null and .conclusion != "SUCCESS" and …)

   `gh` 对**还在跑**的检查返回的是**空串 `""`,不是 `null`**:

       conclusion 取值分布: ['', 'SUCCESS']

   于是 `failing=1`,而那条检查其实只是 `IN_PROGRESS`。这次它朝安全方向错
   (误判成"别合"),**但同一个形状换个比较方向就会朝"可以合"错**。

两次的共同点:判据是**每次现场手打**的。所以这里把它固定下来,并且带自测。

判据(五条,缺一不可)
====================

  1. `baseRefName == main`      —— 🔴 漏掉这条,曾经让两个 PR 合进了一条特性分支
  2. `isDraft == false`
  3. 没有 pending —— `status != "COMPLETED"` 的检查数为 0
  4. 没有 failing —— 用**显式的坏值集合**,不用「不等于 SUCCESS」那种排除法
  5. 检查总数 > 0    —— 分母承重:0 个检查和 0 个失败,打印出来长得一样

🔴 关于 `mergeable`
===================

`mergeable` **不在上面五条里**,它是**单独一格**,而且要分清它说的是什么:

  - `MERGEABLE`  —— 「这一个 PR vs **当前 main**」合得上
  - `CONFLICTING`—— 合不上
  - `UNKNOWN`    —— **GitHub 还没算完**,不是「没问题」

实测(2026-08-18,本仓 9 个 open PR):`UNKNOWN` 底下**两种现实都有** ——
PR460 是 `UNKNOWN` 且真 merge 时 12 个文件硬冲突;而 825/812/808 也是 `UNKNOWN`,
真 merge 干净。**所以 `UNKNOWN` 只能作为"再等等"的信号,不能作为判据。**

还有一格谁也不管:**`MERGEABLE` 从不回答「这些 PR 彼此之间冲不冲突」。**
同一天实测:8 个 PR 各自对 main 都是 `MERGEABLE`,其中一对彼此冲突(双向)。
要知道那个,只能真合一遍 —— 本脚本**不做**,也不假装做。

用法
====

    python3 scripts/assert-pr-mergeable.py 970
    python3 scripts/assert-pr-mergeable.py 970 --repo sleep2agi/agent-network
    python3 scripts/assert-pr-mergeable.py --selftest

🔴 调用方注意:**不要让它的退出码穿过管道。**

    python3 scripts/assert-pr-mergeable.py 970 | tail; echo $?   ← 这个 $? 是 tail 的

正确写法:

    python3 scripts/assert-pr-mergeable.py 970 || exit 1
    python3 scripts/assert-pr-mergeable.py 970 >/dev/null 2>&1; rc=$?

退出码:0 五条全过且 mergeable==MERGEABLE / 1 至少一条不过 / 2 判不了(取不到数据)
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys

# 显式列出「坏」,不用「不是 SUCCESS 就是坏」——后者会把空串、NEUTRAL、SKIPPED
# 一起算进去,而那正是 2026-08-18 那次误判的来源。
BAD_CONCLUSIONS = {
    "FAILURE", "CANCELLED", "TIMED_OUT",
    "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE",
}
OK_CONCLUSIONS = {"SUCCESS", "NEUTRAL", "SKIPPED"}

FIELDS = "state,baseRefName,isDraft,mergeable,statusCheckRollup"


def judge(data: dict, expect_base: str = "main") -> tuple[list[str], list[str]]:
    """返回 (失败原因, 提示)。空的失败列表 = 可以合。"""
    bad: list[str] = []
    notes: list[str] = []

    # 🔴 先看 state。这一条是拿真 PR 试出来的:对一个**已经合过**的 PR,
    #   `mergeable` 变回 `UNKNOWN`,于是原来的判据会报「GitHub 还没算完」——
    #   一句正确但完全指错方向的话,读的人会去等一个永远不会来的结果。
    #   (新工具第一次的输出要对已知答案:我拿今天刚合掉的 #974 试,
    #    它就是这么答的,才发现少了这一格。)
    state = (data.get("state") or "").upper()
    if state and state != "OPEN":
        bad.append(f"PR 已经是 {state} 了 —— 不是「还没算完」,是没什么可合的")
        return bad, [f"state={state}"]

    base = data.get("baseRefName")
    if base != expect_base:
        bad.append(f"base 是 {base!r},不是 {expect_base!r} —— 合了会进错分支")

    if data.get("isDraft"):
        bad.append("还是 draft")

    rollup = data.get("statusCheckRollup") or []
    total = len(rollup)
    if total == 0:
        # 分母承重:一个检查都没有时,"0 个失败"是真话但毫无信息。
        bad.append("一个检查都没有 —— 「0 个失败」在这里不构成证据")
    pending = [c for c in rollup if (c.get("status") or "") != "COMPLETED"]
    if pending:
        bad.append(f"{len(pending)} 个检查还没跑完:" + ", ".join(
            str(c.get("name")) for c in pending[:5]))

    failing = [c for c in rollup if (c.get("conclusion") or "") in BAD_CONCLUSIONS]
    if failing:
        bad.append(f"{len(failing)} 个检查失败:" + ", ".join(
            f"{c.get('name')}({c.get('conclusion')})" for c in failing[:5]))

    # 既不是坏也不是已知的好 —— 例如新加的结论值。报出来但不当判据,
    # 免得一个未知取值默默变成"通过"。
    unknown = [c for c in rollup
               if (c.get("status") or "") == "COMPLETED"
               and (c.get("conclusion") or "") not in BAD_CONCLUSIONS | OK_CONCLUSIONS]
    if unknown:
        notes.append("有检查带着本脚本不认识的 conclusion(未计入判据):" + ", ".join(
            f"{c.get('name')}={c.get('conclusion')!r}" for c in unknown[:5]))

    m = data.get("mergeable")
    if m == "UNKNOWN":
        bad.append("mergeable=UNKNOWN —— GitHub 还没算完,这不是「没问题」")
    elif m != "MERGEABLE":
        bad.append(f"mergeable={m}")

    notes.append(f"检查 {total} 个 · pending {len(pending)} · failing {len(failing)}")
    return bad, notes


def fetch(pr: str, repo: str | None) -> dict:
    cmd = ["gh", "pr", "view", pr, "--json", FIELDS]
    if repo:
        cmd += ["--repo", repo]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        print(f"::error::取不到 PR 数据: {out.stderr.strip()[:200]}", file=sys.stderr)
        raise SystemExit(2)
    return json.loads(out.stdout)


def selftest() -> int:
    cases = []

    def check(name, data, want_ok, base="main"):
        bad, _ = judge(data, base)
        ok = (len(bad) == 0) == want_ok
        cases.append((name, ok, f"bad={bad}"))

    good = {
        "state": "OPEN", "baseRefName": "main", "isDraft": False, "mergeable": "MERGEABLE",
        "statusCheckRollup": [{"name": "a", "status": "COMPLETED", "conclusion": "SUCCESS"}],
    }
    check("🔴 正控:全都对 → 可以合", good, True)

    # 🔴 这一条就是 2026-08-18 那次误判:进行中的检查 conclusion 是空串不是 null
    running = dict(good, statusCheckRollup=[
        {"name": "a", "status": "COMPLETED", "conclusion": "SUCCESS"},
        {"name": "e2e", "status": "IN_PROGRESS", "conclusion": ""},
    ])
    bad, _ = judge(running)
    cases.append(("进行中的空串 conclusion 算 pending，不算 failing",
                  any("还没跑完" in b for b in bad) and not any("失败" in b for b in bad),
                  f"bad={bad}"))

    check("真失败 → 拦下", dict(good, statusCheckRollup=[
        {"name": "x", "status": "COMPLETED", "conclusion": "FAILURE"}]), False)
    check("NEUTRAL/SKIPPED 不算失败", dict(good, statusCheckRollup=[
        {"name": "x", "status": "COMPLETED", "conclusion": "NEUTRAL"},
        {"name": "y", "status": "COMPLETED", "conclusion": "SKIPPED"}]), True)
    check("draft → 拦下", dict(good, isDraft=True), False)
    check("base 不是 main → 拦下", dict(good, baseRefName="feature/x"), False)
    check("🔴 UNKNOWN 不是「没问题」→ 拦下", dict(good, mergeable="UNKNOWN"), False)
    check("CONFLICTING → 拦下", dict(good, mergeable="CONFLICTING"), False)
    check("🔴 分母：一个检查都没有 → 拦下", dict(good, statusCheckRollup=[]), False)

    _b, notes = judge(dict(good, statusCheckRollup=[
        {"name": "z", "status": "COMPLETED", "conclusion": "WEIRD_NEW_VALUE"}]))
    cases.append(("未知 conclusion 会被报出来（不静默当通过）",
                  any("不认识" in n for n in notes), f"notes={notes}"))

    check("已 MERGED → 拦下且说清是 merged", dict(good, state="MERGED"), False)
    # 🔴 这条断言我第一版写错了,而且错法本身值得留着:我判的是
    #   `not any("还没算完" in x)` —— 而 MERGED 那句话里**恰好也带着这四个字**
    #   (它在解释"不是还没算完")。于是断言被自己要判的那句话骗了,报了假 FAIL。
    #   **校验串不能包含被检文本里会出现的措辞。** 改成钉那个只属于 UNKNOWN
    #   分支的独有串。
    b2, _ = judge(dict(good, state="MERGED", mergeable="UNKNOWN"))
    cases.append(("已 MERGED 时不要走 mergeable=UNKNOWN 那条路",
                  any("MERGED" in x for x in b2)
                  and not any("mergeable=UNKNOWN" in x for x in b2),
                  f"bad={b2}"))

    for name, ok, detail in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"   [{detail}]" if not ok else ""))
    nbad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - nbad}/{len(cases)} ok")
    return 1 if nbad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pr", nargs="?")
    ap.add_argument("--repo")
    ap.add_argument("--base", default="main")
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not args.pr:
        print("用法: python3 scripts/assert-pr-mergeable.py <pr> [--repo o/n]", file=sys.stderr)
        return 2
    data = fetch(args.pr, args.repo)
    bad, notes = judge(data, args.base)
    for n in notes:
        print(f"  {n}")
    if bad:
        print(f"\n不能合 PR#{args.pr}:", file=sys.stderr)
        for b in bad:
            print(f"  - {b}", file=sys.stderr)
        return 1
    print(f"OK: PR#{args.pr} 五条判据全过,mergeable=MERGEABLE。")
    print("注意:这只说明它对**当前 main** 合得上。它和别的 open PR 冲不冲突,")
    print("      没有任何 GitHub 字段能回答 —— 那要真合一遍。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
