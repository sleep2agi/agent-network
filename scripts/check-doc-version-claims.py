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

🔴 latest 戳为什么会一直漂(2026-08-30 补)
=========================================

**发版模式只比"正在发的那个通道"的戳。** 发 preview 时 `channel_of(V)` = preview,
于是**只有 preview 戳被比对,latest 戳一次都没有被任何东西检查过**。

结果实测:`latest` 戳自 `2.2.21` 起再没动过,而 npm 上的 `dist-tags.latest`
已经是 `2.3.0-preview.47`。正文因此在对 latest 用户撒谎 ——
它说 latest 会裸崩 `spawn bunx ENOENT`,而 `.47` 其实有那道友好 preflight。
**这一族的方向是"劝退用户",正是本文件开头说的最糟那种假。**

⇒ 新增 `--verify-latest-from-npm`:把 latest 戳直接对 `npm view <pkg> dist-tags.latest` 比。
   它需要网络,所以**不放进 per-PR 的结构模式**(那会给每次合并加一个网络依赖);
   放在已经要联网的那些定时/发版流程里。
   🔴 **取不到 npm 数据 → exit 2(说不清楚就不说没问题),不是绿。**

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


def channel_shape_conflict(chan: str, ver: str, npm_latest_for_pkg: str | None) -> bool:
    """戳的 channel 和版本号形状对不上时,是不是真的矛盾。

    🔴 `channel_of()` 是个**启发式**:靠"有没有 `-`"猜通道。它隐含一条假设 ——
    **预发布版号只可能挂在 preview 上**。这个仓的发布实践violates 了它:
    2026-08-26 一次**未带 `--tag preview` 的手工 publish**,让 npm 的
    `dist-tags.latest` 直接指到了 `2.3.0-preview.47`。

    所以当我们**手上有 npm 的真值**、且它确认 latest 就是这个版本时,
    启发式必须让位 —— 戳是对的,猜错的是那条形状规则。
    没有真值时(结构模式/发版模式)仍按原来的启发式判,行为不变。
    """
    if channel_of(ver) == chan:
        return False
    if npm_latest_for_pkg is None:
        # 🔴 没有真值时**不判红**。原来这里是硬错误,依据是"预发布版号只可能在 preview"——
        #    而这条不变量已经**不成立**(latest 现在就指着 2.3.0-preview.47)。
        #    没有 npm 数据时,"戳写错了"和"latest 真的指着预发布版"**读起来完全一样**,
        #    分不开就不该判。分不开还判,就是拿一条已知会误报的规则去挡 main。
        #    ⇒ 降级为提示;真正的判定交给 --verify-latest-from-npm(它有真值)。
        return False
    if chan == "latest" and npm_latest_for_pkg == ver:
        return False          # npm 说它就是 latest —— 以真值为准
    return True


def channel_shape_note(chan: str, ver: str, npm_latest_for_pkg: str | None) -> bool:
    """形状对不上、但没有真值可判 —— 值得打印一句,不判红。"""
    return channel_of(ver) != chan and npm_latest_for_pkg is None


def latest_stamp_problems(
    stamps: list[tuple[int, str, str, str]], npm_latest: dict[str, str], rel: str
) -> list[str]:
    """latest 戳 vs npm dist-tags.latest。纯函数 —— selftest 不需要网络就能覆盖。

    只看 channel=latest 的戳;preview 戳由发版模式那条路径管。
    """
    out = []
    for lineno, pkg, chan, ver in stamps:
        if chan != "latest":
            continue
        actual = npm_latest.get(pkg)
        if actual is None:            # 没查到这个包 —— 由调用方决定是不是 exit 2
            continue
        if ver != actual:
            out.append(
                f"::error file={rel},line={lineno}::latest 戳说 {pkg}={ver},"
                f"而 npm 上 dist-tags.latest 是 {actual} —— 戳漂了,"
                f"正文里关于 latest 的行为断言很可能也跟着假了"
            )
    return out


# 戳里的 package 字段用的是**裸名**(`agent-network`),而 npm 上是**带 scope 的**
# (`@sleep2agi/agent-network`)—— 裸名在 registry 上 404。
# 这一格是实测撞出来的:第一版直接拿戳里的字符串去 `npm view`,得到
#   npm error 404 Not Found - GET https://registry.npmjs.org/agent-network
# 而门**没有**把它当成"没问题"放过去,是 exit 2 拒绝通过 —— fail-closed 起作用了。
NPM_SCOPE = "@sleep2agi/"


def npm_name(stamp_package: str) -> str:
    """戳里的包名 → registry 上的包名。已经带 scope 的原样返回。"""
    return stamp_package if stamp_package.startswith("@") else NPM_SCOPE + stamp_package


def npm_dist_tag_latest(package: str) -> str | None:
    """查 npm 的 dist-tags.latest;查不到返回 None(调用方按"量不出来"处理)。"""
    try:
        r = subprocess.run(
            ["npm", "view", npm_name(package), "dist-tags", "--json"],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            return None
        import json as _json
        return _json.loads(r.stdout).get("latest")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def parse(text: str) -> list[tuple[int, str, str, str]]:
    out = []
    for lineno, line in enumerate(text.split("\n"), 1):
        for m in STAMP.finditer(line):
            out.append((lineno, m.group(1), m.group(2), m.group(3)))
    return out


def run(repo: Path, package: str | None, version: str | None,
        verify_latest: bool = False) -> int:
    problems = 0
    total_stamps = 0
    npm_latest: dict[str, str] = {}
    if verify_latest:
        # 先把所有 latest 戳提到的包查一遍;查不到就是"量不出来",不是"没问题"
        pkgs = set()
        for rel in DOCS:
            path = repo / rel
            if path.is_file():
                for _ln, pkg, chan, _v in parse(path.read_text(encoding="utf-8")):
                    if chan == "latest":
                        pkgs.add(pkg)
        for pkg in sorted(pkgs):
            got = npm_dist_tag_latest(pkg)
            if got is None:
                print(f"::error::查不到 {npm_name(pkg)} 的 dist-tags.latest(网络/registry?)"
                      f" —— 拒绝通过:说不清楚就不说没问题", file=sys.stderr)
                return 2
            npm_latest[pkg] = got
        print("npm dist-tags.latest: " + ", ".join(f"{k}={v}" for k, v in sorted(npm_latest.items())))
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

        for msg in latest_stamp_problems(stamps, npm_latest, rel):
            print(msg)
            problems += 1

        for lineno, pkg, chan, ver in stamps:
            if channel_shape_note(chan, ver, npm_latest.get(pkg)):
                print(f"  note {rel}:{lineno}: channel={chan} 而 version={ver} 形状像 "
                      f"{channel_of(ver)} —— 无 npm 真值时不判红(latest 确实可能指着预发布版)。"
                      f"要判请加 --verify-latest-from-npm")
            if channel_shape_conflict(chan, ver, npm_latest.get(pkg)):
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

    # ---- latest 戳 vs npm dist-tags.latest(纯函数,无网络)----
    S = [(9, "agent-network", "latest", "2.2.21"),
         (10, "agent-network", "preview", "2.3.0-preview.65")]

    drift = latest_stamp_problems(S, {"agent-network": "2.3.0-preview.47"}, "f.md")
    check("latest 戳漂了 → 报一条", len(drift) == 1, f"got {len(drift)}")
    check("报的是那条 latest 戳(不是 preview 戳)",
          bool(drift) and "line=9" in drift[0] and "2.2.21" in drift[0] and "2.3.0-preview.47" in drift[0],
          drift[0][:90] if drift else "")

    same = latest_stamp_problems(S, {"agent-network": "2.2.21"}, "f.md")
    check("latest 戳对上 → 零报", same == [], f"got {same}")

    # 🔴 正控放在反侧:preview 戳漂了也不该由这条判据管(它归发版模式)
    only_preview = latest_stamp_problems(
        [(10, "agent-network", "preview", "2.3.0-preview.65")],
        {"agent-network": "2.3.0-preview.47"}, "f.md")
    check("preview 戳不被这条判据碰", only_preview == [], f"got {only_preview}")

    # 查不到的包不在这里静默判红 —— 由调用方 exit 2("量不出来"≠"没问题")
    unknown = latest_stamp_problems(S, {}, "f.md")
    check("查不到的包这里不报(交给调用方 exit 2)", unknown == [], f"got {unknown}")

    # 形状启发式 vs npm 真值
    check("形状对上 → 不算矛盾", channel_shape_conflict("preview", "1.0.0-preview.1", None) is False)
    check("形状对不上但无真值 → **不**判红(分不开就不判)",
          channel_shape_conflict("latest", "1.0.0-preview.1", None) is False)
    check("形状对不上且无真值 → 出提示",
          channel_shape_note("latest", "1.0.0-preview.1", None) is True)
    check("形状对上 → 无提示", channel_shape_note("preview", "1.0.0-preview.1", None) is False)
    check("npm 真值确认它就是 latest → 不判矛盾(启发式让位)",
          channel_shape_conflict("latest", "1.0.0-preview.1", "1.0.0-preview.1") is False)
    check("npm 真值是别的版本 → 仍判矛盾",
          channel_shape_conflict("latest", "1.0.0-preview.1", "2.0.0") is True)

    check("裸名补上 scope", npm_name("agent-network") == "@sleep2agi/agent-network",
          npm_name("agent-network"))
    check("已带 scope 的不重复加", npm_name("@sleep2agi/agent-node") == "@sleep2agi/agent-node")

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
    ap.add_argument("--verify-latest-from-npm", action="store_true",
                    help="把 channel=latest 的戳对 npm dist-tags.latest 比;需要网络")
    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if bool(args.package) != bool(args.version):
        print("::error::--package 和 --version 必须一起给", file=sys.stderr)
        return 2
    repo = Path(subprocess.run(["git", "rev-parse", "--show-toplevel"],
                               capture_output=True, text=True, check=True).stdout.strip())
    return run(repo, args.package, args.version, args.verify_latest_from_npm)


if __name__ == "__main__":
    sys.exit(main())
