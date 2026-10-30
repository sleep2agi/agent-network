#!/usr/bin/env python3
"""测试清单棘轮：**允许新增，不允许消失**。

## 为什么是「集合」而不是「计数」

2026-10-31 我亲手证过反例：一次「两个锚点之间整段替换」把两条测试连同区间内容一起删掉，
同时新增了两条别的 ⇒ **测试总数 31 → 31，看起来没变**。

⇒ 计数相同 ≠ 覆盖相同。
⇒ 唯一通用的检测器是**名字集合的差集**：它同时也是「测试文件被整段替换」这个事故类的检测器。

## 判据

本脚本对比 `scripts/test-inventory-baseline.json`：
  · 基线里有、现在没有  ⇒ **红**（有人删了测试，或整段替换吃掉了它）
  · 现在有、基线里没有  ⇒ 绿，并打印「新增 N 条，请跑 --update 落基线」
  · 集合完全相同        ⇒ 绿

## 它自己的盲区（必须打印，否则「0 消失」会被读成「全覆盖」）

测试名如果不是**字符串字面量**（模板串、常量拼接、循环生成），本脚本抓不到。
所以每次运行都打印两行分母：
  literal = 能抓到的（进集合）
  dynamic = 抓不到的（只计数，不进集合）
⇒ 「消失 0 条」严格来说只覆盖 literal 那部分；dynamic 那部分没有棘轮。

🔴 2026-10-31 补两条（都是这个脚本原来的盲区）：

  ① **集合对重数失明**：把一条 test("foo") 复制粘贴成两条 ⇒ 集合不变 ⇒ 绿。
     而 runner 对同名测试的输出去重/覆盖 ⇒ 你看到 1 条结果，实际有 2 条。
     ⇒ 这比「31→31」更隐蔽：那个至少数字变了，这个连数字都不变。
     ⇒ 所以保留集合的同时**加一条唯一性断言**：`rel::name` 不许重复。
        （重名意味着**任何按名字的报告都无法归因到具体那一条**，本身就是缺陷。）

  ② **未保护桶必须自带上限**：dynamic 原来只是一个打印出来的数。
     ⇒ 有人新增 100 条 test(模板字符串名) ⇒ dynamic 86→186 ⇒ 报表照样绿。
     ⇒ 所以 dynamic 也进基线，断言 `dynamic <= baseline.dynamic`。
     ⇒ 注意：把既有 literal 改成 dynamic 这件事**已经会被抓**（那些名字会进
        `disappeared`），所以这里封的是另一个洞 —— **新增**未保护测试是静默的。

  判据：**集合回答「有没有」，多重集回答「有几条」；
        一个写着「不受保护」的桶，必须自带上限，否则棘轮保护的是标签，不是内容。**
   把它打印出来，是让读者知道这条棘轮**覆盖到哪里为止** —— 与 L0/L1 的「没有读数」同一条纪律。

用法：
  python3 scripts/check-test-inventory.py            # 对比基线
  python3 scripts/check-test-inventory.py --update   # 用当前集合覆盖基线
"""
import json
import re
import subprocess
import sys
from pathlib import Path

BASELINE = "scripts/test-inventory-baseline.json"
# test("...") / it("...") —— 只认双引号/单引号/反引号字面量开头，且不含 ${}
TEST_CALL = re.compile(r"^\s*(?:test|it)\s*\(\s*([\"'`])((?:(?!\1).)*)\1")
ANY_TEST_CALL = re.compile(r"^\s*(?:test|it)\s*\(")


def tracked_files(repo: Path) -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=repo, check=True, capture_output=True
    ).stdout.decode("utf-8", "replace")
    files = []
    for rel in out.split("\0"):
        if not rel or rel.startswith("node_modules/"):
            continue
        if not (rel.endswith(".test.ts") or rel.endswith(".test.mts") or rel.endswith(".test.js")):
            continue
        files.append(repo / rel)
    return sorted(files)


def collect(repo: Path) -> tuple[dict[str, int], int]:
    """返回 (名字 → 出现次数, dynamic 计数)。

    用**多重集**而不是集合：集合对重数失明，而「同名测试出现两次」是一次真实事故
    （runner 会去重/覆盖 ⇒ 报告里只剩 1 条，另一条静默不跑）。
    """
    names: dict[str, int] = {}
    dynamic = 0
    for path in tracked_files(repo):
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        rel = path.relative_to(repo)
        for line in text.splitlines():
            if not ANY_TEST_CALL.match(line):
                continue
            m = TEST_CALL.match(line)
            if not m:
                dynamic += 1
                continue
            name = m.group(2)
            if not name.strip() or "${" in name:
                dynamic += 1
                continue
            key = f"{rel}::{name}"
            names[key] = names.get(key, 0) + 1
    return names, dynamic


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    counts, dynamic = collect(repo)
    current = set(counts)
    baseline_path = repo / BASELINE

    print(f"literal 测试名: {len(current)} 条（多重集，共 {sum(counts.values())} 次出现）")
    print(f"dynamic 测试名: {dynamic} 条（**抓不到，不受逐条棘轮保护，但有上限**）")

    # 注意：`rel::name` 不含 describe 路径 ⇒ **同名但在不同 describe 里是合法的**，
    # 仓库里现在就有 6 个这种（已记进基线的计数里）。所以这里不做「绝对值唯一」断言，
    # 而是做**多重集棘轮**：任何 key 的出现次数**不许比基线多**。
    #   · 复制粘贴一条测试 ⇒ 计数 +1 ⇒ 红（这正是要抓的那个洞）
    #   · 在新 describe 里合法地起同一个名字 ⇒ 也会 +1 ⇒ 需要 --update 并说明
    #     （代价是一次显式动作；换来的是「静默多出一条」不再可能）
    if "--update" in sys.argv:
        baseline_path.write_text(
            json.dumps(
                {"names": sorted(current), "counts": counts, "dynamic": dynamic},
                ensure_ascii=False,
                indent=1,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"✓ 基线已更新：{BASELINE}（{len(current)} 条 / dynamic {dynamic}）")
        return 0

    if not baseline_path.exists():
        print(f"✗ 缺少基线 {BASELINE}；先跑 --update 生成", file=sys.stderr)
        return 1

    raw = json.loads(baseline_path.read_text(encoding="utf-8"))
    baseline = set(raw["names"])
    baseline_dynamic = raw.get("dynamic")
    baseline_counts = raw.get("counts")

    # ① 多重集棘轮：同名出现次数不许增加（集合对重数失明）
    if isinstance(baseline_counts, dict):
        grew = sorted((k, baseline_counts.get(k, 0), counts[k]) for k in counts if counts[k] > baseline_counts.get(k, 0))
        if grew:
            print(f"✗ 有 {len(grew)} 条测试的**出现次数增加**了（集合不变，但实际多出一条）：", file=sys.stderr)
            for k, before, after in grew[:20]:
                print(f"    × {k}  {before} → {after}", file=sys.stderr)
            print("  ⇒ runner 会对同名测试去重/覆盖 ⇒ 报告里只剩 1 条，另一条静默不跑。", file=sys.stderr)
            print("  ⇒ 若是新 describe 里合法重名，请 --update 并在提交信息里说明。", file=sys.stderr)
            return 1
    else:
        print("⚠ 基线里没有多重集计数（旧格式）⇒ 本次跳过次数检查；下次 --update 会写入", file=sys.stderr)
    disappeared = sorted(baseline - current)
    added = sorted(current - baseline)

    # ② 未保护桶的上限：新增 dynamic 测试原来是静默的
    if baseline_dynamic is None:
        print("⚠ 基线里没有 dynamic 上限（旧格式）⇒ 本次不检查；下次 --update 会写入", file=sys.stderr)
    elif dynamic > baseline_dynamic:
        print(f"✗ dynamic 测试从 {baseline_dynamic} 涨到 {dynamic}：", file=sys.stderr)
        print(f"  多出 {dynamic - baseline_dynamic} 条**抓不到名字、因此不受逐条棘轮保护**的测试。", file=sys.stderr)
        print("  ⇒ 要么把它们改成字面量名字（推荐），要么在同一次提交里 --update 并说明理由。", file=sys.stderr)
        print("  ⇒ 判据：一个写着「不受保护」的桶必须自带上限，否则它只是一个会吞东西的口袋。", file=sys.stderr)
        return 1

    if disappeared:
        print(f"✗ 有 {len(disappeared)} 条测试**消失**了（计数相同也可能发生）：", file=sys.stderr)
        for name in disappeared[:20]:
            print(f"    - {name}", file=sys.stderr)
        if len(disappeared) > 20:
            print(f"    …（共 {len(disappeared)} 条）", file=sys.stderr)
        print("  ⇒ 若确为有意删除，请在同一次提交里跑 --update 并说明原因。", file=sys.stderr)
        return 1

    if added:
        print(f"· 新增 {len(added)} 条（绿）。落基线：python3 scripts/check-test-inventory.py --update")
        for name in added[:10]:
            print(f"    + {name}")
        if len(added) > 10:
            print(f"    …（共 {len(added)} 条）")
    else:
        print("✓ 测试清单与基线一致：无消失、无新增、无重名")
    if baseline_dynamic is not None and dynamic < baseline_dynamic:
        print(f"· dynamic 从 {baseline_dynamic} 降到 {dynamic}（好事，落基线：--update）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
