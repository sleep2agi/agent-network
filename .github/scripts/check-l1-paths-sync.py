#!/usr/bin/env python3
"""Every suite qa.sh runs must also be a `paths:` trigger of the workflow that runs it.

Two facts decide different halves of one thing, and nothing keeps them in sync:

  tests/<suite>/qa.l1                 — WHAT gets run (L1)
  .github/workflows/qa.yml  `paths:`  — WHEN it gets run

Board #675 collapsed the per-suite globs to one `tests/**` on both
pull_request and push. A new L1 suite is a new marker file, not a new
line in qa.yml. If that blanket entry disappears, editing an L1 suite
no longer triggers the workflow that runs it, and a green gate would
not say so.

Fail-closed: an empty marker list or an empty path list is a parse
regression, exit 2, not a clean run.
"""
import fnmatch
import sys
from pathlib import Path

try:
    import yaml
except ImportError:
    print("::error::PyYAML is not available — cannot parse the workflow, refusing to pass")
    sys.exit(2)

from l1_markers import marker_names

QA_YML = Path(".github/workflows/qa.yml")
TESTS = Path("tests")


def l1_suites(tests: Path) -> list[str]:
    """Suite names that opted into L1 with a regular tests/<suite>/qa.l1.

    Hidden directories and a qa.l1 that is not a regular file are not L1.
    Same rule as scripts/qa.sh.
    """
    return marker_names(tests)


def pr_paths(doc: dict) -> list[str]:
    # YAML 1.1 parses a bare `on:` key as the boolean True, so accept both.
    on = doc.get("on") or doc.get(True) or {}
    pr = on.get("pull_request") or {}
    return list(pr.get("paths") or [])


def covered(suite: str, paths: list[str]) -> bool:
    """Would a change inside tests/<suite>/ match any of the workflow's paths?

    Checked against a concrete file rather than the directory: GitHub matches
    `paths:` against changed FILE paths, so `tests/x/**` must be tested with
    something under it, not with `tests/x/`. `tests/**` covers every suite.
    """
    probe = f"tests/{suite}/run.sh"
    for p in paths:
        if p == "tests/**":
            return True
        if fnmatch.fnmatch(probe, p) or fnmatch.fnmatch(probe, p.replace("**", "*")):
            return True
    return False


def main() -> int:
    if not QA_YML.is_file():
        print(f"::error::{QA_YML} is missing — scope regression, refusing to pass")
        return 2
    try:
        doc = yaml.safe_load(QA_YML.read_text(encoding="utf-8"))
    except OSError as e:
        print(f"::error::{e.filename} is missing — scope regression, refusing to pass")
        return 2

    suites = l1_suites(TESTS)
    paths = pr_paths(doc)

    if not suites:
        print(f"::error::found no tests/*/qa.l1 markers — parse regression, refusing to pass")
        return 2
    if not paths:
        print(f"::error::found no on.pull_request.paths in {QA_YML} — parse regression, refusing to pass")
        return 2

    missing = [s for s in suites if not covered(s, paths)]
    for s in missing:
        print(
            f"::error file={QA_YML}::L1 suite '{s}' has tests/{s}/qa.l1 but no `paths:` entry "
            f"matches tests/{s}/. Editing that suite will not trigger the workflow that runs "
            f"it. Put `tests/**` on both pull_request and push. Do not add another per-suite line."
        )

    print(f"checked {len(suites)} L1 suite(s) against {len(paths)} path pattern(s) in {QA_YML}")
    if missing:
        print(f"\n{len(missing)} suite(s) run without a matching trigger.")
        return 1
    print("every L1 suite has a matching trigger.")
    return 0


def selftest() -> int:
    """Pin marker discovery and the tests/** match. An empty list must stay empty."""
    import tempfile

    yml = {
        "on": {"pull_request": {"paths": ["tests/**", "scripts/qa.sh"]}},
    }
    old = {
        "on": {"pull_request": {"paths": ["tests/qa-*/**", "tests/test-b/**", "scripts/qa.sh"]}},
    }
    with tempfile.TemporaryDirectory() as td:
        tests = Path(td)
        (tests / "qa-a").mkdir()
        (tests / "qa-a" / "qa.l1").write_text("\n", encoding="utf-8")
        (tests / "test-b").mkdir()
        (tests / "test-b" / "qa.l1").write_text("note\n", encoding="utf-8")
        (tests / "test-c").mkdir()
        (tests / "test-c" / "run.sh").write_text("#!/bin/sh\n", encoding="utf-8")
        (tests / ".hidden").mkdir()
        (tests / ".hidden" / "qa.l1").write_text("\n", encoding="utf-8")
        (tests / "suite-dir").mkdir()
        (tests / "suite-dir" / "qa.l1").mkdir()
        (tests / "suite-dangling").mkdir()
        (tests / "suite-dangling" / "qa.l1").symlink_to("missing-target")
        found = l1_suites(tests)
    cases = [
        ("qa.l1 markers parsed in full", found == ["qa-a", "test-b"]),
        ("run.sh without qa.l1 is not L1", "test-c" not in found),
        ("hidden dir is not L1", ".hidden" not in found),
        ("qa.l1 directory is not L1", "suite-dir" not in found),
        ("dangling qa.l1 is not L1", "suite-dangling" not in found),
        ("missing tests dir yields empty (→ exit 2 upstream)", l1_suites(Path(td) / "nope") == []),
        ("paths read from on.pull_request", len(pr_paths(yml)) == 2),
        ("bare `on:` parsed as True still works", len(pr_paths({True: yml["on"]})) == 2),
        ("tests/** covers a suite", covered("qa-a", pr_paths(yml))),
        ("tests/** covers a second suite", covered("test-c", pr_paths(yml))),
        ("explicit pattern covers a suite", covered("test-b", pr_paths(old))),
        ("uncovered suite is reported", not covered("test-c", pr_paths(old))),
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
