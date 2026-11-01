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
    'hub-rotate-logs.sh': (
        '生产机上的运维脚本：按大小原地截断 hub/pm2 日志；它必须跑在**那台机器**上，'
        'CI 的 runner 没有那些日志 ⇒ CI 里不可能有发现者',
        '等它被某个部署/安装步骤接管（例如 deploy-hub-runtime.sh 里调一次或装 cron）后，删本行',
    ),
    'commit-with-message.sh': (
        '人肉提交助手：把「先写消息再提交」链上的空消息 / 形状不符 / 标题与 diff 不符三面堵住；'
        '它只在有人真的用它提交时生效，CI 里没有「提交」这个动作可跑',
        '等 commit-msg 钩子能自己安全地生成并校验消息（而不是读一个可能遗留的文件）后，删本行',
    ),
    'report-mcp-shape-branches.py': (
        '读「每个工具有几个源码出口形状」（#3309 分支维度的分母）；读数用，不是门',
        '分支维度结卡（或该维度被别的报告吸收）后删除本行',
    ),
    # 2026-10-31 —— 12 条「没有发现者通道」的脚本。这一批**不是新写的**，
    # 而是这道门第一次在 CI 里真的跑起来时才被数出来（此前它自己也只在人肉清单里）。
    # 每一条都要回答两件事：谁会发现它烂了 / 什么时候删掉这一行。
    'check-claim-existence.py': (
        '读「卡里声称已完成」与来源是否对得上；输入是 Hub 上的实时卡，CI 里没有那份数据',
        '有一个带 Hub 读权限的定时 job 后，接进去再删本行',
    ),
    'check-control-run.sh': (
        '要容器内的控制组读数（进程面 + timer 面）；CI 的 runner 不是那台机器',
        '接进 L2 docker 套件、且套件里有同名容器后删本行',
    ),
    'cleanup-dangling-requirement-refs.py': (
        '**写入型**：会改 Hub 上的卡；CI 不允许写生产',
        '有 staging Hub 后接进定时任务再删本行',
    ),
    'health-snapshot.py': (
        '25 道门的总表（逐条 --selftest + 主跑）；CI 里这些门已各自单独跑，再跑一遍只是翻倍 runner 时间，且它要 docker',
        '其余 workflow 覆盖了同一组门之后删本行（届时它只剩本地复核用途，进 docs 引用）',
    ),
    'install-diff-shape-hook.sh': (
        '一次性：往 .git/hooks 装 pre-commit 钩子；CI 没有 git hooks 这回事',
        '改为仓库自带 core.hooksPath 之后删本行',
    ),
    'probe-cors-cells.sh': (
        '探测**线上** CORS 组合（需要已部署的 hub 地址与凭据）',
        'CORS 组合进 e2e-docker 的部署后探测后删本行',
    ),
    'report-header-producers.py': (
        '读「谁写这个响应头」的静态报告；人读，无判定',
        '并入 check-keyset-join.py 的来源分析后删本行',
    ),
    'report-health-liveness.py': (
        '要线上 /health 的实时读数；CI 里没有那台 hub',
        '接进 canary/巡检 job 后删本行',
    ),
    'report-rest-coverage.py': (
        'REST 覆盖率的静态报告；人读',
        '并入 check-rest-route-table.py 的输出后删本行',
    ),
    'report-server-test-triage.py': (
        '台架失败归因（四档）；输入是 run-server-tests.sh 的逐文件输出，只在本地台架存在',
        'CI 直接产出逐文件结果并自带归因后删本行',
    ),
    'report-type-assertions.py': (
        '静态读「类型断言在哪」；人读，无判定',
        '并入类型检查棘轮输出后删本行',
    ),
    'run-server-tests.sh': (
        '逐文件跑 server 套件、每文件独立 DB；CI 里由 L1/L2 套件承担，这里是人肉台架（且要 bun + 本地 sqlite）',
        'CI 能按同一隔离粒度跑全量后删本行',
    ),
    'report-reason-branches.py': (
        "按需读「reason 被当 code 分支」的清单 + 冻结基线；棘轮由 --assert 承担，未接线到 CI",
        "把 --assert 接进 test-inventory.yml 后删除本行",
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
        '读生产节点版本分布；需要在真实机器上以生产用户身份访问真库，CI 里跑不了',
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
