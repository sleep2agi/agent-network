#!/usr/bin/env python3
"""发版会让哪些文档句子当场变假 —— 这份清单不能靠手工维护。

## 为什么需要它

docs 里有一类版本号是**故意**留着的:限定信道的**行为断言** ——
「latest `2.2.21` 会裸崩,preview 会被 preflight 拦下」。
去掉版本号这句话就没有意义,所以它们不能像别的 doc 那样清版本号。

代价是:**latest 或 preview 一发布,它们立刻变成假的**,
而且是危险的那种假 —— 会告诉用户一道已经存在的安全 preflight 不存在。

`docs/RELEASE-SOP.md` 里有一张「逐次发版必须重新核对」的表。
**那张表的分母已经错过三次:7 → 8 → 12 → 实测 20。**
SOP 自己写着「加新断言时同时加进这张表」,而那条纪律靠人记,记不住。

## 判据

扫 `docs-site/docs/**/*.md`,找出**同一行里同时出现**
`latest`/`preview` 字样与一个具体版本号的行 —— 那就是信道断言的形状。
每一个这样的文件都必须在 SOP 表里登记。**没登记 = 红。**

## 🔴 刻意不做的两件事

1. **不扫「只出现版本号」的行。** 那样会把带日期的实测记录也算进来
   (例:`deploy/daemon.md` 的「实测 2026-08-18,用当时的 latest 2.2.21」)——
   那种句子**不会因为发版变假**,它说的就是那一天的事。把它拉进清单
   会让清单变长而信号变弱,而变弱的清单下次就没人逐条核了。
2. **不校验版本号是不是最新。** 那是发版时的动作,不是常态门的职责;
   把它做成常态门会在每次发版后立刻全红,变成必须绕过的墙纸。
"""
from __future__ import annotations
import re, sys
from pathlib import Path

DOCS = Path("docs-site/docs")
SOP = Path("docs/RELEASE-SOP.md")
VERSION = re.compile(r"\b\d+\.\d+\.\d+(?:-preview\.\d+)?\b")
CHANNEL = re.compile(r"\blatest\b|\bpreview\b", re.IGNORECASE)

def assertion_files() -> dict[str, list[int]]:
    found: dict[str, list[int]] = {}
    for p in sorted(DOCS.rglob("*.md")):
        rel = p.as_posix()
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            if VERSION.search(line) and CHANNEL.search(line):
                found.setdefault(rel, []).append(i)
    return found

def main() -> int:
    if not DOCS.is_dir() or not SOP.is_file():
        print("::error::取集塌了:找不到 docs-site/docs 或 RELEASE-SOP.md —— 拒绝通过", file=sys.stderr)
        return 2                                  # 说不清楚就不说「没问题」
    sop = SOP.read_text(encoding="utf-8")
    found = assertion_files()
    if not found:
        print("::error::零命中。信道断言不可能一条都没有 —— 更可能是扫描范围错了", file=sys.stderr)
        return 2
    missing = [f for f in found if f not in sop]
    print(f"扫到带信道断言的文件 {len(found)} 个;RELEASE-SOP 已登记 {len(found) - len(missing)} 个")
    for f in sorted(found):
        mark = "MISS" if f in missing else "ok  "
        print(f"  {mark} {f}  行 {found[f][:6]}")
    if missing:
        print(f"\n::error::{len(missing)} 个文件带信道断言但没登记进 docs/RELEASE-SOP.md。", file=sys.stderr)
        print("发版当刻它们会静默变假,而没有任何清单会提醒任何人。", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
