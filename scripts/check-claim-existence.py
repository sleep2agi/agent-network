#!/usr/bin/env python3
"""声明的存在性核对：把「本仓有/没有 X」变成一次 grep。

2026-10-31 —— 外部复核 ③（原话）：
    「每个『字段/计数器』条目必须带 落地状态: existing(file:line) | proposal。
      加脚本：抽出卡里所有标识符逐个 grep，0 命中 ⇒ 自动标 proposal，不许标 existing。」

起因是两个人在同一晚连续两轮讨论「本仓里并不存在的名字」——
一次是 `procStart`，一次是 5 个字段名全 0 命中。**这不是不细心，是缺一列。**

用法：
    python3 scripts/check-claim-existence.py 报告.md      # 或从 stdin 读
    python3 scripts/check-claim-existence.py --json 报告.md

抽取规则（只认反引号里的内容，避免把散文当标识符）：
    `foo.ts:123`   → 路径存在即可
    `SomeName`     → 全文 grep
    `some_func()`  → 去掉括号后 grep

退出码：0 = 全部命中 ｜ 1 = 有 0 命中的名字（应标 proposal）｜ 2 = 没有可核的标识符（没有读数）。
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CODE_SPAN = re.compile(r"`([^`\n]{2,120})`")
IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{2,}$")
PATH_LIKE = re.compile(r"^[\w./\-]+\.(ts|js|py|sh|json|md|yml|yaml)(:\d+)?$")
# 明显不是本仓标识符的（避免噪声）：命令、URL、版本号、全大写环境变量等
SKIP_PREFIX = ("http://", "https://", "/api/", "--", "$ ")


def candidates(text: str) -> list[str]:
    out: list[str] = []
    for m in CODE_SPAN.finditer(text):
        span = m.group(1).strip()
        if span.startswith(SKIP_PREFIX):
            continue
        if PATH_LIKE.match(span):
            out.append(span.split(":")[0])
            continue
        tok = span.rstrip("()")
        if IDENT.match(tok):
            out.append(tok)
    # 去重但保序
    seen: set[str] = set()
    uniq = []
    for x in out:
        if x not in seen:
            seen.add(x)
            uniq.append(x)
    return uniq


def exists(name: str) -> bool:
    p = REPO / name
    if "/" in name and p.exists():
        return True
    r = subprocess.run(["git", "grep", "-F", "-q", "--", name], cwd=REPO)
    return r.returncode == 0


SELFTEST_VECTORS = [
    ("`parseCorsOrigins` 在这里", "parseCorsOrigins", True),
    ("`definitelyNotInThisRepo12345` 在这里", "definitelyNotInThisRepo12345", False),
]


def selftest(quiet: bool = False) -> int:
    fails = 0
    for text, name, want in SELFTEST_VECTORS:
        got = exists(name)
        ok = got == want
        if not quiet:
            print(f"  {'✓' if ok else '✗'} 期望存在={want} 实际={got}  {name}")
        fails += 0 if ok else 1
    # 抽取规则本身也要自检（否则「0 个标识符」会被当通过）
    got = candidates("`foo_bar` 与 `https://x` 与 `a/b.ts:12`")
    want = ["foo_bar", "a/b.ts"]
    if got != want:
        fails += 1
        if not quiet:
            print(f"  ✗ 抽取规则：期望 {want} 实际 {got}")
    elif not quiet:
        print("  ✓ 抽取规则：反引号内的标识符/路径，URL 被跳过")
    if not quiet:
        print(f"  selftest: {'通过' if fails == 0 else f'{fails} 条失败'}")
    return 0 if fails == 0 else 1


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    args = [a for a in argv if not a.startswith("--")]
    text = Path(args[0]).read_text(encoding="utf-8", errors="replace") if args else sys.stdin.read()
    names = candidates(text)
    if not names:
        print("没有可核的标识符（反引号里没有本仓名字）⇒ 没有读数", file=sys.stderr)
        return 2
    missing = [n for n in names if not exists(n)]
    if "--json" in argv:
        print(json.dumps({"checked": len(names), "missing": missing}, ensure_ascii=False, indent=2))
        return 1 if missing else 0
    print(f"核对 {len(names)} 个反引号标识符：命中 {len(names) - len(missing)} ｜ 0 命中 {len(missing)}")
    for n in missing:
        print(f"    ✗ {n}  ⇒ 标注为 proposal，不要写 existing/已存在")
    if missing:
        print("  ⇒ 0 命中的名字要么是本仓外的（写清是哪个系统），要么是提案（写 proposal）。", file=sys.stderr)
        return 1
    print("  ✓ 全部命中：这些名字在本仓真的存在")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
