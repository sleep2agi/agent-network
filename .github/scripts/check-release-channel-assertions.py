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

## 🔴 判「已登记」用**结构化行**判,不用**全文子串**判(#1466)

判据(判什么)是对的,取集(怎么算「已登记」)从头就写歪了 —— 早期用
`f in sop`(整份文件 substring),于是**任何在 SOP 别处顺带提到那个路径的位置**
(正文的例子、别的段落的引用、甚至同一个路径出现在 `### B. Frozen snapshots`
下的「未 register」列表里)全都会让它算成已登记。

这是 CLAUDE.md ⑤「判据 vs 取集」同族的洞。真实案例:2026-08-29 修 #1462
之后仍有 `docs-site/docs/changelog.md` + `en/changelog.md` 两份被算成已登记 ——
它们**不在**逐次发版重核表里,只是在 SOP 别处被提到。差额从「4」降到「2」
只是巧合,不是取集变严了。

现在改成:扫 SOP 里的 markdown 表格行,拿**第一格 backtick 里的路径**当已登记。
一条路径被算「已登记」的前提是**它作为表格首格出现**,不再是「文本里出现过」。

## 显式豁免(有意不追踪,不是漏了)

`docs-site/docs/changelog.md` + 英文对应版是**版本钉死的历史记录** —— 那些「latest
2.2.21 上……」的句子说的是当时发版那一刻的事,发新版**不会**让它们变假,反而登记进
逐次发版重核表会让每次发版都要重核一堆早已冻结的历史记录 —— 变弱的清单下次就没
人逐条核了。跟 docstring 里「不扫只出现版本号的行」同样的推理:**有意不追踪就显式
写出来,别指望「因为漏配所以放行」这种巧合。**

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

# #1466 — a table row's first cell is `| \`<path>\` |`. We accept an
# optional leading `>` because RELEASE-SOP.md's registration table lives
# inside a `>` blockquote (rendering choice, not semantics). The path
# must match the docs-site tree exactly — no globs, no partial paths.
#
# 🔴 We require the ENTIRE first cell to be just a backtick-wrapped path.
# A row like `| \`docs-site/docs/x.md\` （英文对应）| … | … |` would still
# match, but a prose line that HAPPENS to start with `| \`…\`` (e.g. a code
# example inside a paragraph) still gets picked up — that's very rare in
# practice, and requiring the exact three-cell markdown table shape is
# what turns this from "structural" into "brittle-to-prose-formatting".
# The `.split("|")` shape check below asserts the row has at least the
# three cells the table is documented to have — that's tight enough.
REG_ROW = re.compile(r"^\s*>?\s*\|\s*`(docs-site/docs/[^`]+)`\s*\|")

# #1466 — deliberately-untracked (see docstring "显式豁免" section).
# Adding a path here is a decision, not a workaround: prove it's
# frozen/historical and the sentence won't go false on release.
EXEMPT: frozenset[str] = frozenset({
    "docs-site/docs/changelog.md",
    "docs-site/docs/en/changelog.md",
})


def parse_registered_paths(sop_text: str) -> set[str]:
    """Return the set of docs-site paths that appear as the FIRST cell of a
    markdown table row in `sop_text`. Structural match — a prose mention
    of the path anywhere else in the SOP does NOT qualify."""
    out: set[str] = set()
    for line in sop_text.splitlines():
        # Cheap shape filter first: a real table row has at least three
        # cells (`|` shows up ≥ 3 times per row: opening + between cells +
        # closing). Prose lines with a single backtick-wrapped path don't.
        if line.count("|") < 3:
            continue
        m = REG_ROW.match(line)
        if m:
            out.add(m.group(1))
    return out


def assertion_files() -> dict[str, list[int]]:
    found: dict[str, list[int]] = {}
    for p in sorted(DOCS.rglob("*.md")):
        rel = p.as_posix()
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1):
            if VERSION.search(line) and CHANNEL.search(line):
                found.setdefault(rel, []).append(i)
    return found


def selftest() -> int:
    """Prove the parser + exemption logic works before the real scan runs.
    Any change to `parse_registered_paths` or EXEMPT that breaks a real
    case must trip a selftest first — otherwise the real scan below will
    just print a number and exit 0 (a green byte-identical to a real one).
    """
    fixture = (
        "# some SOP\n"
        "\n"
        "prose paragraph that mentions `docs-site/docs/prose-only.md`\n"
        "in the flow of a sentence — this line has only 0 pipes\n"
        "\n"
        "> | 文件 | 行 | 断言 |\n"
        "> |---|---|---|\n"
        "> | `docs-site/docs/table-listed.md` | 42 | latest x.y.z 断言 |\n"
        "> | `docs-site/docs/en/table-listed.md` | 42 | 同上(英文) |\n"
        "\n"
        "### B. Frozen snapshots\n"
        "\n"
        "- `docs-site/docs/frozen-listed.md` (bullet mention, NOT a table row)\n"
        "- `docs-site/docs/changelog.md` / `docs-site/docs/en/changelog.md`\n"
    )
    reg = parse_registered_paths(fixture)
    failures: list[str] = []
    # Positive: table rows are counted.
    for p in ("docs-site/docs/table-listed.md", "docs-site/docs/en/table-listed.md"):
        if p not in reg:
            failures.append(f"selftest: {p} should be counted (real table row) — parser missed it")
    # Negative: prose / bullet mentions must NOT be counted (this is
    # the exact class of false-positive #1466 reports).
    for p in ("docs-site/docs/prose-only.md",
              "docs-site/docs/frozen-listed.md",
              "docs-site/docs/changelog.md",
              "docs-site/docs/en/changelog.md"):
        if p in reg:
            failures.append(f"selftest: {p} should NOT be counted (prose mention) — parser false-positived")
    # Exemption: changelog paths must be in EXEMPT even though prose
    # mentions them (belt-and-braces: parser drops them via structural
    # match, EXEMPT is the second line of defense in case someone later
    # ALSO adds a changelog row to the SOP table by mistake).
    for p in ("docs-site/docs/changelog.md", "docs-site/docs/en/changelog.md"):
        if p not in EXEMPT:
            failures.append(f"selftest: {p} should be in EXEMPT")
    if failures:
        for f in failures:
            print(f"::error::{f}", file=sys.stderr)
        return 1
    print(f"selftest ok: parsed {len(reg)} row(s), {len(EXEMPT)} exempted")
    return 0


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1] == "--selftest":
        return selftest()

    if not DOCS.is_dir() or not SOP.is_file():
        print("::error::取集塌了:找不到 docs-site/docs 或 RELEASE-SOP.md —— 拒绝通过", file=sys.stderr)
        return 2                                  # 说不清楚就不说「没问题」
    sop = SOP.read_text(encoding="utf-8")
    registered = parse_registered_paths(sop)
    if not registered:
        print("::error::SOP 里一条表格行都没解析出来 —— 更可能是表格 shape 改了、判据没跟上", file=sys.stderr)
        return 2
    found = assertion_files()
    if not found:
        print("::error::零命中。信道断言不可能一条都没有 —— 更可能是扫描范围错了", file=sys.stderr)
        return 2
    missing = [f for f in found if f not in registered and f not in EXEMPT]
    exempted_hits = [f for f in found if f in EXEMPT]
    print(
        f"扫到带信道断言的文件 {len(found)} 个;"
        f"表格行登记 {len(found) - len(missing) - len(exempted_hits)} 个;"
        f"显式豁免 {len(exempted_hits)} 个;"
        f"未登记 {len(missing)} 个"
    )
    for f in sorted(found):
        if f in missing:
            mark = "MISS"
        elif f in EXEMPT:
            mark = "SKIP"
        else:
            mark = "ok  "
        print(f"  {mark} {f}  行 {found[f][:6]}")
    if missing:
        print(f"\n::error::{len(missing)} 个文件带信道断言但没登记进 docs/RELEASE-SOP.md。", file=sys.stderr)
        print("发版当刻它们会静默变假,而没有任何清单会提醒任何人。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
