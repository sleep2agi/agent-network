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

Deliberately NOT extended to the rest of docs/: `docs-site/docs/api/mcp-tools.md`
carries 44 of these and all 44 are still in range with plausible content, i.e.
they are maintained. Reddening on ~100 maintained links would make this a
backlog canary that dies the day the backlog clears.

Scope is deliberately narrow and stated: UTF-8 validity across every tracked
.md, link resolution for docs/qa/** only (where the defect was found), and the
changelog anchor rule. Widening the link check to all docs is a separate
decision — some files link to generated or gitignored paths, and a guard that
cries wolf gets disabled.

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


def is_repo_relative(target: str) -> bool:
    """True for link targets that must resolve to a file in this repo.

    Excluded: absolute URLs, in-page anchors, mail links, and site-absolute
    routes (`/guide/feishu`) — the last are resolved by the docs site's router,
    not the filesystem, so checking them here would report noise as rot.
    """
    if not target or target.startswith(("http://", "https://", "#", "mailto:", "/")):
        return False
    return True
LINK_SCOPE = "docs/qa"
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
        for target in MD_LINK.findall(body):
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
