#!/usr/bin/env python3
"""上手指南里写死的通道版本号,必须和真正要发的那个版本对上。

为什么需要这道门
================

`docs-site/**/guide/getting-started.md` 里有一整套**带版本号的行为断言** —— 不是"某某
版本存在",而是"**在这个版本上会发生什么**":

    · **latest(当前 `2.2.21`)**:裸崩 `Error: spawn bunx ENOENT` + Node 堆栈
    | `latest` = `2.2.21` | 固定的 `anethub` |
    | `preview` = `2.3.0-preview.39` | **随机串**,形如 `anet-...` |

这些句子**今天是真的**(#952 里逐条实跑过)。但它们在**下一次发版的那一刻**同时变假,
而且是往最糟的方向变假:新用户会读到"stable 上第一条命令会裸崩",而那时 stable 已经修好了。
**一句劝退用户的假话,比一句过期的版本号严重得多。**

🔴 这道门的触发点是刻意选的:**它跑在 release gate 里,不是每个 PR 上。**
   文档变假的时刻不是"有人改了文档",是"有人发了一个新版本"。把门挂在 PR 上,
   在最需要它的那一类动作上永远不会响。

判据
====

文档顶部带一块**机器可读的戳**(HTML 注释,渲染出来看不见):

    <!-- version-claim: package=agent-network channel=latest version=2.2.21 -->

两种模式:

  **结构模式**(无参数,PR/push 上跑)
    - 每个待检文档至少有 1 条戳,否则 exit 2(戳被整块删掉 = 门失效,不能报绿)
    - 每条戳声明的 version 字符串,必须在**同一个文件的正文里真的出现过**
      —— 抓"戳更新了但表格没改"

  **发版模式**(`--package P --version V`,release gate 里跑)
    - 由 V 是不是预发布版(含 `-`)推出 channel:有 `-` → preview,没有 → latest
    - 该 (package, channel) 下的每一条戳,version 必须等于 V
    - 红了的时候,把**文件里所有出现旧版本串的行**都打出来 —— 修法是机械的

这道门不保证什么
================

它只管**被戳标记的那些**版本号。文档里还有大量**历史性**的版本引用(`≤ 2.3.0-preview.37`、
"`2.3.0-preview.38` 里 verified"),那些**本来就该保持不变** —— 它们讲的是历史,不是现状。
把两者分开的唯一办法是让作者标出来,所以才有戳。**没戳的地方它看不见,这是设计,不是漏洞。**
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

DOCS = [
    "docs-site/docs/guide/getting-started.md",
    "docs-site/docs/en/guide/getting-started.md",
]

STAMP = re.compile(
    r"<!--\s*version-claim:\s*package=([A-Za-z0-9@/._-]+)\s+"
    r"channel=([a-z]+)\s+version=([0-9A-Za-z.+-]+)\s*-->"
)


def channel_of(version: str) -> str:
    return "preview" if "-" in version else "latest"


def parse(text: str) -> list[tuple[int, str, str, str]]:
    out = []
    for lineno, line in enumerate(text.split("\n"), 1):
        for m in STAMP.finditer(line):
            out.append((lineno, m.group(1), m.group(2), m.group(3)))
    return out


def run(repo: Path, package: str | None, version: str | None) -> int:
    problems = 0
    total_stamps = 0
    for rel in DOCS:
        path = repo / rel
        if not path.is_file():
            print(f"::error::待检文档不存在: {rel}")
            return 2
        text = path.read_text(encoding="utf-8")
        stamps = parse(text)
        if not stamps:
            print(f"::error file={rel}::0 条 version-claim 戳 —— 判据没变,是取集塌了")
            return 2
        total_stamps += len(stamps)

        for lineno, pkg, chan, ver in stamps:
            if channel_of(ver) != chan:
                print(f"::error file={rel},line={lineno}::戳自相矛盾: version={ver} "
                      f"看起来是 {channel_of(ver)} 通道,但 channel={chan}")
                problems += 1
            # 戳必须能在正文里落地,否则就是一条只对自己成立的声明
            body = "\n".join(l for i, l in enumerate(text.split("\n"), 1) if i != lineno)
            if ver not in body:
                print(f"::error file={rel},line={lineno}::戳说 {chan}={ver},"
                      f"但正文里一次都没出现这个串 —— 戳更新了正文没改?")
                problems += 1

            if package and version and pkg == package and chan == channel_of(version):
                if ver != version:
                    print(f"::error file={rel},line={lineno}::正在发 {package}@{version}"
                          f"({chan} 通道),而文档仍然断言 {chan}={ver}")
                    problems += 1
                    for i, l in enumerate(text.split("\n"), 1):
                        if ver in l and i != lineno:
                            print(f"    {rel}:{i}: {l.strip()[:120]}")

    print(f"checked {total_stamps} version-claim stamp(s) across {len(DOCS)} doc(s)"
          + (f"; releasing {package}@{version} ({channel_of(version)})" if package and version else ""))
    if problems:
        print(f"\n{problems} problem(s).")
        print("修法:把上面列出的每一行改成新版本上实测的行为,再更新对应的戳。")
        print("🔴 不要只改戳 —— 戳和正文不一致时这道门也会红(那正是它的第二条判据)。")
        return 1
    print("每一条被标记的版本断言都指着正在发的那个版本。")
    return 0


def selftest() -> int:
    OPEN, CLOSE = "<!" + "--", "--" + ">"

    def stamp(pkg: str, chan: str, ver: str) -> str:
        return f"{OPEN} version-claim: package={pkg} channel={chan} version={ver} {CLOSE}"

    cases = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        cases.append((name, ok, detail))

    s = parse(stamp("agent-network", "latest", "2.2.21"))
    check("戳能被解析", s == [(1, "agent-network", "latest", "2.2.21")], repr(s))
    check("没有戳的文本解析出 0 条(上游据此 exit 2)", parse("普通正文") == [])
    check("预发布版判成 preview", channel_of("2.3.0-preview.39") == "preview")
    check("正式版判成 latest", channel_of("2.2.21") == "latest")
    check("build 元数据不算预发布", channel_of("2.2.21+build.7") == "latest")
    # 一行里两条戳(中英同表)也要都拿到
    two = parse(stamp("agent-network", "latest", "1.0.0") + " " + stamp("agent-node", "preview", "1.0.0-preview.1"))
    check("一行两条戳都被收下", len(two) == 2, f"got {len(two)}")

    for name, ok, detail in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}" + (f"   [{detail}]" if detail and not ok else ""))
    bad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - bad}/{len(cases)} ok")
    return 1 if bad else 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--package")
    ap.add_argument("--version")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if bool(args.package) != bool(args.version):
        print("::error::--package 和 --version 必须一起给", file=sys.stderr)
        return 2
    repo = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"],
                               capture_output=True, text=True, check=True).stdout.strip())
    return run(repo, args.package, args.version)


if __name__ == "__main__":
    sys.exit(main())
