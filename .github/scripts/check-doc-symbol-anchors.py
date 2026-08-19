#!/usr/bin/env python3
"""docs 里的「符号锚点」必须在它自己点名的那个文件里真实存在。

背景 —— 为什么需要这道门
========================

#857 把 docs 里 13 条 `cli.ts:228 loadProfile` 这样的**行号 pin** 换成了
**符号锚点**:

    [`cli.ts`](…/agent-network/bin/cli.ts) —— 搜 `function loadProfile(`

换的理由是行号会漂:那 13 条抽查下来 **13 条全错**,`loadProfile` 实际在 1274 行,
doc 写 228;`runCommand` 在 5812,doc 写 2044。而它们全都**长得像有效引用** ——
格式对、行号在文件范围内、点开能打开 —— 所以读的人不会怀疑。

符号锚点确实不会因为「上面插了几行」而失效。**但它会因为改名而失效,而失效之后
同样没有任何东西会喊。** #843 那道门在数行号 pin(守住不再变多),而符号锚点
在变多,却没有任何门在看。

这道门补的就是这一格:**每一条 `搜 `X`` 里的 X,必须在它前面那个链接指向的文件里
真实存在。**

判据
====

对每一条 `搜 `<anchor>``:
  1. 往左找**最近的**一个指向本仓源码的 markdown 链接,取出仓库相对路径;
  2. 断言 `<anchor>` 是那个文件内容的子串(逐字,不做正则,不忽略空白)。

两类失败都报:
  - anchor 在文件里找不到  → 锚点失效(改名/删除/写错)
  - anchor 前面没有链接    → 无法判定它指哪个文件,这本身就是缺陷

分母承重
========

🔴 这道门最可能的坏法不是「判据写错」,是**「一条都没扫到」然后打印一片绿**。
所以:扫到 0 个 md 文件、或 0 条锚点,一律 exit 2(而不是 exit 0)。
「没有问题」和「没有看」在输出上必须长得不一样。

用法
====

    python3 .github/scripts/check-doc-symbol-anchors.py
    python3 .github/scripts/check-doc-symbol-anchors.py --selftest
"""

from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

# 🔴 为什么标记词只有 `搜`,没有 `grep`(2026-08-18 实测,不要"顺手"加)
#
# 英文页要写锚点就得塞一个中文的 `搜`,读起来别扭 —— 所以「把它扩成 (?:搜|grep)」
# 是个非常自然的念头。我试了。结果不是"有存量要清",是**这个标记词本身不成立**:
#
#     只认 `搜`            77 条锚点,77 条全部命中
#     加上 `grep`         145 条锚点,**32 条不过**（全部是 "no source link precedes"）
#
# 把那 32 条逐条看完,**没有一条是坏掉的锚点**。它们分两类:
#
#   ① `grep` 在这个仓里也是**普通动词**。文档里大量句子在讲「我去 grep 了什么」:
#        docs/pre-pr-selfcheck.md:229   我在 hub 日志里 grep `delivered-stale`,数出 1018 条
#        docs/stale-issue-review.md:189 `agent-node` 全域 grep `Retry-After` 命中 0
#        docs/stale-issue-review.md:65  `db.ts` 里 grep `cost` 有 6 处命中,全是 scrypt 的 cost 参数
#      这些**本来就不该**有前置源码链接 —— 它们不是「去这个文件里找这个符号」,
#      是「我跑过这条命令,结果是这样」。要求它们配链接是**误报**。
#
#   ② 更硬的一条:`grep` 会**在斜杠/逗号列表里被当成标记词**,于是捕获到标点。
#      这四条的锚串逐字是:
#        docs-site/docs/guide/runtimes.md:32           « / »
#        docs-site/docs/en/guide/runtimes.md:32        « / »
#        docs/tests/release-gate-playbook.md:293       « because »
#        docs/tests/release-gate-playbook.md:459       «, use »
#      前两条来自一句列举被禁工具的话:`bash` / `read` / `glob` / `grep` / `edit` / …
#      —— **`grep` 是那个列表的成员**,它后面那个反引号属于下一项。
#
# ⇒ `搜` 能用,恰恰因为它在这个仓里**只**当标记词用;`grep` 不能,因为它同时是
#   一个会出现在正文和列表里的普通词。**这不是"清完存量就能扩"的那一类** ——
#   清完也会随着新文档不断长回来。
#
# (同族但判据不同的另一道门 scripts/check-mcp-tool-anchor-sections.py 收 `搜|grep`,
#  那里成立是因为它的范围只有 mcp-tools.md 一个文件,而那份文档里 `grep` 全是锚点。
#  **同一个词在不同范围里是不是可靠标记,要分别看。**)
#
# 锚点本体:`搜 ` 之后的第一个反引号串。
# 🔴 只取第一个 —— docs/architecture.md:450 那种一行里 `搜 X` 后面还跟着两个
# 描述性代码串(`writeFileSync(..., {mode: 0o600})` 之类),它们不是锚点。
ANCHOR = re.compile(r"搜\s*`([^`]+)`")

# 指向本仓源码的链接。两种写法都收:
#   [`cli.ts`](https://github.com/<owner>/<repo>/blob/<ref>/agent-network/bin/cli.ts)
#   [`cli.ts`](../../agent-network/bin/cli.ts)
BLOB_LINK = re.compile(
    r"\]\(\s*(?:https?://github\.com/[^/\s]+/[^/\s]+/blob/[^/\s]+/)?([^)\s#]+?)\s*(?:#[^)\s]*)?\)"
)

# 只有这些后缀算「源码文件」——链接到别的 .md 不构成锚点目标。
SOURCE_SUFFIXES = {".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".sh", ".yml", ".yaml", ".json"}

DOC_ROOTS = ("docs/", "docs-site/")


def tracked_markdown(repo: Path) -> list[str]:
    """全仓被跟踪的 .md。

    🔴 2026-08-19：这里原本限定 `-- docs docs-site`，于是 **103 个 .md 从来没被扫过**
    （`README.md` / `CLAUDE.md` / `AGENTS.md` / `SECURITY.md` / `.github/**` …）。
    当时门外一个「搜 + 反引号符号」锚点都没有，所以没漏掉真问题 —— 但约定一旦被用到
    这些文件里，这道门看不见。**盲区在取集，不在判据。**

    隔壁 `check-docs-integrity.py:107` 就是现成写法：全仓 `git ls-files "*.md"`
    加一条「取集为空就拒绝通过」。这里照抄。
    """
    out = subprocess.run(
        ["git", "ls-files", "-z", "--", "*.md"],
        cwd=repo, capture_output=True, text=True, check=True,
    ).stdout
    return sorted(p for p in out.split("\0") if p.endswith(".md"))


def nearest_source_link(line: str, before: int) -> str | None:
    """往左找最近的、指向源码文件的链接目标。"""
    best = None
    for m in BLOB_LINK.finditer(line):
        if m.end() > before:
            break
        target = m.group(1)
        if Path(target).suffix in SOURCE_SUFFIXES:
            best = target
    return best


def scan_text(rel: str, text: str) -> tuple[list[tuple], int]:
    """返回 (问题列表, 本文件里的锚点数)。"""
    problems: list[tuple] = []
    count = 0
    for lineno, line in enumerate(text.split("\n"), start=1):
        for m in ANCHOR.finditer(line):
            count += 1
            anchor = m.group(1)
            target = nearest_source_link(line, m.start())
            if target is None:
                problems.append((rel, lineno, anchor, None, "no source link precedes this anchor"))
                continue
            problems.append((rel, lineno, anchor, target, None))
    return problems, count


def resolve(repo: Path, doc_rel: str, target: str) -> Path:
    """相对链接按 doc 所在目录解析;仓库绝对路径(如 agent-network/bin/cli.ts)按仓根解析。"""
    if target.startswith("./") or target.startswith("../"):
        return (repo / doc_rel).parent.joinpath(target).resolve()
    return (repo / target).resolve()


def run(repo: Path) -> int:
    docs = tracked_markdown(repo)
    if not docs:
        print("FAIL: 0 tracked .md under docs/ or docs-site/ — 扫描范围塌了", file=sys.stderr)
        return 2

    pending: list[tuple] = []
    total_anchors = 0
    for rel in docs:
        try:
            text = (repo / rel).read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError) as exc:
            print(f"::error file={rel}::cannot read: {exc}")
            pending.append((rel, 0, "", None, f"unreadable: {exc}"))
            continue
        found, n = scan_text(rel, text)
        pending.extend(found)
        total_anchors += n

    if total_anchors == 0:
        print("FAIL: 0 symbol anchors found across "
              f"{len(docs)} doc(s) — 判据没变,是取集塌了", file=sys.stderr)
        return 2

    problems = 0
    checked = 0
    for rel, lineno, anchor, target, note in pending:
        if note:
            print(f"::error file={rel},line={lineno}::symbol anchor `{anchor}` — {note}")
            problems += 1
            continue
        path = resolve(repo, rel, target)
        try:
            body = path.read_text(encoding="utf-8")
        except OSError:
            print(f"::error file={rel},line={lineno}::symbol anchor `{anchor}` "
                  f"names '{target}', which does not exist")
            problems += 1
            continue
        checked += 1
        if anchor not in body:
            print(f"::error file={rel},line={lineno}::symbol anchor `{anchor}` "
                  f"not found in '{target}' — 被改名/删掉了,或者一开始就写错了")
            problems += 1

    print(f"checked {total_anchors} symbol anchor(s) across {len(docs)} tracked doc(s); "
          f"{checked} resolved to a readable source file")
    if problems:
        print(f"\n{problems} problem(s).")
        return 1
    print("every symbol anchor exists in the file it names.")
    return 0


# ---------------------------------------------------------------------------
# selftest
#
# 🔴 夹具里的锚点用字符串拼接造,不写成字面量 —— 否则这个文件自己会被
#    真实扫描命中。
# ⚠️ 2026-08-19 更正:原注释说「它不在 docs/ 下」,那个理由**在取集放宽到全仓之后不再成立**。
#    现在真正的理由是:tracked_markdown() 只收 `.md`,而本文件是 `.py`。
#    字符串拼接仍然该留 —— 但别再靠「不在 docs/ 下」这个已经过期的前提。
# ---------------------------------------------------------------------------
def selftest() -> int:
    SEARCH = "搜"
    BT = "`"

    def anchor(text: str) -> str:
        return SEARCH + " " + BT + text + BT

    def link(target: str) -> str:
        return "[`x`](https://github.com/o/r/blob/main/" + target + ")"

    cases: list[tuple[str, bool, str]] = []

    # ── 取集自检:这道门的坏法是「圈错扫哪些文件」,判据再准也救不回来。 ──
    # 2026-08-19 之前它只扫 `-- docs docs-site`,103 个 .md(README/CLAUDE/AGENTS/
    # SECURITY/.github/**)从来没被扫过。夹具建一个真 git 仓,走 tracked_markdown()。
    import tempfile as _tf
    with _tf.TemporaryDirectory() as _td:
        _root = Path(_td)
        for rel in ("README.md", "docs/a.md", "docs-site/b.md",
                    "agent-node/notes.md", ".github/PULL_REQUEST_TEMPLATE.md",
                    "docs/not-markdown.txt"):
            f = _root / rel
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("x\n", encoding="utf-8")
        for cmd in (["git", "init", "-q"], ["git", "add", "-A"]):
            subprocess.run(cmd, cwd=_root, check=True, capture_output=True, text=True)
        got = set(tracked_markdown(_root))
        want = {"README.md", "docs/a.md", "docs-site/b.md",
                "agent-node/notes.md", ".github/PULL_REQUEST_TEMPLATE.md"}
        cases.append(("取集:全仓 .md 都收(含 docs/ 之外)", got == want, f"got={sorted(got)}"))
        cases.append(("取集:非 .md 不收", "docs/not-markdown.txt" not in got, ""))

    def check(name: str, line: str, src_map: dict[str, str], want_problem: bool) -> None:
        probs, n = scan_text("docs/f.md", line)
        got_problem = False
        for _rel, _ln, a, target, note in probs:
            if note:
                got_problem = True
            elif a not in src_map.get(target or "", ""):
                got_problem = True
        ok = (got_problem == want_problem) and n >= 1
        cases.append((name, ok, f"anchors={n} problem={got_problem} want={want_problem}"))

    src = {"a/b.ts": "function loadProfile() {}\nconst x = 1;\n"}

    check("锚点存在 → 过", link("a/b.ts") + " —— " + anchor("function loadProfile("), src, False)
    check("锚点不存在 → 红", link("a/b.ts") + " —— " + anchor("function gone("), src, True)
    check("锚点前没有链接 → 红", "见 " + anchor("function loadProfile("), src, True)
    check("链接是 .md 不算源码 → 红",
          "[`d`](https://github.com/o/r/blob/main/docs/x.md) " + anchor("function loadProfile("),
          src, True)
    check("一行两个链接,取最近的那个",
          link("a/other.ts") + " 前文 " + link("a/b.ts") + " —— " + anchor("function loadProfile("),
          src, False)
    check("搜后面跟多个代码串,只有第一个是锚点",
          link("a/b.ts") + " —— " + anchor("function loadProfile(") + " " + BT + "无关描述" + BT,
          src, False)
    check("逗号连接(不是破折号)也算",
          link("a/b.ts") + "," + anchor("function loadProfile("), src, False)

    # 分母:一条锚点都没有的文本,scan 必须返回 0(上游据此 exit 2)
    _p, n0 = scan_text("docs/f.md", "一段没有任何锚点的正文")
    cases.append(("无锚点文本 → count=0(上游 exit 2)", n0 == 0, f"count={n0}"))

    for name, ok, detail in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}   [{detail}]")
    bad = sum(1 for _n, ok, _d in cases if not ok)
    print(f"selftest: {len(cases) - bad}/{len(cases)} ok")
    return 1 if bad else 0


def main() -> int:
    if "--selftest" in sys.argv:
        return selftest()
    repo = Path(subprocess.run(
        ["git", "rev-parse", "--show-toplevel"],
        capture_output=True, text=True, check=True,
    ).stdout.strip())
    return run(repo)


if __name__ == "__main__":
    sys.exit(main())
