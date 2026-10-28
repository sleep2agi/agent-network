#!/usr/bin/env python3
"""#2136 第三步的第 ① 步：**只报告**，不改任何 workflow 行为。

给定一次改动的文件清单，回答：qa.yml 那 130 个 Docker 套件里，
哪些**按"只跑自己相关子树"的规则可以跳过**、哪些必须跑。

为什么要先有这个脚本：
    qa.yml 的 push/PR 路径表是"全有或全无"——命中任意一条 `tests/**` 就触发整矩阵。
    真要按套件收窄，"判据写错 = 某个套件该跑没跑"比红更糟。所以先做**观测器**：
    拿历史 PR 的 diff 回放，人肉确认"该跳的都跳、该跑的没漏"，再谈把它接进 workflow。

判据（保守，宁可多跑）：
    一个 `tests/<suite>/` 套件可以跳过 ⇔ 本次改动**既没碰它自己**，
    也没碰任何共享面：
        server/**            agent-node/**        agent-network/**
        tests/lib/**         tests/Dockerfile     tests/test-all.sh
        scripts/qa.sh        .github/**
    任何"看不清"的形状（空清单、取不到 diff、路径不规整）→ **全部照跑**。

用法：
    python3 scripts/qa-suite-scope-report.py --files a.ts,b.md
    python3 scripts/qa-suite-scope-report.py --base origin/main --head HEAD
    git diff --name-only origin/main...HEAD | python3 scripts/qa-suite-scope-report.py --stdin
"""
from __future__ import annotations

import argparse
import re
import subprocess
import json
import sys
from pathlib import Path

QA_YML = Path(".github/workflows/qa.yml")

SHARED_PREFIXES = (
    "server/",
    "agent-node/",
    "agent-network/",
    "tests/lib/",
    ".github/",
)
SHARED_FILES = {
    "tests/Dockerfile",
    "tests/test-all.sh",
    "scripts/qa.sh",
}


def suite_list() -> list[str]:
    """qa.yml 里 `hub-orphan-gates` 矩阵列出的套件名。

    只取这个 job 的 `suite:` 列表 —— 早先的实现对整份 qa.yml 做 grep，
    于是把 `grok-green-suites` / `hub-boundary-gates` 等**别的矩阵**的条目也收了进来
    （93 个，而 hub 矩阵是 95 个），既有名字对不上的问题，也让 10 个 `qa-*` 套件
    永远进不了 skip 名单。现在按块解析，并且不再假设名字以 `test` 开头。
    """
    lines = QA_YML.read_text(encoding="utf-8").splitlines()
    start = next((i for i, line in enumerate(lines) if re.match(r"^\s{2}hub-orphan-gates:\s*$", line)), None)
    if start is None:
        return []  # 找不到这个 job -> 调用方按「全跑」处理
    out: list[str] = []
    seen_suite_key = False
    for line in lines[start + 1:]:
        if re.match(r"^\s{2}\S", line):  # 下一个 job（同级缩进）
            break
        if re.match(r"^\s+suite:\s*$", line):
            seen_suite_key = True
            continue
        m = re.match(r"^\s+-\s+(\S+)\s*$", line)
        if seen_suite_key and m:
            out.append(m.group(1))
    return sorted(set(out))


def is_shared(path: str) -> bool:
    return path.startswith(SHARED_PREFIXES) or path in SHARED_FILES


def decide(changed: list[str], suites: list[str]) -> tuple[list[str], list[str], list[str]]:
    if not changed:
        return suites, [], []  # 看不清 → 全跑
    shared = [p for p in changed if is_shared(p)]
    if shared:
        return suites, [], shared  # 共享面动了 → 全跑（这正是套件存在的意义）

    run: list[str] = []
    skip: list[str] = []
    for suite in suites:
        prefix = f"tests/{suite}/"
        if any(p.startswith(prefix) for p in changed):
            run.append(suite)
        else:
            skip.append(suite)
    return run, skip, []


def changed_from_git(base: str, head: str) -> list[str]:
    out = subprocess.run(
        ["git", "diff", "--name-only", "--no-renames", f"{base}...{head}"],
        capture_output=True, text=True, check=True,
    ).stdout
    return [line.strip() for line in out.splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Report which qa.yml suites a change would need (observability only).")
    ap.add_argument("--files", help="comma-separated changed paths")
    ap.add_argument("--stdin", action="store_true", help="read changed paths from stdin, one per line")
    ap.add_argument("--base", help="git base ref (used with --head)")
    ap.add_argument("--head", default="HEAD", help="git head ref")
    ap.add_argument("--json", action="store_true",
                    help="emit {run,skip} as JSON on stdout (for the workflow matrix exclusion)")
    args = ap.parse_args(argv)

    if args.files:
        changed = [p.strip() for p in args.files.split(",") if p.strip()]
    elif args.stdin:
        changed = [line.strip() for line in sys.stdin if line.strip()]
    elif args.base:
        changed = changed_from_git(args.base, args.head)
    else:
        print("需要 --files / --stdin / --base 之一", file=sys.stderr)
        return 2

    suites = suite_list()
    run, skip, forced = decide(changed, suites)
    total = len(suites)
    if args.json:
        # 只给机器读：run/skip 都是套件名数组。任何异常都由调用方按「全跑」处理。
        print(json.dumps({"run": run, "skip": skip}, ensure_ascii=False))
        return 0
    print(f"changed files: {len(changed)}")
    print(f"suites in matrix: {total}")
    if forced:
        print(f"共享面命中 {len(forced)} 个（{', '.join(forced[:4])}{' …' if len(forced) > 4 else ''}）→ 全部照跑")
    print(f"would RUN : {len(run)}")
    print(f"would SKIP: {len(skip)}")
    if skip and total <= 20:
        for s in skip:
            print(f"   skip {s}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
