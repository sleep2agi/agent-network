#!/usr/bin/env python3
"""套件覆盖率对账：tests/<suite>/ 里有多少目录**根本没有被执行**。

为什么需要它
============
2026-10-29 一晚遇到两次同一个形状：

  · test668-grok-working-status 在 qa.yml 里出现两次，但都是 `paths:` 过滤器，
    不是任何 matrix 条目 ⇒ 最近 8 条 run 里含它的 job 数 = 0；
  · test466-codex-copresence-p3 同样只在 paths 过滤器里，从未执行。

两次都是靠手工翻日志发现的。这类问题的共同点是：**名字在配置里出现过，
所以看起来"有覆盖"，但它在执行路径上不存在。** 只有去数 job、或者像这样对账，
才能看见差别。

口径（三路都算"会被跑"）
========================
1. `.github/workflows/*.yml` 里对套件名的引用（矩阵条目 / 步骤名 / 注释里的路径）
2. `scripts/qa.sh` 里的本地 L0/L1 套件数组
3. 明确排除"动态全量遍历"：如果哪天出现 `for … in tests/*` 之类的全量执行，
   本脚本的结论就不再成立 —— 所以脚本会先检查这一点并在命中时报警。

用法
====
    python3 scripts/qa-suite-coverage.py            # 只打印汇总与"两边都没有"的清单
    python3 scripts/qa-suite-coverage.py --json     # 机器可读
    python3 scripts/qa-suite-coverage.py --fail-on-gap   # 有"两边都没有"时退出码 1

注意：**不要把它做成 CI 门禁**。这 70 个目录里很大一部分是刻意保留的手工/一次性
套件（test1-newuser、test2-collab、test-rfc029-pr1..4 …）。把"未被执行"一律当红，
会逼着人去删目录或加无意义的 job。它是一份**对账报表**，不是判据。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
WORKFLOWS = ROOT / ".github" / "workflows"
QA_SH = ROOT / "scripts" / "qa.sh"


def suite_dirs() -> list[str]:
    """有 run.sh 的套件目录。没有 run.sh 的（纯 Dockerfile/文档）不算套件。"""
    return sorted(p.parent.name for p in TESTS.glob("*/run.sh"))


def cited(name: str, text: str) -> bool:
    # 词边界匹配：避免 test1 命中 test10 / test100
    return re.search(rf"(?<![\w.-]){re.escape(name)}(?![\w.-])", text) is not None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--fail-on-gap", action="store_true")
    args = ap.parse_args()

    dirs = suite_dirs()
    if not dirs:
        print("no suite dirs found — wrong cwd?", file=sys.stderr)
        return 2

    wf_text = "\n".join(p.read_text() for p in sorted(WORKFLOWS.glob("*.yml")))
    qa_text = QA_SH.read_text() if QA_SH.exists() else ""

    # 动态全量遍历会推翻本脚本的结论，先检查
    dynamic = re.search(r"for\s+\w+\s+in\s+[^\n]*tests/\*", qa_text + wf_text)

    in_wf = [d for d in dirs if cited(d, wf_text)]
    in_qa = [d for d in dirs if cited(d, qa_text)]
    gap = [d for d in dirs if not cited(d, wf_text) and not cited(d, qa_text)]

    result = {
        "suite_dirs": len(dirs),
        "cited_in_workflows": len(in_wf),
        "cited_in_qa_sh": len(in_qa),
        "cited_in_neither": len(gap),
        "gap": gap,
        "dynamic_globbing_detected": bool(dynamic),
    }

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"suite dirs            {len(dirs)}")
        print(f"cited in workflows    {len(in_wf)}")
        print(f"cited in scripts/qa.sh {len(in_qa)}")
        print(f"cited in neither      {len(gap)}")
        if dynamic:
            print("\n⚠️  检测到动态全量遍历（for … in tests/*）—— 上面的 'cited in neither' 不再成立")
        print("\n未被任何执行入口引用的套件：")
        for d in gap:
            print(f"  {d}")

    if args.fail_on_gap and gap:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
