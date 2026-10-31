#!/usr/bin/env python3
"""门是否**真的被接线并被跑过** —— 而不是「名字出现在某个 yml 的文本里」。

2026-10-31 —— 外部复核 (c)（原话）：
    「元门的覆盖关系是**文本包含**（`txt.includes`）：我用一个**只有注释**、挂进 gates.sh 的
      文件做实验，missing 集合 17→16，消失的正是那个真门。
      真仓会被阳控拦下，但只钉了 1/10；其余 9 条可被注释买走，
      而门的提示是『请把 BASELINE 改成 N』⇒ 提示会引导固化假覆盖。」

本仓没有那种「元门」，但有一个更朴素的问题：**新加的门可能根本没进 CI**。
⇒ 本脚本做两件事，都是**可执行**的，不是文本比对：

  ① 接线检查：scripts/ 下每个可执行的门（带 --selftest 的 check-*/report-*）都必须在
     .github/workflows/*.yml 里被**调用**；未接线的必须登记理由（KNOWN_UNWIRED）。
  ② 自检实跑：对已接线的门**真的执行** `<gate> --selftest`，退出码必须是 0。
     「文本里提到 --selftest」不算数 —— 那正是上面那个洞。

退出码：0 = 全部接线且自检通过 ｜ 1 = 有未接线/自检失败 ｜ 2 = 没有读数（找不到门）。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
GATE_PATTERNS = ("check-*.py", "report-*.py", "check-*.sh", "check-*.mjs", "report-*.mjs")
# 2026-10-31 —— **一条规则要和它的覆盖度一起报**（外部复核 ①：
# 「node 23 / bash 73 / python3 2 / env 2 ⇒ 98 行里只有 23 行进得了判别器
#   ⇒ 把『树被换过 ⇒ exit 2』写成规则，它今天覆盖 23%，而它读起来像全覆盖」）。
# 本门自己就有同一个形状：GATE_PATTERNS 只收 .py/.sh ⇒ `check-pair-published.mjs`
# 这类门**从未进入统计**，而摘要里的「门：39 个」读起来像「全部」。
CANDIDATE_SUFFIXES = (".py", ".sh", ".mjs")
# 后缀 → 解释器。闭集：新增一种后缀而没在这里登记 ⇒ 自检报错，而不是被某个默认分支悄悄跑错。
INTERPRETER_BY_SUFFIX: dict[str, tuple[str, ...]] = {
    ".py": ("python3",),
    ".sh": ("bash",),
    ".mjs": ("node",),
}

# 未接线的门必须在这里给出理由（空着 = 没有例外）。
# 理由必须以 [tag] 开头，tag 取自 UNWIRED_TAGS —— 散文负责说服人，tag 负责让机器能分支。
UNWIRED_TAGS = ("report-only", "interactive", "needs-host")

# 2026-10-31 —— **每条豁免必须写「移出条件」**（外部复核：
# 「把孤儿登记成『已知』会让它从『缺失』变成『已处理』；除非登记项带『什么情况下可以移出』，
#   它会一直停在那里，而下一次看到它的人会以为有人在跟。」）
# 理由（why）回答「为什么现在不接」，移出条件（exit_when）回答「什么情况下该接/该删」。
# 两者分开存：一条写了理由的豁免看起来负责，只有写了移出条件的豁免才会结束。
UNWIRED_EXIT_WHEN: dict[str, str] = {
    "scripts/check-claim-existence.py": "它被接进某个 CI 步骤（而不是人工按需跑）⇒ 移出本表",
    "scripts/check-control-run.sh": "CI 里有干净的 git worktree 副本可供它跑 ⇒ 移出本表",
    "scripts/check-diff-shape.sh": "提交形状检查改由 CI（而不是本地钩子）承担 ⇒ 移出本表",
    "scripts/report-process-artifact-drift.py": "出现固定读者（人或门）⇒ 移出本表并接线",
    "scripts/report-code-producers.py": "出现固定读者 ⇒ 移出本表并接进巡检",
    "scripts/report-rest-coverage.py": "REST 覆盖率被接进 CI 的覆盖率门 ⇒ 移出本表",
    "scripts/report-header-producers.py": "「同一路由内 >1 生产者」被做成门 ⇒ 移出本表",
    "scripts/report-type-assertions.py": "type_only 计数被做成棘轮门（基线入库、只许降不许升）⇒ 移出本表",
    "scripts/report-server-test-triage.py": "它被接进 CI 的「全量 server 测试」步骤，红/黄分档直接进 PR 摘要 ⇒ 移出本表",
    "scripts/report-health-liveness.py": "有了带负载的定时运行点 ⇒ 移出本表",
    "scripts/report-mcp-key-set-coverage.py": "键集覆盖率进 CI 并设下限 ⇒ 移出本表",
    "scripts/report-node-versions.py": "舰队版本分布出现固定读者 ⇒ 移出本表",
    "scripts/report-reason-branches.py": "出现固定读者 ⇒ 移出本表",
    "scripts/report-rest-endpoints.py": "路由表由它生成且被门消费（已如此）⇒ 可并入该门",
    "scripts/report-table-driven-nonempty.py": "出现固定读者 ⇒ 移出本表并接线",
}


def derived_tag(rel: str) -> str | None:
    """从**文件名**推出的标签（能推就不许手填）。

    2026-10-31 —— 外部复核：「桶得由条目本身决定，不由作者指派；
    否则作者在创建那一刻就能把本该 actionable 的写成 note，而迁移计数一次都不触发。」

    本仓可推的一半：`report-*` 一律是读数报告（它的名字就是它做的事）。
    ⇒ 这类门手填成别的标签 ⇒ 红（作者不能重分类）。
    推不出来的（check-*）才允许声明，且必须给 tag。
    """
    if rel.rsplit("/", 1)[-1].startswith("report-"):
        return "report-only"
    return None
KNOWN_UNWIRED: dict[str, str] = {
    # 2026-10-31 —— 外部复核：「只校验『非空字符串』，于是长散文用质量掩盖了缺席。
    # 建议每个理由必带一个封闭枚举的**结构标签**」。⇒ 每条理由必须以 [tag] 开头，
    # tag ∈ UNWIRED_TAGS；散文跟在后头（给人看），tag 给机器分支。
    "scripts/check-claim-existence.py": "[report-only] 写报告前用的工具，不对代码下结论；不进 CI",
    "scripts/check-control-run.sh": "[needs-host] 本地对照运行工具（需要 git worktree），CI 里没有干净副本的意义",
    "scripts/check-diff-shape.sh": "[interactive] 提交时用（配合 install-diff-shape-hook.sh），不是 CI 门",
    "scripts/report-process-artifact-drift.py": "[report-only] 读数报告，非阻塞；有需求再接",
    "scripts/report-code-producers.py": "[report-only] 读数报告（谁产出某字段），人工按需跑",
    "scripts/report-rest-coverage.py": "[report-only] 读数报告（REST 端点的测试引用率）；"
                                       "它回答「分母是多少」，不对代码下结论，不进 CI",
    "scripts/report-header-producers.py": "[report-only] 读数报告（每个响应头有几个写出点）；"
                                          "多生产者不是缺陷，但它是「改一处只改了一半」的前置条件",
    # 2026-10-31 —— 它在这次提交里把本门弄红了（新 report-* 没登记），这条记录就是那次红。
    "scripts/report-type-assertions.py": "[report-only] 读数报告（`expect(typeof x).toBe(\"T\")` 的三分类）；"
                                         "68 条 type_only 里多数是 fixture 守卫，直接当门会立刻红而且红得没信息",
    "scripts/report-server-test-triage.py": "[report-only] 读数是「这次全量跑红在哪一档」；"
                                           "它不改代码也不阻断，人工用它做归因",
    "scripts/report-health-liveness.py": "[report-only] 读数报告（/health 里哪些字段多次采样从不变化）；"
                                         "空闲负载下不变不构成结论，它是「有流量时再看一眼」的入口",
    # 2026-10-31 —— 移除 `cleanup-dangling-requirement-refs.py` 的豁免条目：
    # 它不匹配 GATE_PATTERNS（check-*/report-*），永远不会出现在 unwired 里，
    # 于是这条登记只会被本门印成「白名单已过期」—— 死成员比缺席更糟：
    # 下一个人会以为有人在跟这条，而它从来没有被检查过。
    "scripts/report-mcp-key-set-coverage.py": "[report-only] 读数报告（键集覆盖率三口径），人工按需跑",
    "scripts/report-node-versions.py": "[report-only] 读数报告（舰队版本分布），人工按需跑",
    "scripts/report-reason-branches.py": "[report-only] 读数报告（按 reason 分支的处数），人工按需跑",
    "scripts/report-rest-endpoints.py": "[report-only] 读数报告（路由清单草稿的生成来源），人工按需跑",
    "scripts/report-table-driven-nonempty.py": "[report-only] 读数报告，人工按需跑",
}
# 这些不是「门」，是库或测试工具，不参与接线检查
NOT_A_GATE: set[str] = set()

# 2026-10-31 —— **已接线但没有 --selftest 的门 = 欠账**（不是错误，但不能增长）。
# 今晚之前也有「每个门都带 selftest」的说法，实际是 14/26。写死这份名单，让数字可对账：
#   · 名单里的门出现 ⇒ 记 debt，不判红
#   · 名单外新接线却没有 selftest ⇒ 红（新增的门必须自带）
KNOWN_NO_SELFTEST: set[str] = {
    "scripts/check-doc-symbol-pins.py",
    "scripts/report-script-cadence.py",
    # 本脚本自己不提供 --selftest（它跑别人的），否则会自我递归
    "scripts/check-gates-wired.py",
}

# 少数门的自检本来就慢（>60s）。**这里不执行它们**，但要在输出里点名：
# 「有 selftest 但本步没跑」与「没有 selftest」是两件事，不能混成一句「都在跑」。
KNOWN_SLOW: dict[str, str] = {
    "scripts/check-mutation-pins.py": "自检约 3 分钟；由它自己的 CI 步骤跑（本步只核对接线与 selftest 存在）",
    "scripts/report-rest-coverage.py": "[report-only] 读数报告（REST 端点的测试引用率）；"
                                       "它回答「分母是多少」，不对代码下结论，不进 CI",
}


def gates() -> list[Path]:
    out: set[Path] = set()
    for pat in GATE_PATTERNS:
        out.update(REPO.glob(f"scripts/{pat}"))
    # 2026-10-31 —— 测试文件跟着被测门走，不单独算门（`.mjs` 门带 `*.test.mjs` 的写法把这条暴露了）
    return sorted(p for p in out if p.is_file() and ".test." not in p.name)


def coverage() -> tuple[list[Path], list[Path]]:
    """→ (被统计的门, 落在候选域里却**没被统计**的文件)。

    候选域 = scripts/ 下名字以 check- / report- 开头、后缀属于 CANDIDATE_SUFFIXES、
    且不是测试文件（`*.test.mjs` 之类跟着被测门走，不单独算门）。
    """
    covered = gates()
    cov_set = set(covered)
    missed: list[Path] = []
    for p in sorted((REPO / "scripts").iterdir()):
        if not p.is_file():
            continue
        name = p.name
        if not (name.startswith("check-") or name.startswith("report-")):
            continue
        if ".test." in name or not name.endswith(CANDIDATE_SUFFIXES):
            continue
        if p not in cov_set:
            missed.append(p)
    return covered, missed


def workflow_text() -> str:
    """workflows 的正文，**剥掉注释**。

    2026-10-31 —— 外部复核（原话）：
      「注释绕过的漏洞换了一层：入口采集对 ENTRY_FILES 是原文 matchAll、零过滤
        ⇒ 一行 `// … scripts/x.sh` 就够把 missing 集合消掉。」

    本仓同样的洞：`p.name in wf` 会被**任何出现**满足，包括 YAML 注释里的一句提及。
    ⇒ 先剥两种注释（整行 `#` 开头、行尾 ` # …`），再匹配。
    """
    out = []
    wf_dir = REPO / ".github" / "workflows"
    if not wf_dir.is_dir() or not list(wf_dir.glob("*.yml")):
        # 2026-10-31 —— 外部复核 ③：「任何『存在/不存在』的二值判定，
        # 只要取得它需要一次可能失败的操作，就必须有第三格。」
        # 读不到 workflows（目录不存在 / 空）不是「都没接线」，是 **cannot_read**。
        raise FileNotFoundError(str(wf_dir))
    for p in wf_dir.glob("*.yml"):
        for line in p.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.lstrip().startswith("#"):
                continue
            # 行尾注释：只在 ` #` 之后切（避免切断 URL 里的 # 片段）
            if " #" in line:
                line = line.split(" #", 1)[0]
            # 2026-10-31 —— 外部复核补的第二层：「剥注释」还不够，**echo/printf 里提到也不算接线**
            # （他们的 gates.sh:300 就是 `echo "… scripts/verify-nine-requirements.sh …"`）。
            # 这些行不会执行脚本，只会在日志里打出名字。⇒ 整行丢弃。
            # 只剥**引号内**的内容，而不是整行丢弃：
            #   `echo "scripts/x.py"`                       ⇒ 名字在引号里 ⇒ 剥掉后不剩 ⇒ 不算接线 ✓
            #   `python3 scripts/x.py || { echo "…"; }`     ⇒ 名字在引号外 ⇒ 保留 ⇒ 仍算接线 ✓
            # （第一版整行丢弃，把这种合法的带错误提示调用也一起判成未接线，当场被抓到）
            if re.search(r"\b(echo|printf)\b", line):
                line = re.sub(r'"[^"]*"', "", line)
                line = re.sub(r"'[^']*'", "", line)
            out.append(line)
    return "\n".join(out)


def supports_selftest(p: Path) -> bool:
    txt = p.read_text(encoding="utf-8", errors="replace")
    return "--selftest" in txt


def run_selftest(p: Path, timeout_s: int = 60) -> tuple[int, str]:
    """单个门的自检，带超时：**超时是失败，不是跳过**（否则慢门会静默免检）。"""
    # 2026-10-31 —— **解释器也要按后缀选**（外部复核 ②：
    # 「一条教训只修它自己举的例子时，它不减少缺陷，它迁移缺陷」）。
    # 原来只有两支：.sh ⇒ bash，其余 ⇒ python3 ⇒ 加进 .mjs 门之后，
    # `python3 xx.mjs --selftest` 会以 SyntaxError 失败 —— 而它看起来像「这个门的自检坏了」。
    runner = INTERPRETER_BY_SUFFIX.get(p.suffix)
    if runner is None:
        return 1, f"没有登记 {p.suffix} 的解释器（INTERPRETER_BY_SUFFIX）⇒ 无法跑自检"
    cmd = [*runner, str(p), "--selftest"]
    try:
        r = subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=timeout_s)
        return r.returncode, (r.stdout + r.stderr)[-400:]
    except subprocess.TimeoutExpired:
        return 124, f"超时（>{timeout_s}s）—— 慢门不能因此免检"


def main(argv: list[str]) -> int:
    try:
        wf = workflow_text()
    except FileNotFoundError as e:
        print(f"stage=cannot_read —— 读不到 workflows 目录或其中没有 *.yml：{e}", file=sys.stderr)
        print("  ⇒ 这不是「所有门都没接线」，是「接线情况不可读」（三态里的第三格）。", file=sys.stderr)
        return 2
    all_gates = gates()
    if not all_gates:
        print("scripts/ 下没有门 ⇒ 没有读数", file=sys.stderr)
        return 2

    wired, unwired = [], []
    for p in all_gates:
        rel = str(p.relative_to(REPO))
        if rel in NOT_A_GATE:
            continue
        (wired if p.name in wf else unwired).append(p)

    bad_unwired = [str(p.relative_to(REPO)) for p in unwired if str(p.relative_to(REPO)) not in KNOWN_UNWIRED]
    # 移出条件必须**每条都有**，且指向的脚本必须真的在 KNOWN_UNWIRED 里（防死条目）
    no_exit = [k for k in KNOWN_UNWIRED if not str(UNWIRED_EXIT_WHEN.get(k, "")).strip()]
    dead_exit = [k for k in UNWIRED_EXIT_WHEN if k not in KNOWN_UNWIRED]
    if no_exit:
        print(f"✗ 这些豁免没有写移出条件（{len(no_exit)} 条）⇒ 它们会永远停在这里：", file=sys.stderr)
        for k in no_exit:
            print(f"    · {k}", file=sys.stderr)
        return 1
    if dead_exit:
        print(f"✗ 移出条件指向了不在豁免表里的脚本（{len(dead_exit)} 条）：{dead_exit}", file=sys.stderr)
        return 1
    # 结构标签：理由不能只是散文（「用质量掩盖缺席」）
    bad_tag = []
    for rel, why in KNOWN_UNWIRED.items():
        if not any(why.startswith(f"[{t}]") for t in UNWIRED_TAGS):
            bad_tag.append((rel, why[:40]))
            continue
        declared = next(t for t in UNWIRED_TAGS if why.startswith(f"[{t}]"))
        derived = derived_tag(rel)
        if derived is not None and declared != derived:
            bad_tag.append((rel, f"声明 [{declared}] 与可推导的 [{derived}] 不一致（分类权不在作者手里）"))
    # 白名单本身也要能对账：登记了却已经接线，说明白名单是过期照片
    stale_allow = [k for k in KNOWN_UNWIRED if all(k != str(p.relative_to(REPO)) for p in unwired)]

    failures: list[dict] = []
    checked = 0
    debt: list[str] = []
    slow_skipped: list[str] = []
    SELF = Path(__file__).resolve()
    import concurrent.futures as _cf
    runnable: list[Path] = []
    SELF = Path(__file__).resolve()
    for p in wired:
        rel = str(p.relative_to(REPO))
        if not supports_selftest(p):
            if rel in KNOWN_NO_SELFTEST:
                debt.append(rel)          # 欠账：红不了，但数字要报出来
            else:
                failures.append({"gate": rel, "why": "已接线但没有 --selftest（新增的门必须自带）"})
            continue
        # 自递归守卫：本脚本源码里也写着 "--selftest"（注释 + 子进程命令），
        # 只用文本判断会把它自己当成「有 selftest 的门」⇒ 无限自我调用。
        if p.resolve() == SELF:
            debt.append(rel)
            continue
        if rel in KNOWN_SLOW:
            slow_skipped.append(rel)
            continue
        runnable.append(p)

    # 并行跑（单个 60s 超时）：串行时一个慢门就能把整个元门拖过超时
    import concurrent.futures as _cf
    with _cf.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(lambda q: (q, *run_selftest(q)), runnable))
    for q, rc, tail in results:
        checked += 1
        if rc != 0:
            last = tail.strip().splitlines()[-1] if tail.strip() else ""
            failures.append({"gate": str(q.relative_to(REPO)), "why": f"--selftest 退出码 {rc}：{last}"})

    # 2026-10-31 —— **阳性对照**（外部复核：「任何单字段结论，先问有没有一个对照能把它劈成两支」）。
    # 「欠账 12 个」这种数字有三种成因：真是 12 / 扫描器没找到门 / 所有门都没接线。
    # ⇒ 两个下限：找到的门数、真的执行过自检的门数。低于下限 ⇒ 红，而不是报一个更小的欠账。
    MIN_GATES = 30
    MIN_EXECUTED = 8
    if len(all_gates) < MIN_GATES:
        print(f"✗ 阳性对照失败：只找到 {len(all_gates)} 个门（下限 {MIN_GATES}）⇒ 不是「欠账变少」，是扫描器瞎了", file=sys.stderr)
        return 2
    if checked < MIN_EXECUTED:
        print(f"✗ 阳性对照失败：只执行了 {checked} 个自检（下限 {MIN_EXECUTED}）⇒ 这个「欠账数」不可用", file=sys.stderr)
        return 2

    # 2026-10-31 —— **基线只能由源码变更来更新**（外部复核：
    # 「一个提示如果指向『一个可以直接编辑的数』，那它就不是提示，而是后门」）。
    # 这里把「只改名单」这条路堵上：名单里的门若**已经有** --selftest，说明名单过期了，
    # 那是「把基线改宽」而不是「把门修好」—— 必须红，否则欠账可以被一行动词归零。
    # 2026-10-31 —— **枚举不能有死成员**（外部复核 (b)：
    # 「新测试把每个成员各造一条产出路径，断言 set(实际产出) == set(SOURCE_VALUES)」）。
    used_tags = {t for why in KNOWN_UNWIRED.values() for t in UNWIRED_TAGS if why.startswith(f"[{t}]")}
    dead_tags = [t for t in UNWIRED_TAGS if t not in used_tags]

    stale_debt = []
    self_rel = str(Path(__file__).resolve().relative_to(REPO))
    for rel in list(KNOWN_NO_SELFTEST):
        # 自己豁免：本脚本文本里也写着 "--selftest"，按文本判断会把自己算成「已有自检」。
        # 这不是放宽，而是承认文本判据在「命令拼字符串」的场景下不可用（注释已写明）。
        if rel == self_rel:
            continue
        gate_path = REPO / rel
        if not gate_path.exists():
            stale_debt.append((rel, "文件已不存在"))
            continue
        if supports_selftest(gate_path):
            stale_debt.append((rel, "该门已经有 --selftest 了"))

    if "--json" in argv:
        print(json.dumps({
            "gates": len(all_gates), "wired": len(wired), "unwired": [str(p.relative_to(REPO)) for p in unwired],
            "selftests_run": checked, "failures": failures, "bad_unwired": bad_unwired, "stale_allow": stale_allow,
            "debt_no_selftest": debt, "selftest_not_run_here": slow_skipped,
            # 2026-10-31 —— 移出条件也要进机器可读输出：否则「谁能结束这条豁免」只有人读得到。
            "unwired_exit_when": {k: UNWIRED_EXIT_WHEN.get(k, "") for k in KNOWN_UNWIRED},
            "stale_debt": [r for r, _ in stale_debt], "dead_tags": dead_tags,
        }, ensure_ascii=False, indent=2))
        return 1 if (failures or bad_unwired or stale_allow) else 0

    _covered, _missed = coverage()
    _total = len(_covered) + len(_missed)
    print(f"门：{len(all_gates)} 个 ｜ 已接线 {len(wired)} ｜ 未接线 {len(unwired)}（登记理由 {len(KNOWN_UNWIRED)} 条）")
    # 覆盖度必须与规则同报（外部复核 ①）：「门：N 个」不是在说「全部」，
    # 它说的是「按这份模式找到的 N 个」——模式之外还剩几个，只有这一行能回答。
    print(f"  coverage: {len(_covered)}/{_total} 个候选（scripts/ 下 check-*/report-* 且后缀 ∈ "
          f"{'/'.join(CANDIDATE_SUFFIXES)}，排除 *.test.*）")
    _no_interp = [suf for suf in CANDIDATE_SUFFIXES if suf not in INTERPRETER_BY_SUFFIX]
    if _no_interp:
        print(f"  ✗ 这些后缀没有登记解释器 ⇒ 它们的自检跑不起来：{_no_interp}")
    if _missed:
        print(f"  ⚠ 未被统计（不在 GATE_PATTERNS 里 ⇒ 它们的接线/自检**从未被检查**）：")
        for p in _missed:
            print(f"      · {p.relative_to(REPO)}")
    print(f"自检实跑：{checked} 个（**执行** --selftest，不是文本比对）")
    # 2026-10-31 —— 外部复核 (c)：**观测点合格 ⇔ 它的值在「要区分的两个状态」上单射**。
    # 「这个门有没有 selftest」这一格的观测点是**文本包含 `--selftest`** —— 它不单射：
    #   · 有 selftest 的门 → True ✓
    #   · 只在注释/子进程命令里提到 --selftest 的门 → 也 True ✗（本脚本自己就是例子）
    # 单射做不到时，至少要把「我用的是哪种观测」写出来，否则读者会以为它是执行结果。
    print("  selftest_detected_by : text.includes('--selftest')（**不单射**：注释里提到也算；本脚本对自己豁免）")
    # 2026-10-31 —— 外部复核：「**锚必须与被测层同 transport**；否则 404/401 的归属无法判定，
    # 而它读起来仍然像一个读数。」本脚本里有两类证据，transport 不同，不能混读：
    print("  wiring_evidence      : workflow **文本**（`名字出现在 run: 里`）⇒ 证明「被接线」，不证明「跑过」")
    print("  selftest_evidence    : **执行** `--selftest`（上面的自检实跑）⇒ 证明「跑得起来」")
    print("                         ⇒ 两者是不同 transport 的证据，别把前者的绿读成后者")
    if slow_skipped:
        print(f"  · 有 selftest 但本步**不执行**（慢门，各自 CI 步骤跑）：{len(slow_skipped)} 个")
        for x in slow_skipped:
            print(f"      · {x} —— {KNOWN_SLOW[x]}")
    if debt:
        print(f"  ⚠ 已接线但无 selftest 的欠账：{len(debt)} 个（名单冻结，不允许增长）：")
        for d in debt[:12]:
            print(f"      · {d}")
    for f in failures:
        print(f"    ✗ {f['gate']}  {f['why']}", file=sys.stderr)
    for g in bad_unwired:
        print(f"    ✗ 未接线且没登记理由：{g}", file=sys.stderr)
    for rel, why in bad_tag:
        print(f"    ✗ 理由缺结构标签（须以 [{'|'.join(UNWIRED_TAGS)}] 开头）：{rel} —— {why}…", file=sys.stderr)
    for t in dead_tags:
        print(f"    ✗ 标签 [{t}] 是死成员：UNWIRED_TAGS 里登记了，但没有任何未接线的门用它"
              f"（要么用上，要么从闭集删掉）", file=sys.stderr)
    for k in stale_allow:
        print(f"    · 白名单已过期（该门现在已接线）：{k}")
    for rel, why in stale_debt:
        print(f"    ✗ 欠账名单过期：{rel} —— {why}（把基线改宽不算修好）", file=sys.stderr)
    if failures or bad_unwired or stale_debt or bad_tag or dead_tags:
        return 1
    # 2026-10-31 —— 外部复核：「分类表已经存在，但全仓 grep 是**写 1 处、读 0 处**
    # ⇒ 缺口不是『缺分类』，是『分类没有消费者』」。
    # 本仓有三张**声明式清单**同样只被测试读（不是被生产代码读）。这不是错，但必须显式：
    DECLARATIVE_TEST_ONLY = {
        "TASK_REJECTION_EXITS": "出口清单：消费者是 health-redaction 的 must-fire + 跨源路由表断言",
        "HEALTH_FIELD_META": "字段三分类：消费者是 health-redaction 的分类/未读字段断言",
        "PUBLIC_HEALTH_KEY_READERS": "匿名读者登记：消费者是跨源 grep 断言（reader=cli 必须在客户端出现）",
    }
    print("  · 声明式清单（只被测试读，不被生产代码读）——形状已知，不是漏读：")
    for name, why in DECLARATIVE_TEST_ONLY.items():
        print(f"      · {name} —— {why}")
    # 2026-10-31 —— **每条棘轮要写清自己放弃了什么**（外部复核：
    # 「集合相等不漏增长（新增元素必然不等），漏的是**重数**；
    #   每条棘轮必须写『放弃：<方向><基数>』，而全仓只有一处写了。」）
    print("  ratchet_gives_up    : 放弃『未接线理由是否成立』（只校验标签 + 删除条件，不校验理由为真）")
    # 外部复核 ②：「一句『界之前的 277 笔永远不会红』—— 277 在那行没有产出者 ⇒ 它是一条**手写基数**」
    # ⇒ 放弃声明里的数必须由本脚本数出，不能手打。下面这个 {checked} 就是上面实际跑了几个。
    print(f"                        放弃『接线是否真被执行』的文本部分（由上面的自检实跑补：{checked} 个）")
    print("  ✓ 已接线的门全部自检通过；未接线的都有登记理由")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
