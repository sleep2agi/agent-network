#!/usr/bin/env python3
"""Two kinds of silent rot in tracked Markdown: unreadable bytes and dead links.

Both were live in docs/qa/weekly/2026-W19.md on 2026-08-17:

  * three multi-byte characters truncated mid-sequence, so the file could not be
    decoded as UTF-8 at all. Every reader's tool renders that as a replacement
    glyph or an error, and the three damaged sentences each lost their last
    character. The damage pattern (`_italic text_` with the character before the
    closing `_` eaten) suggests a truncating edit, not a bad encoding.
  * all 24 relative links resolved to paths that do not exist — the file sits
    three levels deep and the links were written for two, so every one of them
    pointed inside docs/ instead of at the repo root.

Neither shows up in a build: Markdown has no compiler, so a dead link and a live
one look the same until a reader clicks. Both are cheap to check mechanically.

A third, narrower rule: no line-anchored `blob/main/...#L<n>` links inside the
changelogs. A changelog entry describes a state that was true at some past
release; a `#L` anchor into `main` resolves against today's code. Those two
facts are incompatible by construction — the link is wrong after the next commit
that touches the file, and nothing tells anyone. Measured 2026-08-17: of six such
links, `cli.ts#L61` (documented as `PINNED_SERVER_VERSION`) now lands on
`} from "../src/opencode-preset";` and `cli.ts#L2589` on a line of help text.

Deliberately NOT extended to `docs-site/`: `docs-site/docs/api/mcp-tools.md`
carries 44 of these and all 44 are still in range with plausible content, i.e.
they are maintained. Reddening on ~100 maintained links would make this a
backlog canary that dies the day the backlog clears.

🔴 2026-08-18 — the link scope WAS widened, from `docs/qa/` to all of `docs/`.
The original objection ("widening this would cry wolf") was about a backlog that
no longer exists: #976 cleared the last 8 broken relative links under `docs/`,
so the widened scope starts at **0 findings**. That is the whole condition —
a gate that goes green on day one reddens only when something is newly broken,
which is the opposite of a backlog canary.

`docs-site/` stays out on purpose, and not for backlog reasons: it is a VitePress
site, so `/guide/feishu` there is a router route, not a path. Its dead links are
checked by `vitepress build` itself (fatal by default; wired into CI in #966).
🔴 Confusing those two cost me a measurement earlier the same day: a hand-written
scanner that resolved site-absolute routes against the filesystem reported **671**
broken links where the real build reports **0**. Hence the split — filesystem
rules for `docs/`, the product's own build for `docs-site/`.

Fail-closed: an empty file list exits 2 rather than reporting a clean run.
"""
import os
import re
import subprocess
import sys

# Every markdown link target, then filter. The earlier version matched only
# targets that begin `./` or `../`, which is not "a relative link" — it is one
# way of spelling one. A bare `](v0-summary.md)` is equally relative and was
# invisible to this gate.
#
# 🔴 That blind spot lived in how the gate COLLECTED, not in what it judged, so
# nothing about the output looked wrong: the run printed a link count, said "no
# problems", and exited 0 — byte-identical to a genuinely clean run. Measured on
# 2026-08-18: 16 of the 96 in-scope relative links were bare filenames, and both
# of the broken links in docs/qa/ were among the 16. The gate had been reporting
# "80 relative link(s)" as if that were the denominator.
#
# It stayed invisible because the file this gate was written from (W19, 2026-08-17)
# happened to spell all 24 of its links with `../`. A fixture that exercises one
# spelling cannot reveal that the other spelling is unhandled.
MD_LINK = re.compile(r"\]\(([^)\s]+)\)")


FENCE = re.compile(r"^[ \t]*(?:```|~~~).*?$.*?^[ \t]*(?:```|~~~)[ \t]*$",
                   re.MULTILINE | re.DOTALL)
CODE_SPAN = re.compile(r"`[^`\n]*`")


def strip_code(body: str) -> str:
    """把围栏代码块和行内代码替换成等长空白。

    🔴 markdown 里 `` `](x)` `` 不是链接,是**代码**。扩大扫描范围之后立刻撞上一例:
    docs/sop/methodology.md 里有一行模板 `` `[→ #<issue> 评论](<url>)` ``,
    整段在反引号里 —— 它不该被当成断链,但正则看不出反引号。

    替换成**等长空白**而不是删掉,是为了让报错里的位置信息不漂。
    """
    def blank(m: "re.Match[str]") -> str:
        return re.sub(r"[^\n]", " ", m.group(0))
    return CODE_SPAN.sub(blank, FENCE.sub(blank, body))


def is_repo_relative(target: str) -> bool:
    """True for link targets that must resolve to a file in this repo.

    Excluded: absolute URLs, in-page anchors, mail links, and site-absolute
    routes (`/guide/feishu`) — the last are resolved by the docs site's router,
    not the filesystem, so checking them here would report noise as rot.
    """
    if not target or target.startswith(("http://", "https://", "#", "mailto:", "/")):
        return False
    return True
# 🔴 从 `docs/qa` 扩到 `docs` —— 见文件头。扩之前 #976 先把 docs/ 下最后 8 条断链清掉,
#    所以扩完的起点是 0 findings,不是一堆存量。
LINK_SCOPE = "docs"
CHANGELOG_GLOB = "changelog.md"
MAIN_LINE_ANCHOR = re.compile(r"blob/main/[\w./-]+#L\d+")


def tracked(pathspec: str) -> list[str]:
    out = subprocess.run(["git", "ls-files", pathspec], capture_output=True, text=True)
    return [f for f in out.stdout.split("\n") if f.endswith(".md")]


def main() -> int:
    md = tracked("*.md")
    if not md:
        print("::error::git ls-files '*.md' returned nothing — scope regression, refusing to pass")
        return 2

    problems = 0

    # 1. Every tracked .md must decode as UTF-8.
    for f in md:
        try:
            open(f, "rb").read().decode("utf-8")
        except UnicodeDecodeError as e:
            problems += 1
            print(f"::error file={f}::not valid UTF-8 at byte {e.start} ({e.reason}). "
                  f"A truncated multi-byte character renders as a replacement glyph for "
                  f"every reader and silently drops text.")
        except OSError as e:
            problems += 1
            print(f"::error file={f}::cannot read: {e}")

    # 2. Relative links inside the scoped subtree must resolve.
    scoped = [f for f in md if f.startswith(LINK_SCOPE + "/")]
    if not scoped:
        print(f"::error::no tracked .md under {LINK_SCOPE}/ — scope regression, refusing to pass")
        return 2

    links = 0
    for f in scoped:
        body = open(f, encoding="utf-8", errors="replace").read()
        base = os.path.dirname(f)
        for target in MD_LINK.findall(strip_code(body)):
            if not is_repo_relative(target):
                continue
            links += 1
            resolved = os.path.normpath(os.path.join(base, target.split("#")[0]))
            if not os.path.exists(resolved):
                problems += 1
                print(f"::error file={f}::relative link '{target}' resolves to "
                      f"'{resolved}', which does not exist")

    # 3. Changelogs must not line-anchor into main.
    changelogs = [f for f in md if f.endswith("/" + CHANGELOG_GLOB) or f == CHANGELOG_GLOB]
    if not changelogs:
        print(f"::error::no tracked {CHANGELOG_GLOB} found — scope regression, refusing to pass")
        return 2
    anchors = 0
    for f in changelogs:
        for m in MAIN_LINE_ANCHOR.finditer(open(f, encoding="utf-8", errors="replace").read()):
            problems += 1
            anchors += 1
            print(f"::error file={f}::`{m.group(0)}` line-anchors into main from a changelog. "
                  f"The entry describes a past release; the anchor resolves against today's "
                  f"code, so it is wrong after the next commit that touches that file and "
                  f"nothing reports it. Link the file without `#L`, and name the symbol.")

    print(f"checked {len(md)} tracked .md for UTF-8 validity; "
          f"{links} relative link(s) across {len(scoped)} file(s) under {LINK_SCOPE}/; "
          f"{len(changelogs)} changelog(s) for main line-anchors ({anchors} found)")

    if problems:
        print(f"\n{problems} problem(s).")
        return 1
    print("no problems.")
    return 0


def selftest() -> int:
    """Pin the collector, because that is where this gate was blind.

    Not the judge — `os.path.exists` was never the problem. What failed was the
    step before it: deciding which strings on the page are links this gate owns.
    A guard whose collector silently drops a whole spelling reports a smaller
    denominator and a clean run, and both look exactly like success.
    """
    page = (
        "see [a](v0-summary.md) and [b](../qa/x.md) and [c](./y.md)\n"
        "[d](https://example.com/z.md) [e](#anchor) [f](/guide/feishu)\n"
        "[g](v0-summary.md#some-anchor)\n"
    )
    found = [t for t in MD_LINK.findall(page) if is_repo_relative(t)]
    cases = [
        ("bare filename is collected", "v0-summary.md" in found),
        ("bare filename with anchor is collected", "v0-summary.md#some-anchor" in found),
        ("../ form still collected", "../qa/x.md" in found),
        ("./ form still collected", "./y.md" in found),
        ("absolute URL excluded", "https://example.com/z.md" not in found),
        ("in-page anchor excluded", "#anchor" not in found),
        ("site-absolute route excluded", "/guide/feishu" not in found),
        ("exactly the four repo-relative targets", len(found) == 4),
    ]

    # 🔴 剥代码这一层也要钉。扩大范围当天就撞上一例:模板里整段写在反引号里的
    #    `[→ #<issue> 评论](<url>)` 被当成断链。剥掉代码之后 288 → 287,
    #    **只少了这一条** —— 分母几乎没动,说明这层没有顺手放过别的东西。
    BT = chr(96)
    coded = (
        "inline " + BT + "[t](<url>)" + BT + " must not count\n"
        "real [r](v0-summary.md) must still count\n"
        + BT*3 + "\n[f](fenced.md)\n" + BT*3 + "\n"
    )
    stripped = strip_code(coded)
    after = [t for t in MD_LINK.findall(stripped) if is_repo_relative(t)]
    cases += [
        ("行内代码里的链接不算", "<url>" not in after),
        ("围栏代码块里的链接不算", "fenced.md" not in after),
        ("🔴 代码之外的真链接仍然算（不是把整页跳过了）", "v0-summary.md" in after),
        ("剥代码只剥代码：行数不变", stripped.count("\n") == coded.count("\n")),
    ]
    bad = [name for name, ok in cases if not ok]
    for name, ok in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {name}")
    if bad:
        print(f"::error::collector selftest failed: {len(bad)} case(s)")
        return 1
    print(f"collector selftest: {len(cases)}/{len(cases)} ok")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    sys.exit(main())
