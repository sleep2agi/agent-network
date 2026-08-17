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

RELATIVE_LINK = re.compile(r"\]\((\.{1,2}/[^)\s]*)")
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
        for target in RELATIVE_LINK.findall(body):
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


if __name__ == "__main__":
    sys.exit(main())
