#!/usr/bin/env python3
"""Every test CI actually runs must also be able to re-trigger the workflow that runs it.

`.github/workflows/qa.yml` fires on a path filter. A test directory that CI
executes but that is missing from that filter can be edited without the gate
re-running — the change ships against whatever the gate last said, and the
output looks identical to a gate that passed on the new code.

Found on 2026-08-17: three of the four test directories reached through
`scripts/qa.sh` L1_TESTS were outside the filter (test686-rest-shape-golden,
test765-batch-runtime-gate, test766-bunx-preflight), plus test292-e2e-hard-gate
which a workflow references by path. The reason it was easy to miss is that
`tests/` holds ~166 directories and only a handful are wired into CI at all, so
"most tests are not in the filter" is the normal, correct state and hides the
few that should be.

Deliberately NOT flagged: the ~160 directories no workflow executes. Listing
them would grow the filter without adding a single gate, and a filter that
triggers on unrun tests reads like coverage it does not have.

Scope is fail-closed: if the workflow, qa.sh, or tests/ cannot be found, this
exits 2 rather than reporting a clean run against nothing.
"""
import re
import sys
from pathlib import Path

QA_YML = Path(".github/workflows/qa.yml")
QA_SH = Path("scripts/qa.sh")
TESTS_DIR = Path("tests")
WORKFLOWS = Path(".github/workflows")


def bash_array(text: str, name: str) -> list[str]:
    """Entries of a `NAME=( "a" "b" )` bash array, or [] when absent."""
    m = re.search(rf"{name}=\(([^)]*)\)", text, re.S)
    return re.findall(r'"([^"]+)"', m.group(1)) if m else []


def main() -> int:
    for p in (QA_YML, QA_SH, TESTS_DIR):
        if not p.exists():
            print(f"::error::{p} not found — scope regression, refusing to pass")
            return 2

    test_dirs = {d.name for d in TESTS_DIR.iterdir() if d.is_dir() and d.name.startswith("test")}
    if not test_dirs:
        print(f"::error::no test directories under {TESTS_DIR} — scope regression, refusing to pass")
        return 2

    qa_sh = QA_SH.read_text(encoding="utf-8", errors="replace")
    # L1 entries name the directory bare (no `tests/` prefix); L0 entries name
    # source files, so only the ones that resolve to a real test dir count.
    executed = {e for e in bash_array(qa_sh, "L1_TESTS") + bash_array(qa_sh, "L0_TESTS")
                if e in test_dirs}

    # Anything a workflow references by path is executed too.
    for wf in sorted(list(WORKFLOWS.glob("*.yml")) + list(WORKFLOWS.glob("*.yaml"))):
        body = wf.read_text(encoding="utf-8", errors="replace")
        # A path filter entry is not a reference to running it — strip those
        # first, or every listed dir would look self-justifying.
        body = re.sub(r"^\s*-\s*'tests/[^']+'\s*$", "", body, flags=re.M)
        executed |= {m.rstrip("/") for m in re.findall(r"tests/(test[\w.\-]+)", body)} & test_dirs

    if not executed:
        print("::error::no CI-executed test directories detected — the parser probably "
              "stopped matching qa.sh or the workflows; refusing to pass")
        return 2

    covered = set(re.findall(r"tests/(test[\w.\-]+)/\*\*", QA_YML.read_text(encoding="utf-8")))
    gap = sorted(executed - covered)

    print(f"tests/ directories: {len(test_dirs)} · CI-executed: {len(executed)} · "
          f"in qa.yml path filter: {len(covered)}")

    if gap:
        for d in gap:
            print(f"::error file={QA_YML}::tests/{d} is executed by CI but missing from the "
                  f"qa.yml path filter — editing it will not re-run its own gate.\n"
                  f"    Add:  - 'tests/{d}/**'")
        print(f"\n{len(gap)} executed test directory/ies outside the trigger filter.")
        return 1

    stale = sorted(covered - executed)
    if stale:
        # Not a failure: a dir may be listed ahead of being wired up. But say it,
        # because a filter entry for something CI never runs is coverage theatre.
        print("note: in the filter but not executed by CI (harmless, but not coverage): "
              + ", ".join(stale))

    print(f"all {len(executed)} CI-executed test directory/ies can re-trigger qa.yml.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
