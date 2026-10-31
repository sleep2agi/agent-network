#!/usr/bin/env python3
"""jq `//` 的缺席折叠：**它把 `false` 也当成「没有」**。

2026-10-31 —— 外部复核 ④（原话）：
    「jq 的 `//` 在左侧为 null **或 false** 时取右边 ⇒ 合法的 false 被折成『缺失』。
      这与 JS 的 `??` 只认 nullish 不同：**jq 把 false 也当缺席**。
      ⇒ 证据 JSON 若写 `(.status // "missing")`，`status:false` 会显示成 missing。」

两种方向，后果不同：
  `// true`  ⇒ 「字段缺席」被折成**通过**（fail-open，最危险）
  `// false` ⇒ 「字段缺席」与「字段为 false」不可区分（fail-closed，但仍丢信息）
  `// "..."`/`// {}`/`// 0` ⇒ 只有在被折叠的字段**可能是布尔**时才有问题

退出码：0 = 没有 fail-open 折叠 ｜ 1 = 有 ｜ 2 = 扫描域为空（没有读数）。

用法：python3 scripts/check-jq-default-operator.py [--json]
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SCAN_EXT = ("*.sh", "*.ts", "*.md")

# 2026-10-31 —— **排除集必须显式、且每条都能被点名**（外部复核 (b)：
# 「扫描域的排除集显式化：_is_excluded(rel) 只按常量判断，不做隐藏过滤；
#   每个被排除的文件都要命中一条显式规则 —— 没有『看不见的手』」）。
EXCLUDED_DIRS = ("node_modules",)
EXCLUDED_GLOBS = ("package-lock.json",)

# `jq ... // true` —— 缺席即通过
FAIL_OPEN = re.compile(r"\|\s*jq\b[^\n]*//\s*true\b")
# 单独一行的 jq 表达式里 `// true`（例如 jq -r '(.ok // true)'）
FAIL_OPEN_INLINE = re.compile(r"jq[^\n]*['\"][^'\"]*//\s*true\b")
# `// false` —— 折叠但 fail-closed
FAIL_CLOSED = re.compile(r"\|\s*jq\b[^\n]*//\s*false\b|jq[^\n]*['\"][^'\"]*//\s*false\b")


def tracked() -> list[Path]:
    out = subprocess.run(["git", "ls-files", *SCAN_EXT], cwd=REPO, capture_output=True, text=True, timeout=60).stdout
    return [REPO / l for l in out.split("\n") if l.strip()]


def scan() -> tuple[list[dict], list[dict], int]:
    open_hits, closed_hits, files = [], [], 0
    excluded = {"dir": 0, "glob": 0}
    for p in tracked():
        if not p.exists():
            continue
        if any(seg in EXCLUDED_DIRS for seg in p.parts):
            excluded["dir"] += 1
            continue
        if p.name in EXCLUDED_GLOBS:
            excluded["glob"] += 1
            continue
        files += 1
        try:
            lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for i, line in enumerate(lines, 1):
            if line.lstrip().startswith("#"):
                continue
            if FAIL_OPEN.search(line) or FAIL_OPEN_INLINE.search(line):
                open_hits.append({"file": str(p.relative_to(REPO)), "line": i, "text": line.strip()[:140]})
            elif FAIL_CLOSED.search(line):
                closed_hits.append({"file": str(p.relative_to(REPO)), "line": i, "text": line.strip()[:140]})
    return open_hits, closed_hits, files, excluded


SELFTEST = [
    # (源码, 期望 fail-open?)
    ("X=$(echo \"$R\" | jq -r '.ok // true')", True),
    ("X=$(echo \"$R\" | jq -r '.ok // false')", False),
    ("X=$(echo \"$R\" | jq -r '.name // \"\"')", False),
    ("# jq '.ok // true' 只是注释", False),
]


def selftest(quiet: bool = False) -> int:
    fails = 0
    for src, want in SELFTEST:
        if src.lstrip().startswith("#"):
            got = False
        else:
            got = bool(FAIL_OPEN.search(src) or FAIL_OPEN_INLINE.search(src))
        ok = got == want
        if not quiet:
            print(f"  {'✓' if ok else '✗'} want_open={want} got={got}  {src[:60]}")
        fails += 0 if ok else 1
    if not quiet:
        print(f"  selftest: {len(SELFTEST) - fails}/{len(SELFTEST)} 通过")
    return 0 if fails == 0 else 1


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    if selftest(quiet=True) != 0:
        print("✗ 自检未通过 ⇒ 没有读数", file=sys.stderr)
        return 2
    open_hits, closed_hits, files, excluded = scan()
    if files == 0:
        print("扫描域为空 ⇒ 没有读数", file=sys.stderr)
        return 2
    if "--json" in argv:
        print(json.dumps({"files": files, "fail_open": open_hits, "fail_closed": closed_hits}, ensure_ascii=False, indent=2))
        return 1 if open_hits else 0
    print(f"扫描 {files} 个文件（.sh/.ts/.md）")
    # 排除集显式化：这两行让「没扫到」可归因到一条规则，而不是归因到扫描器的脾气
    if not EXCLUDED_DIRS or not EXCLUDED_GLOBS:
        print("✗ 排除规则为空 ⇒ 域声明失效（不许「什么都不排除」却不说明）", file=sys.stderr)
        return 2
    print(f"  排除：dirs={list(EXCLUDED_DIRS)}（{excluded['dir']} 个文件）｜"
          f"globs={list(EXCLUDED_GLOBS)}（{excluded['glob']} 个文件）")
    # 2026-10-31 —— **「0 个文件命中」也是一种读数**：一条从未生效的排除规则
    # 等于给未来某个同名文件预授权。打印出来，别让它静静躺着。
    unused_rules = []
    if excluded["dir"] == 0: unused_rules.append(f"dirs={list(EXCLUDED_DIRS)}")
    if excluded["glob"] == 0: unused_rules.append(f"globs={list(EXCLUDED_GLOBS)}")
    if unused_rules:
        print(f"  ⚠ 当前未命中任何文件（仍保留，但视为「预授权」而非「正在生效」）：{'; '.join(unused_rules)}")
    print(f"  fail-open（`// true`，缺席即通过）：{len(open_hits)} 处")
    print(f"  fail-closed（`// false`，缺席与 false 不可区分）：{len(closed_hits)} 处")
    for h in open_hits[:10]:
        print(f"    ✗ {h['file']}:{h['line']}  {h['text']}")
    for h in closed_hits[:5]:
        print(f"    · {h['file']}:{h['line']}  {h['text']}")
    if open_hits:
        print("  ⇒ 缺席折叠成通过：把 `// true` 改成显式三态（有值 / 缺失 / false 分别处理）。", file=sys.stderr)
        return 1
    print("  ✓ 没有把「缺席」折成「通过」的地方（fail-closed 的折叠仍会丢信息，但不会误放行）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
