#!/usr/bin/env python3
"""test-margin-report.py — TEST-MARGIN v1, report-only (#1627).

Why this exists
---------------
#1627: on a slow runner a test whose *absolute* timeout sits close to its real
duration turns red first, and the failure names the suite, not the timeout — so
it reads like a real defect. #1320 already settled that the job layer must not
fight this by squeezing `timeout-minutes`, and the L1 job now prints
`L1-TIMING v1 …` so a human can compare a run against history.

What is still missing is the *other* half: a per-declaration view of the
absolute timeouts in the tree, and whether each one carries the evidence that it
is not "贴脸" (sitting right at the observed duration).

This script is deliberately **report-only and static** — no Docker, no test run:

- it enumerates every declared absolute timeout (bun `--timeout <ms>` in an L1
  `run.sh`, the JUnit-style `timeout: <ms>` option, and the numeric third
  argument of `test(...)` / `it(...)`);
- it counts how many of them sit next to a *margin annotation* (`margin:` or
  `p99` in a comment on the same or the two preceding lines);
- it prints one fixed-format line:

      TEST-MARGIN v1 declared=<n> annotated=<m> unannotated=<k> implicit_default=<j>

It never exits non-zero. Promotion to a gate (ratchet) is a separate, later
decision — this script only makes the inventory visible, and its own
`--selftest` witnesses that a missing annotation is actually flagged.

Run:
  python3 scripts/test-margin-report.py            # inventory the current tree
  python3 scripts/test-margin-report.py --list     # list every declaration
  python3 scripts/test-margin-report.py --selftest # witness flag/not-flag both ways
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
from dataclasses import dataclass

#: bun's default per-test timeout. Declarations are compared against this only
#: to classify "implicit default" vs "explicit", never to compute a ratio: a
#: static script cannot know a test's observed duration.
BUN_DEFAULT_TIMEOUT_MS = 20_000

#: An annotation within N lines above the declaration counts. Two lines covers
#: both `// margin: …` on its own line above and a trailing same-line comment.
ANNOTATION_WINDOW = 2
ANNOTATION_RE = re.compile(r"margin\s*:|p99", re.IGNORECASE)

#: bun CLI flags that arm an absolute per-test timeout, in an L1 run.sh.
RUN_SH_TIMEOUT_RE = re.compile(r"--timeout(?:-ms)?(?:=|\s+)(\d[\d_]*)")

#: `timeout: 30_000` (bun's TestOptions) in a test file.
TEST_OPTION_TIMEOUT_RE = re.compile(r"\btimeout\s*:\s*(\d[\d_]*)")

#: After a `timeout:` key, a trailing options object closes with a single `}` and
#: nothing else. This is what separates a real bun TestOptions field from a
#: `timeout` *value under test* (e.g. a config fixture inside the callback body).
OPTIONS_TAIL_RE = re.compile(r"[^}]*\}\s*$")

#: Trailing numeric third argument of a test call: `test(name, fn, 30_000)`.
TRAILING_NUMBER_RE = re.compile(r",\s*(\d[\d_]*)\s*$")

TEST_FILE_SUFFIXES = (".test.ts", ".test.tsx", ".test.js", ".test.mjs", ".test.cjs")
SKIP_DIRS = {"node_modules", ".git", "dist", "build", ".next", "coverage"}


@dataclass(frozen=True)
class Declaration:
    path: str
    line: int
    value_ms: int
    kind: str  # run.sh | option | third-arg

    def annotated(self, lines: list[str]) -> bool:
        start = max(0, self.line - 1 - ANNOTATION_WINDOW)
        return any(ANNOTATION_RE.search(ln) for ln in lines[start : self.line])


def _int(raw: str) -> int:
    return int(raw.replace("_", ""))


def scan_run_sh(path: str, text: str) -> list[Declaration]:
    out: list[Declaration] = []
    for i, line in enumerate(text.splitlines(), start=1):
        for m in RUN_SH_TIMEOUT_RE.finditer(line):
            # `--timeout 8` in one legacy suite is a *seconds* socket watch, not
            # a bun per-test timeout; bun always takes ms. Keep only ms-shaped
            # values so the inventory stays about #1627.
            value = _int(m.group(1))
            if value >= 1000:
                out.append(Declaration(path, i, value, "run.sh"))
    return out


#: `test(`/`it(`/`describe(` and friends whose options object may carry a timeout.
TEST_CALL_RE = re.compile(r"\b(test|it|describe|beforeEach|afterEach|beforeAll|afterAll)\s*(?:\.\w+)*\s*\(")

#: A generous per-call ceiling: a test body longer than this is out of scope here
#: (and the balanced walk would be cheaper than any heuristic anyway).
MAX_CALL_SPAN = 40_000


def _balanced_span(text: str, open_paren: int) -> str | None:
    """Return the text inside the parens that start at `open_paren`.

    Approximate: strings, template literals and comments are skipped so a `)`
    inside a string cannot close the call early. This is a *report-only*
    inventory, so a pathological file is allowed to yield no declaration rather
    than a wrong one.
    """
    depth = 0
    i = open_paren
    end = min(len(text), open_paren + MAX_CALL_SPAN)
    while i < end:
        ch = text[i]
        if ch == "/" and i + 1 < end and text[i + 1] == "/":
            newline = text.find("\n", i)
            i = end if newline == -1 else newline
            continue
        if ch == "/" and i + 1 < end and text[i + 1] == "*":
            close = text.find("*/", i + 2)
            i = end if close == -1 else close + 2
            continue
        if ch in "\"'`":
            quote, i = ch, i + 1
            while i < end:
                if text[i] == "\\":
                    i += 2
                    continue
                if text[i] == quote:
                    break
                i += 1
            i += 1
            continue
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
            if depth == 0:
                return text[open_paren + 1 : i]
        i += 1
    return None


def scan_test_file(path: str, text: str) -> list[Declaration]:
    out: list[Declaration] = []
    for call in TEST_CALL_RE.finditer(text):
        open_paren = call.end() - 1
        body = _balanced_span(text, open_paren)
        if body is None:
            continue
        start_line = text.count("\n", 0, call.start()) + 1
        for m in TEST_OPTION_TIMEOUT_RE.finditer(body):
            # Only the call's final options object is bun TestOptions; a `timeout:`
            # nested deeper is a value under test, not a cap on the test itself.
            if not OPTIONS_TAIL_RE.fullmatch(body[m.end() :]):
                continue
            out.append(Declaration(path, start_line, _int(m.group(1)), "option"))
        tail = TRAILING_NUMBER_RE.search(body.rstrip())
        if tail is not None:
            value = _int(tail.group(1))
            if value >= 1000:
                out.append(Declaration(path, start_line, value, "third-arg"))
    return out


def _iter_files(root: str):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for name in filenames:
            yield os.path.join(dirpath, name)


def collect(root: str) -> list[Declaration]:
    decls: list[Declaration] = []
    for path in sorted(_iter_files(root)):
        rel = os.path.relpath(path, root)
        if path.endswith(".test.mjs"):
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            except OSError:
                continue
            decls.extend(scan_test_file(rel, text))
            continue
        if rel.startswith("tests" + os.sep) and rel.endswith("run.sh"):
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                decls.extend(scan_run_sh(rel, fh.read()))
            continue
        if path.endswith(TEST_FILE_SUFFIXES):
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                decls.extend(scan_test_file(rel, fh.read()))
    return decls


def report(root: str, *, list_all: bool) -> int:
    decls = collect(root)
    annotated = 0
    unannotated: list[Declaration] = []
    for d in decls:
        try:
            with open(os.path.join(root, d.path), "r", encoding="utf-8", errors="replace") as fh:
                lines = fh.read().splitlines()
        except OSError:
            lines = []
        if d.annotated(lines):
            annotated += 1
        else:
            unannotated.append(d)

    at_default = [d for d in unannotated if d.value_ms == BUN_DEFAULT_TIMEOUT_MS]
    print(
        f"TEST-MARGIN v1 declared={len(decls)} annotated={annotated} "
        f"unannotated={len(unannotated)} at_default={len(at_default)}"
    )

    # Risk order: a declaration pinned at bun's default has no headroom by
    # construction; after that, the *smallest* caps are where a slow runner
    # turns red first. Printing 300+ lines helps nobody, so the default view is
    # the head of that list and `--list` prints everything.
    risky = sorted(unannotated, key=lambda d: (d.value_ms != BUN_DEFAULT_TIMEOUT_MS, d.value_ms, d.path))
    shown = risky if list_all else risky[:25]
    if shown:
        print("  # riskiest unannotated absolute timeouts (report-only; add a `margin:`")
        print("  # comment with the observed p99 and the multiple, or move the test off a hard cap):")
        for d in shown:
            mark = " [at bun default]" if d.value_ms == BUN_DEFAULT_TIMEOUT_MS else ""
            print(f"  - {d.path}:{d.line} {d.value_ms}ms ({d.kind}){mark}")
        if not list_all and len(risky) > len(shown):
            print(f"  # … {len(risky) - len(shown)} more; re-run with --list")
    # Report-only: this script never fails a pipeline by itself.
    return 0


def selftest() -> int:
    """Witness both directions: an annotated declaration is not flagged, an
    unannotated one is, and the return code stays 0 either way."""
    fixtures = {
        "annotated.test.ts": 'test("slow but declared", async () => {}, 45_000); '
        "// margin: p99 12s, 3.7x\n",
        "unannotated.test.ts": 'test("slow and undeclared margin", async () => {}, 25_000);\n',
        "neutral.test.ts": 'test("plain", () => { expect(1).toBe(1); });\n',
    }
    with tempfile.TemporaryDirectory() as root:
        for name, body in fixtures.items():
            with open(os.path.join(root, name), "w", encoding="utf-8") as fh:
                fh.write(body)
        decls = collect(root)
        by_path = {d.path: d for d in decls}
        failures: list[str] = []

        if set(by_path) != {"annotated.test.ts", "unannotated.test.ts"}:
            failures.append(f"expected 2 declarations, got {sorted(by_path)}")
        if set(by_path) == {"annotated.test.ts", "unannotated.test.ts"}:
            with open(os.path.join(root, "annotated.test.ts"), encoding="utf-8") as fh:
                a_lines = fh.read().splitlines()
            # The margin annotation is on the same line: `annotated()` must see it.
            if not by_path["annotated.test.ts"].annotated(a_lines):
                failures.append("annotated declaration was flagged")
            with open(os.path.join(root, "unannotated.test.ts"), encoding="utf-8") as fh:
                u_lines = fh.read().splitlines()
            if by_path["unannotated.test.ts"].annotated(u_lines):
                failures.append("unannotated declaration was NOT flagged")
        if failures:
            for f in failures:
                print(f"selftest FAIL: {f}", file=sys.stderr)
            return 1
        print("selftest ok: flagged 1 unannotated, cleared 1 annotated, ignored 0 declarations")
        return 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="TEST-MARGIN v1 report-only inventory (#1627)")
    parser.add_argument("--root", default=os.getcwd(), help="repository root (default: cwd)")
    parser.add_argument("--list", action="store_true", help="print every declaration, not just the gaps")
    parser.add_argument("--selftest", action="store_true", help="witness flag/not-flag on synthetic fixtures")
    args = parser.parse_args(argv)
    if args.selftest:
        return selftest()
    return report(os.path.abspath(args.root), list_all=args.list)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
