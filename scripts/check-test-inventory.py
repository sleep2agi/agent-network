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


def collect(repo: Path) -> tuple[set[str], int]:
    names: set[str] = set()
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
            names.add(f"{rel}::{name}")
    return names, dynamic


def main() -> int:
    repo = Path(__file__).resolve().parent.parent
    current, dynamic = collect(repo)
    baseline_path = repo / BASELINE

    print(f"literal 测试名: {len(current)} 条（进集合，受棘轮保护）")
    print(f"dynamic 测试名: {dynamic} 条（**抓不到，不受棘轮保护**）")
    if dynamic:
        print("  ⇒ 「消失 0 条」只覆盖 literal 那部分；dynamic 那部分没有棘轮。")

    if "--update" in sys.argv:
        baseline_path.write_text(
            json.dumps({"names": sorted(current)}, ensure_ascii=False, indent=1) + "\n",
            encoding="utf-8",
        )
        print(f"✓ 基线已更新：{BASELINE}（{len(current)} 条）")
        return 0

    if not baseline_path.exists():
        print(f"✗ 缺少基线 {BASELINE}；先跑 --update 生成", file=sys.stderr)
        return 1

    baseline = set(json.loads(baseline_path.read_text(encoding="utf-8"))["names"])
    disappeared = sorted(baseline - current)
    added = sorted(current - baseline)

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
        print("✓ 测试清单与基线一致：无消失、无新增")
    return 0


if __name__ == "__main__":
    sys.exit(main())
