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


def l1_suites(text: str) -> list[str]:
    """Suite names from qa.sh's L1_TESTS array."""
    m = re.search(r"L1_TESTS=\(([^)]*)\)", text, re.S)
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
