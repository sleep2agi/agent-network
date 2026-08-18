#!/usr/bin/env python3
"""新增的测试套件必须能被 CI 跑到，或者写明为什么不进 CI。

## 背景（#861）

2026-08-13 的普查：194 个 `tests/<dir>/run.sh` 里只有 21 个被 CI 引用。
2026-08-18 用同一口径复量：197 个里 33 个被引用，**164 个孤儿**。
5 天里接进去 12 个，方向对，但绝对数没有实质变化。

孤儿不是「坏」——里面有一次性验证、事故复现件、被后续套件取代的。把它们一股脑塞进
CI 只会让 CI 变慢并制造噪音（#861 正文明确说了这一点）。真正的问题是**没有任何机制
保证「套件存在」和「CI 会跑它」一致**，于是缺口按每个新 PR 的速率继续长：
PR #812 正在新增的 `tests/test812-tmux-target-semantics/` 就是下一个，
而那条 PR 的目的恰恰是「把文档里那几行 tmux 命令绑到实测语义」——
绑住它的将是一个不会被执行的测试。

## 🔴 这道门不要求清零，和 check-home-path-baseline.py 是同一个理由

要求清零的门第一天就是红的；而**一道只因积压而红的门，等积压清完就再也不会红，
到时没人知道它还有没有效**。所以基线里记着今天这 164 个，门只对**新增的**孤儿变红。

存量变好（某个套件后来接进了 CI，或补了 NOT-IN-CI.md）打 note、不判红 ——
这是本仓既有棘轮的立场，不在这里收紧。把它那一行从基线里删掉即可，楼层只降不回填。

## 判据

对每个 `tests/<dir>/run.sh` 存在的目录：

  1. 目录名出现在 `scripts/qa.sh` 或任意 `.github/workflows/*`  → 可以被跑到，OK
  2. 目录里有 `NOT-IN-CI.md`                                    → 明确声明不进 CI，OK
  3. 在基线文件里                                                → 存量，OK
  4. 以上都不是                                                  → 🔴 新增孤儿，红

判据 1 用的是 #861 的原口径（目录名出现在那两处），**刻意和它保持一致**，
这样两边的数字可以直接比 —— 换口径的对比会把方法差异伪装成进展。

它不判「这个套件该不该进 CI」。那是 #861 要的那次逐个分类，门做不了。
门只保证：**新增一个套件时，这个问题被回答过一次。**
"""
from __future__ import annotations

import pathlib
import subprocess
import re
import sys

REPO = pathlib.Path(__file__).resolve().parents[2]
TESTS = REPO / "tests"
BASELINE = REPO / "docs" / "test-suite-orphan-baseline.txt"
EXEMPT_MARKER = "NOT-IN-CI.md"
# 超过这个天数的豁免只打 note（不判红，理由见 exemption_meta 上方注释）。
EXEMPT_STALE_DAYS = 30

# 🔴 一份豁免必须自己写明「什么时候该被撤销」和「上次核实是哪天」。
#
#    起因是 agent-network/bin/cli.ts 里那条 workaround 上的一句话：
#        a temporary workaround that WRITES DOWN its expiry condition is better
#        than one that doesn't — but only if someone re-reads it.
#        Nothing re-evaluates a condition stored in a comment.
#
#    我今晚写的 4 份 NOT-IN-CI.md 正是这个形状：撤销条件写在 markdown 里，
#    没有任何东西会重新评估它们。所以在这里加两条机械约束：
#
#    ① 缺 `Verified:` / `Revisit-when:` → **红**。
#       一份不写撤销条件的豁免是无限期豁免，和「新增孤儿」是同一类问题，红得一致。
#    ② 陈旧 → **只打 note，不红**。
#       按日期判红是「定时炸弹」：它会在某个和这件事无关的 PR 上炸，
#       然后被那个人顺手加个豁免绕过去 —— 那比不检查更糟。
#       改成把**每份豁免的天数打进每次都会出现的汇总行** ——
#       一个在 CI 日志里每次都看得见的数字，比一份没人打开的 markdown 有效。
VERIFIED_RE = re.compile(r"^Verified:\s*(\d{4}-\d{2}-\d{2})\s*$", re.M)
REVISIT_RE = re.compile(r"^Revisit-when:\s*(\S.*)$", re.M)


def exemption_meta(path):
    """读一份 NOT-IN-CI.md 的机械头。返回 (verified_date|None, revisit|None)。"""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return (None, None)
    v = VERIFIED_RE.search(text)
    r = REVISIT_RE.search(text)
    return (v.group(1) if v else None, r.group(1).strip() if r else None)




def read(p: pathlib.Path) -> str:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def suites() -> list[str]:
    if not TESTS.is_dir():
        return []
    return sorted(d.name for d in TESTS.iterdir()
                  if d.is_dir() and (d / "run.sh").exists())


def registration_blob() -> str:
    blob = read(REPO / "scripts" / "qa.sh")
    wf = REPO / ".github" / "workflows"
    if wf.is_dir():
        for p in sorted(wf.iterdir()):
            if p.is_file():
                blob += read(p)
    return blob


def classify(names: list[str], blob: str, tests_dir: pathlib.Path,
             baseline: set[str]) -> dict[str, list[str]]:
    """唯一的判据实现。main() 和 selftest() 都调它 ——

    selftest 里再写一遍判据只能证明「我写的两遍一样」，对真代码做变异不会红。
    这一点今晚踩过：自造判据四次，四次都比真判据松。
    """
    registered = [s for s in names if s in blob]
    exempt = [s for s in names if (tests_dir / s / EXEMPT_MARKER).exists()]
    orphans = [s for s in names
               if s not in blob and not (tests_dir / s / EXEMPT_MARKER).exists()]
    return {
        "registered": registered,
        "exempt": exempt,
        "orphans": orphans,
        "new": [s for s in orphans if s not in baseline],
        "improved": sorted(baseline - set(orphans)),
    }


def load_baseline() -> set[str]:
    return {ln.strip() for ln in read(BASELINE).splitlines()
            if ln.strip() and not ln.startswith("#")}


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()

    all_suites = suites()
    # 分母承重：一个套件都没取到，说明取集坏了，不是「全都合规」。
    if not all_suites:
        print(f"::error::在 {TESTS} 下一个 tests/<dir>/run.sh 都没找到 —— 取集坏了，不当作通过")
        return 2
    blob = registration_blob()
    if not blob:
        print("::error::scripts/qa.sh 和 .github/workflows/* 都读不到内容 —— 取集坏了，不当作通过")
        return 2

    base = load_baseline()
    if not base:
        print(f"::error::{BASELINE} 缺失或为空 —— 没有楼层可比，拒绝通过")
        return 2

    c = classify(all_suites, blob, TESTS, base)
    registered, exempt, orphans = c["registered"], c["exempt"], c["orphans"]
    new_orphans, improved = c["new"], c["improved"]

    # 每份豁免的元数据：缺头 → 红；陈旧 → note。天数进汇总行,每次都看得见。
    from datetime import date
    today = date.today()
    exempt_ages, exempt_missing = [], []
    for s in exempt:
        verified, revisit = exemption_meta(TESTS / s / EXEMPT_MARKER)
        if not verified or not revisit:
            exempt_missing.append((s, verified, revisit))
            continue
        try:
            y, m, d = (int(x) for x in verified.split("-"))
            exempt_ages.append((s, (today - date(y, m, d)).days))
        except ValueError:
            exempt_missing.append((s, verified, revisit))

    oldest = f" (oldest {max(a for _, a in exempt_ages)}d)" if exempt_ages else ""
    print(f"suites={len(all_suites)} registered={len(registered)} "
          f"exempt={len(exempt)}{oldest} orphans={len(orphans)} "
          f"baseline={len(base)} new={len(new_orphans)}")

    for s, verified, revisit in exempt_missing:
        missing = []
        if not verified:
            missing.append("`Verified: YYYY-MM-DD`（上次真跑过它是哪天）")
        if not revisit:
            missing.append("`Revisit-when: ...`（什么条件成立时该撤销这份豁免）")
        print(f"::error file=tests/{s}/{EXEMPT_MARKER}::"
              f"豁免缺少机械头：{' 和 '.join(missing)}。"
              f"一份不写撤销条件的豁免是**无限期**豁免 —— 它和「新增孤儿」是同一类问题："
              f"都没有回答「谁、在什么条件下，会重新看它一眼」。")
    for s, age in sorted(exempt_ages, key=lambda x: -x[1]):
        if age > EXEMPT_STALE_DAYS:
            print(f"note: 豁免 {s} 已 {age} 天未复核（阈值 {EXEMPT_STALE_DAYS} 天）—— "
                  f"重跑一次并更新 Verified:，或按它自己写的 Revisit-when: 撤销它。"
                  f"**这条只提示不判红**：按日期判红会在无关的 PR 上炸，然后被顺手绕过。")

    if improved:
        print(f"note: {len(improved)} 个套件已不再是孤儿，把它们从 "
              f"{BASELINE.relative_to(REPO)} 里删掉，楼层只降不回填：{', '.join(improved[:8])}"
              + (" …" if len(improved) > 8 else ""))

    if not new_orphans and not exempt_missing:
        print("no new unregistered test suite.")
        return 0

    if exempt_missing and not new_orphans:
        print(f"\n{len(exempt_missing)} 份豁免没有回答「什么条件下该撤销它」。")
        return 1

    for s in new_orphans:
        print(f"::error file=tests/{s}/run.sh::新增的测试套件 `{s}` 不会被任何 CI 跑到。"
              f"二选一：(a) 接进 CI —— 加进 scripts/qa.sh 的 L1_TESTS **并且**把 "
              f"tests/{s}/** 加进对应 workflow 的 paths（漏掉后一步 check-l1-paths-sync 会红）；"
              f"(b) 在 tests/{s}/{EXEMPT_MARKER} 里写明为什么它不进 CI（一次性验证／事故复现件／"
              f"已被后续套件取代）。")
    print(f"\n{len(new_orphans)} 个新增套件没有回答「谁会跑它」。")
    return 1


def selftest() -> int:
    """判据自检。绿和「取集坏了」打印出来是两码事，这里把两者都钉住。"""
    import tempfile
    cases = [
        # (目录名, 是否出现在注册表, 是否有 NOT-IN-CI.md, 是否在基线, 期望判为新孤儿)
        ("test900-wired", True, False, False, False),
        ("test901-exempt", False, True, False, False),
        ("test902-known", False, False, True, False),
        ("test903-new", False, False, False, True),
        ("test904-wired-and-known", True, False, True, False),
    ]
    bad = 0
    with tempfile.TemporaryDirectory() as td:
        for name, reg, ex, inbase, want in cases:
            blob = f"tests/{name}/**" if reg else ""
            d = pathlib.Path(td) / name
            d.mkdir(parents=True, exist_ok=True)
            (d / "run.sh").write_text("#!/bin/bash\n", encoding="utf-8")
            if ex:
                (d / EXEMPT_MARKER).write_text("一次性验证\n", encoding="utf-8")
            base = {name} if inbase else set()
            got = name in classify([name], blob, pathlib.Path(td), base)["new"]
            if got != want:
                bad += 1
                print(f"SELFTEST 失配: {name} got={got} want={want}")
    print(f"selftest {len(cases) - bad}/{len(cases)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
