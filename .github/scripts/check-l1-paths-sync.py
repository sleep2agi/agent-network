#!/usr/bin/env python3
"""Every suite qa.sh runs must also be a `paths:` trigger of the workflow that runs it.

Two lists decide different halves of one thing, and nothing keeps them in sync:

  scripts/qa.sh          `L1_TESTS`                  — WHAT gets run
  .github/workflows/qa.yml  `on.pull_request.paths`  — WHEN it gets run

Add a suite to L1_TESTS and forget the paths entry, and the gate is blind to that
suite forever: editing it does not trigger the workflow that runs it. That failure
has already happened once here (#860, three suites: test686 / test765 / test766).

🔴 It leaves no trace that would expose it. The gate keeps passing, the suite keeps
being maintained, and the only way to notice is to line the two lists up and compare
them — which is what this script does. A drift like this is invisible precisely
because nothing about a green run distinguishes "ran and passed" from "was never
eligible to run".

Deliberately dependency-free and unconditional: no `paths:` filter of its own, no
Docker, milliseconds. That is not an accident — a guard that watches trigger
coverage must not itself be gated on a path, or a change to the thing it watches
can slip past it (same reasoning as check-qa-trigger-coverage.py and
check-action-pins.py).

Fail-closed: if either list comes back empty, that is a parse regression, not a
clean run — exit 2 rather than reporting success over an empty denominator.
"""
import fnmatch
import re
import sys

try:
    import yaml
except ImportError:
    print("::error::PyYAML is not available — cannot parse the workflow, refusing to pass")
    sys.exit(2)

QA_SH = "scripts/qa.sh"
QA_YML = ".github/workflows/qa.yml"


def _strip_comments(text: str) -> str:
    """去掉每行的 `#` 注释。

    🔴 这不是洁癖,是一个**取集**缺陷的修复。下面的数组正则用 `[^)]*`,
    它在遇到第一个 `)` 时停下 —— 而 bash 数组里**注释是合法的**,注释里出现
    `)` 也是合法的:

        L1_TESTS=(
          # (注册这一步不是可选的 —— 一个没被调用的套件等于不存在。)
          "test823-l1-concurrency-cap"
          ...
        )

    正则在那个中文注释的 `)` 处截断,捕获到的内容里**一个套件名都没有**,
    于是 `l1_suites()` 返回 [] —— 判据完全正确,取集塌了。

    这次它 fail-closed(exit 2「parse regression」)所以被看见了。同一个洞
    如果长在一个「没找到就当没有」的检查里,就是一片安静的假绿。
    数组里的元素不会含 `#`(套件名是 kebab-case),所以按行剥注释是安全的。
    """
    return "\n".join(line.split("#", 1)[0] for line in text.split("\n"))


def l1_suites(text: str) -> list[str]:
    """Suite names from qa.sh's L1_TESTS array."""
    m = re.search(r"L1_TESTS=\(([^)]*)\)", _strip_comments(text), re.S)
    if not m:
        return []
    return re.findall(r'"([^"]+)"', m.group(1))


def pr_paths(doc: dict) -> list[str]:
    # YAML 1.1 parses a bare `on:` key as the boolean True, so accept both.
    on = doc.get("on") or doc.get(True) or {}
    pr = on.get("pull_request") or {}
    return list(pr.get("paths") or [])


def covered(suite: str, paths: list[str]) -> bool:
    """Would a change inside tests/<suite>/ match any of the workflow's paths?

    Checked against a concrete file rather than the directory: GitHub matches
    `paths:` against changed FILE paths, so `tests/x/**` must be tested with
    something under it, not with `tests/x/`.
    """
    probe = f"tests/{suite}/run.sh"
    for p in paths:
        if fnmatch.fnmatch(probe, p) or fnmatch.fnmatch(probe, p.replace("**", "*")):
            return True
    return False


def main() -> int:
    try:
        sh = open(QA_SH, encoding="utf-8").read()
        doc = yaml.safe_load(open(QA_YML, encoding="utf-8"))
    except FileNotFoundError as e:
        print(f"::error::{e.filename} is missing — scope regression, refusing to pass")
        return 2

    suites = l1_suites(sh)
    paths = pr_paths(doc)

    if not suites:
        print(f"::error::found no L1_TESTS entries in {QA_SH} — parse regression, refusing to pass")
        return 2
    if not paths:
        print(f"::error::found no on.pull_request.paths in {QA_YML} — parse regression, refusing to pass")
        return 2

    missing = [s for s in suites if not covered(s, paths)]
    for s in missing:
        print(
            f"::error file={QA_SH}::L1 suite '{s}' is run by qa.sh but no `paths:` entry in "
            f"{QA_YML} matches tests/{s}/. Editing that suite will not trigger the workflow "
            f"that runs it, and nothing else would report that. Add `tests/{s}/**` to "
            f"on.pull_request.paths."
        )

    print(f"checked {len(suites)} L1 suite(s) against {len(paths)} path pattern(s) in {QA_YML}")
    if missing:
        print(f"\n{len(missing)} suite(s) run without a matching trigger.")
        return 1
    print("every L1 suite has a matching trigger.")
    return 0


def selftest() -> int:
    """Pin the two parsers, because that is where this gate would go blind.

    If `l1_suites` silently returns [] the run above exits 2 — but if it returns a
    SUBSET, the gate passes while checking fewer suites than exist, and the output
    is indistinguishable from a real clean run except for one count nobody reads.
    """
    sh = 'x=1\nL1_TESTS=(\n  "qa-a"\n  "test-b"   # trailing comment\n)\necho hi\n'
    yml = {
        "on": {"pull_request": {"paths": ["tests/qa-*/**", "tests/test-b/**", "scripts/qa.sh"]}},
    }
    cases = [
        ("L1_TESTS parsed in full", l1_suites(sh) == ["qa-a", "test-b"]),
        # 🔴 见 _strip_comments:数组里一条**含右括号的注释**会让 `[^)]*` 提前截断,
        # 捕获内容里一个套件名都没有。这条夹具照着实际撞红的那次写(#835 往
        # L1_TESTS 里加了一行「(注册这一步不是可选的 …)」)。
        (
            "注释里的 ) 不截断数组",
            l1_suites('L1_TESTS=(\n  # (注册不是可选的)\n  "qa-a"\n  "test-b"\n)\n')
            == ["qa-a", "test-b"],
        ),
        (
            "数组后面别处的 ) 不影响",
            l1_suites('L1_TESTS=(\n  "qa-a"\n)\nfoo() { :; }\n') == ["qa-a"],
        ),
        ("missing array yields empty (→ exit 2 upstream)", l1_suites("no array here") == []),
        ("paths read from on.pull_request", len(pr_paths(yml)) == 3),
        ("bare `on:` parsed as True still works", len(pr_paths({True: yml["on"]})) == 3),
        ("glob pattern covers a suite", covered("qa-a", pr_paths(yml))),
        ("explicit pattern covers a suite", covered("test-b", pr_paths(yml))),
        ("uncovered suite is reported", not covered("test-c", pr_paths(yml))),
        ("dir-only probe would false-negative — we probe a file", covered("test-b", ["tests/test-b/**"])),
    ]
    bad = [n for n, ok in cases if not ok]
    for n, ok in cases:
        print(f"  {'ok  ' if ok else 'FAIL'} {n}")
    if bad:
        print(f"::error::selftest failed: {len(bad)} case(s)")
        return 1
    print(f"selftest: {len(cases)}/{len(cases)} ok")
    return 0


if __name__ == "__main__":
    sys.exit(selftest() if "--selftest" in sys.argv else main())
