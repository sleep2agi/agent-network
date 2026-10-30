#!/usr/bin/env python3
"""每个脚本都要回答一句：「它不跑的时候，谁会发现？」

2026-10-31 —— 起因（外部复核）：
    抹 Accept-Encoding ⇒ 乱码 ⇒ 用户喊
    抹 Origin          ⇒ 串权限 ⇒ 无人喊
    ⇒ 「不会喊」的缺陷只能靠「有人主动去查」发现，
      而主动去查在排期上永远排在一切有告警的事项之后
      ⇒ 于是它以「从未发生」的形式在记录里消失。

    判据：一个缺陷的严重度等于「它被发现的速度」的倒数；
          而没有通道的缺陷，那个速度是 0 —— 不是很小，是 0。

    同一条判据对**门本身**成立：一个写好了但从没被任何东西调用的门，
    它的失效速度也是 0。`check-script-references.py` 证的是反方向
    （引用了的东西存在），这个脚本证的是正方向（存在的东西有人跑）。

口径（三档，必须落在其中一档）：
    CI      被 .github/workflows/*.yml 或 scripts/qa.sh 调用  ⇒ 有人替你发现
    DOC     被文档/技能/包脚本引用（“去跑 X”）               ⇒ 由那句指令的人发现
    ADHOC   谁都不引用                                       ⇒ **必须在这里登记**：为什么不需要，
                                                                 以及由谁在什么时候发现它烂了

用法：
    python3 scripts/report-script-cadence.py            # 报告
    python3 scripts/report-script-cadence.py --assert   # ADHOC 未登记 ⇒ 退出码 1
退出码：0 = 全部归位；1 = 有未登记的 ADHOC（或登记项已失效）。
"""
from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "scripts"
SELF = "report-script-cadence.py"

# 只在 CI/QA 里出现的引用才算「有人跑」——文档里的引用只证明有人在某个时刻叫人跑过。
AUTO_FILES = [REPO / "scripts" / "qa.sh", REPO / "package.json"]
AUTO_GLOBS = [".github/workflows/*.yml", ".github/workflows/*.yaml"]
DOC_GLOBS = ["docs/**/*.md", "docs-site/**/*.md", "skills/**/*.md", "README.md", "AGENTS.md"]

# ADHOC 登记表：一次性/人肉工具放这里。**必须**有「谁会发现它烂了」与「什么时候可以删掉这一行」。
# 空字典是合法的 —— 但它同时意味着「本仓没有一次性工具」。新增一条就是一次显式决定。
ADHOC: dict[str, tuple[str, str]] = {
    'report-reason-branches.py': (
        "按需读「reason 被当 code 分支」的清单 + 冻结基线；棘轮由 --assert 承担，未接线到 CI",
        "把 --assert 接进 test-inventory.yml 后删除本行",
    ),
    'report-contract-pairs.py': (
        "按需读一次「同名契约两侧容错方向」的清单；它明确不是判据（同名的两侧可能不是同一个契约）",
        "并入 check-keyset-join.py 的 --json 消费者后删除本行",
    ),
    'assert-pr-mergeable.py': (
        '人工在合 PR 前跑；它问的是 GitHub 的实时状态，CI 里没法代替',
        '合 PR 流程改成 gh pr merge 自动检查后删除本行',
    ),
    'assert-scan-ref.sh': (
        '对一个 ref 做扫描断言；由人指定 ref，CI 里没有该 ref',
        '并入 check-*.py 的 --ref 参数后删除本行',
    ),
    'check-pair-published.test.mjs': (
        'check-pair-published.mjs 的单测；由 bun test 直接发现',
        '随该脚本一起删除',
    ),
    'npm-release-probe.mjs': (
        '发版探测；需要 npm 凭据',
        '发布流水线自带探测后删除本行',
    ),
    'qa-suite-coverage.py': (
        '报告 L1 套件覆盖面；读数用',
        '覆盖面并入 CI 报告后删除本行',
    ),
    'release-backlog.mjs': (
        '发版待办读取；人读',
        '并入发布看板后删除本行',
    ),
    'report-code-producers.py': (
        '读「谁写这个字段」的静态报告；读数用',
        '并入 check-keyset-join.py 的来源分析后删除本行',
    ),
    'report-mcp-key-set-coverage.py': (
        '按需读覆盖率报告；它是读数不是门，红绿由 check-keyset-join.py 承担',
        '键集覆盖率到 100% 或被并入 check-keyset-join.py 后删除本行',
    ),
    'report-node-versions.py': (
        '读生产节点版本分布；需要 HOME=/home/vansin 与真实库，CI 里跑不了',
        '节点全部升到同一版本后删除本行',
    ),
    'report-process-artifact-drift.py': (
        '读进程与制品的版本漂移；需要本机真实进程，CI 里跑不了',
        '有了遥测端的制品身份自报（#3177）后删除本行',
    ),
    'report-table-driven-nonempty.py': (
        '表驱动用例的非空检查；读数用，尚未升为门',
        '决定升为门（并入 CI）或确认无价值后删除本行',
    ),
    'summarize-test-failures.py': (
        '把测试失败汇总成人读的一段；只在排查时跑',
        '并入 qa.sh 的失败输出后删除本行',
    ),
    'telemetry-crosstab.py': (
        '遥测交叉表；需真实数据',
        '遥测看板覆盖该交叉表后删除本行',
    ),
}


def classify(name: str) -> str:
    needle = f"scripts/{name}"
    for f in AUTO_FILES:
        if f.exists() and needle in f.read_text(encoding="utf-8", errors="replace"):
            return "CI"
    for pat in AUTO_GLOBS:
        for f in REPO.glob(pat):
            if needle in f.read_text(encoding="utf-8", errors="replace"):
                return "CI"
    # 以文件名（不带目录）出现在 workflow 里也算：matrix 里可能只写裸文件名。
    for pat in AUTO_GLOBS:
        for f in REPO.glob(pat):
            if re.search(rf"(?<![\w./-]){re.escape(name)}(?![\w.-])", f.read_text(encoding="utf-8", errors="replace")):
                return "CI"
    for pat in DOC_GLOBS:
        for f in REPO.glob(pat):
            body = f.read_text(encoding="utf-8", errors="replace")
            if needle in body or re.search(rf"(?<![\w./-]){re.escape(name)}(?![\w.-])", body):
                return "DOC"
    return "ADHOC"


def main() -> int:
    scripts = sorted(
        p.name for p in SCRIPTS.iterdir()
        if p.is_file() and p.suffix in {".py", ".sh", ".mjs"} and p.name != SELF
    )
    buckets: dict[str, list[str]] = {"CI": [], "DOC": [], "ADHOC": []}
    for name in scripts:
        buckets[classify(name)].append(name)

    print("脚本失效的发现者（口径：谁在它不跑的时候会知道）")
    print(f"  CI   {len(buckets['CI']):>2} 个 —— 有人替你发现（workflow / qa.sh）")
    print(f"  DOC  {len(buckets['DOC']):>2} 个 —— 由「去跑 X」那句指令的人发现")
    print(f"  ADHOC {len(buckets['ADHOC']):>2} 个 —— 只能靠人主动去查 ⇒ 必须登记")
    print()

    unregistered = [n for n in buckets["ADHOC"] if n not in ADHOC]
    if buckets["ADHOC"]:
        print("ADHOC 登记：")
        for name in buckets["ADHOC"]:
            if name in ADHOC:
                why, until = ADHOC[name]
                print(f"  ✓ {name}")
                print(f"      为什么不需要自动发现：{why}")
                print(f"      移出条件：{until}")
            else:
                print(f"  ✗ {name} —— 未登记")
        print()

    # 登记项失效 = 现在有自动调用了（或脚本没了）⇒ 那一行必须删，
    # 否则「移出条件」这句就只是装饰，登记表会越积越大。
    stale = sorted(n for n in ADHOC if n not in buckets["ADHOC"])
    if stale:
        print("登记项已失效（脚本现在有自动调用了，或脚本已不存在）⇒ 删掉那一行：")
        for n in stale:
            print(f"  · {n}（当前分类 = {classify(n)}）")
        print()

    print(f"合计 {len(scripts)} 个脚本。")
    print("判据：没有通道的缺陷，被发现的速度是 0 —— 不是很小，是 0。")
    print("check  : 重跑本脚本；新增脚本若落在 ADHOC 且未登记 ⇒ --assert 会红。")

    if "--assert" in sys.argv:
        if stale:
            print(f"\n✗ {len(stale)} 条登记已失效（脚本现在有自动调用 / 已不存在）：{', '.join(stale)}", file=sys.stderr)
            print("  ⇒ 删掉那些行使登记表保持「每一行都是当下的决定」。", file=sys.stderr)
            return 1
        if unregistered:
            print(f"\n✗ {len(unregistered)} 个脚本没有发现者通道：{', '.join(unregistered)}", file=sys.stderr)
            print("  ⇒ 要么接进 CI/qa.sh，要么在 ADHOC 里写明「为什么不需要」与「什么时候删掉这一行」。", file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
