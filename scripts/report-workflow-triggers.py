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

try:
    import yaml
except ImportError:  # pragma: no cover
    print("✗ 缺 PyYAML ⇒ 没有读数（不等于「全部不可解析」）", file=sys.stderr)
    raise SystemExit(2)

REPO = Path(__file__).resolve().parent.parent
WF = REPO / ".github" / "workflows"

AUTO = re.compile(r"\b(push|pull_request|pull_request_target|schedule|release|workflow_run|merge_group)\b")
GATE_NAME = re.compile(r"(gate|qa|check)", re.I)

# 例外：名字像门、但确实只能手动。**必须写理由**，否则下一个人不知道它是故意的还是忘了。
# 2026-10-31 —— 豁免表必须带「什么情况下可以移出」。
# 只有理由与到期时，它会按期续命；而「登记成已知」会让它从「缺失」变成「已处理」。
ALLOWLIST = {
    "windows-real-codex-gate.yml": {
        "why": "需要一台真 Windows 机器与真实 codex 登录，成本与可用性都不允许自动跑",
        "exit_when": "出现常驻的 Windows runner（或该门被并入一个自带 Windows 矩阵的 workflow）",
    },
}


def triggers(text: str) -> tuple[str, str]:
    """→ (state, detail)。state ∈ {"auto", "manual", "none", "unparsable"}。

    🔴 2026-10-31 —— 第四态是因为这台机器上真出过一次：
        `- name: empty-equality scan (advisory: only the ...)` 里的裸 `": "`
        让整个文件**无法被 YAML 解析**。GitHub 的行为不是「跳过这一行」，
        而是**整个 workflow 起不来**：277 次运行、0 个 job、21 条脚本从此没跑过。
        而本函数此前用 `re.search("^on:")` 读**文本** —— 于是它把这个文件判成
        「自动：84」里的一个，也就是**对「这道门会不会跑」这件事给了假绿**。

        教训：判据的仪器必须与被判对象同层。文件能不能跑，只有解析器知道；
        正则读到的 `on:` 只证明**有人写下了** on:，不证明这份文件被接受。
    """
    try:
        doc = yaml.safe_load(text)
    except Exception as e:  # noqa: BLE001
        mark = getattr(e, "problem_mark", None)
        where = f"L{mark.line + 1}:C{mark.column + 1}" if mark else "未知位置"
        first = str(e).split("\n")[0]
        return "unparsable", f"{where} {first}"
    if not isinstance(doc, dict):
        return "unparsable", "顶层不是映射"
    on = doc.get(True, doc.get("on"))
    if on is None:
        return "none", "没有 on:"
    if isinstance(on, str):
        events = [on]
    elif isinstance(on, list):
        events = [str(x) for x in on]
    elif isinstance(on, dict):
        events = [str(k) for k in on.keys()]
    else:
        return "none", f"on: 形状不认识（{type(on).__name__}）"
    auto = sorted({e for e in events if AUTO.search(e)})
    if auto:
        return "auto", ",".join(auto)
    if "workflow_dispatch" in events:
        return "manual", "workflow_dispatch"
    return "none", "未识别的触发条件：" + ",".join(events)


def silenced(text: str) -> tuple[int, int]:
    """一个跑不起来的 workflow 里，有多少步、多少条脚本从此不会执行。

    只报「失败」不够：`parse error` 与「某条断言红了」在结论列里同色，
    区别只在 job 列表 —— 而 job 列表是空的这件事，只有数一数才看得出来。
    """
    steps = [ln for ln in text.split("\n") if re.match(r"^\s*- (name|uses|run):", ln)]
    scripts = [ln for ln in text.split("\n") if "scripts/" in ln and not ln.strip().startswith("#")]
    return len(steps), len(scripts)


SELFTEST_EXPECTED = 7


def selftest(quiet: bool = False) -> int:
    """五例：auto(push) / auto(schedule) / manual / none(无 on:) / 未识别。

    为什么要自检：这门的全部价值在于把「可触发」拆成三态，
    而**「手动」是最容易被误写成「自动」的那一态** —— 判定逻辑一旦回归，
    所有 workflow 会一起显示成「在保护我们」。
    """
    cases = [
        ("on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n", "auto"),
        ("on:\n  schedule:\n    - cron: '0 3 * * *'\njobs:\n  a:\n", "auto"),
        ("on: workflow_dispatch\njobs:\n  a:\n", "manual"),
        ("jobs:\n  a:\n", "none"),
        ("on: \njobs:\n  a:\n", "none"),
        # 第四态：不可解析。这两例都来自 2026-10-31 的真实事故形状。
        ("on: push\njobs:\n  a:\n    steps:\n      - name: x (advisory: y)\n", "unparsable"),
        ("on: push\njobs:\n\ta:\n", "unparsable"),   # 制表符缩进：GitHub 也不接受
    ]
    fails = 0
    for text, want in cases:
        got, detail = triggers(text)
        ok = got == want
        if not ok:
            fails += 1
            if not quiet:
                print(f"  ✗ 期望 {want} 实际 {got}（{detail}）")
        elif not quiet:
            print(f"  ✓ {want}: {detail}")
    if len(cases) != SELFTEST_EXPECTED:
        print(f"✗ 自检用例数应为 {SELFTEST_EXPECTED}，实际 {len(cases)}", file=sys.stderr)
        return 1
    if fails:
        print(f"✗ 自检失败 {fails} 例", file=sys.stderr)
        return 1
    if not quiet:
        print(f"✓ selftest {SELFTEST_EXPECTED}/{SELFTEST_EXPECTED} 通过")
    return 0


def _probe(cmd: list[str]) -> tuple[bool, str]:
    """跑一条探针命令，返回 (能不能在这里跑, 依据)。

    🔴 只报「可跑/不可跑」是不够的：**不可跑有两种**，而它们的处置相反 ——
       · 这台机器没有该工具（换台机器就能跑）
       · 工具有但不可用（daemon 没起 / 权限不对）
       所以这里连**判定依据**一起返回，调用方必须把它打出来。
    """
    import shutil
    import subprocess

    if shutil.which(cmd[0]) is None:
        return False, f"`{cmd[0]}` 不在 PATH 里"
    try:
        r = subprocess.run(cmd, capture_output=True, timeout=20)
    except Exception as e:  # noqa: BLE001
        return False, f"`{' '.join(cmd)}` 抛错：{e}"
    if r.returncode != 0:
        first = (r.stderr or r.stdout).decode("utf-8", "replace").strip().splitlines()
        return False, f"`{' '.join(cmd)}` exit={r.returncode}：{first[0] if first else ''}"
    return True, f"`{' '.join(cmd)}` exit=0"


def report_layers() -> int:
    """L0 到处能跑，L1 需要 docker —— 所以「在哪一层跑过」必须比「跑没跑」更具体。"""
    layers = [
        ("L0 （bun test 单测）", ["bun", "--version"]),
        ("L1 （docker 契约测试）", ["docker", "info"]),
    ]
    print("测试层：能不能**在这台机器上**跑（不是「有没有跑过」）")
    for name, cmd in layers:
        ok, why = _probe(cmd)
        print(f"  {name:24s} {'可跑' if ok else '不可跑'}   ← {why}")
    print("  ⚠️ 「不可跑」有两种：工具缺失（换机器可解）与工具不可用（daemon/权限）。")
    print("     而「沉默」会被读成「没跑」——这里至少把沉默变成一行明确的不可跑。")
    return 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    if "--layers" in sys.argv:
        return report_layers()

    if not WF.is_dir():
        print(f"✗ 找不到 {WF}", file=sys.stderr)
        return 2

    buckets: dict[str, list[tuple[str, str]]] = {"auto": [], "manual": [], "none": [], "unparsable": []}
    silent: dict[str, tuple[int, int]] = {}
    for path in sorted(WF.glob("*.yml")):
        text = path.read_text(encoding="utf-8", errors="replace")
        state, detail = triggers(text)
        buckets[state].append((path.name, detail))
        if state == "unparsable":
            silent[path.name] = silenced(text)

    for state, label in (("unparsable", "**不可解析 ⇒ 整份都不跑**"), ("auto", "自动"),
                         ("manual", "**只手动**"), ("none", "不跑 / 未识别")):
        rows = buckets[state]
        print(f"{label}：{len(rows)}")
        if state != "auto":
            for name, detail in rows:
                extra = ""
                if state == "unparsable":
                    st, sc = silent[name]
                    extra = f" ⇒ **{st} 步 / {sc} 行调脚本从未执行**"
                print(f"  {name}  （{detail}）{extra}")
    total = sum(len(v) for v in buckets.values())
    print(f"\n合计 {total} 个 workflow")

    # 2026-10-31 —— 负断言的值域由**代码导出**时，导出失败会变成空集 ⇒ 负断言恒真。
    # ⇒ 先断言值域非空（正控），再谈「没有违规」。
    domain = [name for name, _ in buckets["auto"] + buckets["manual"] + buckets["none"] + buckets["unparsable"]
              if GATE_NAME.search(name)]
    if not domain:
        print("✗ 值域为空：没有任何 workflow 名字匹配 gate|qa|check ⇒ 下面的「无违规」恒真，不可读成通过",
              file=sys.stderr)
        return 1 if "--assert" in sys.argv else 0
    print(f"值域（名字匹配 gate|qa|check 的 workflow）：{len(domain)} 个")

    # 不可解析：**不看名字**。它里面的每一条命令都不会跑，与「名字像不像门」无关。
    unparsable = buckets["unparsable"]
    if unparsable:
        print("\n✗ 这些 workflow 文件**解析不了** ⇒ 它们里面的每一条命令都不会执行：", file=sys.stderr)
        for name, detail in unparsable:
            st, sc = silent[name]
            print(f"    {name}  （{detail}）⇒ {st} 步 / {sc} 行调脚本", file=sys.stderr)
        print("  ⇒ 修 YAML，别改触发器：现在这份文件**连被触发都做不到**。", file=sys.stderr)
        if "--assert" in sys.argv:
            return 1

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

    for name, meta in sorted(ALLOWLIST.items()):
        print(f"\n· 例外：{name}")
        print(f"    理由：{meta['why']}")
        print(f"    移出条件：{meta['exit_when']}")
    missing_exit = [n for n, m in ALLOWLIST.items() if not m.get("exit_when")]
    if missing_exit:
        print(f"\n✗ 豁免项缺「移出条件」：{missing_exit}", file=sys.stderr)
        print("  ⇒ 没有它，这条豁免会一直停在这里，下一个人会以为有人在跟。", file=sys.stderr)
        if "--assert" in sys.argv:
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
