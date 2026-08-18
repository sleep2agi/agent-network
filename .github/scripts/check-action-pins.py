#!/usr/bin/env python3
"""Third-party GitHub Actions must be pinned to a commit SHA, not a moving tag.

`uses: some-org/some-action@v2` resolves whatever that tag points at today. The
tag is writable by whoever owns the action, so the code that runs in CI — with
this repository's checkout and secrets in scope — can change without a commit
here and without anyone reviewing it.

Scope, stated because a filter you cannot see is a filter you cannot trust:

  * `actions/*` (GitHub's own) are ALLOWED on tags. That is the near-universal
    convention, they are first-party, and changing them is a separate policy
    call — not something to smuggle in under a guard about third parties.
  * Everything else must carry a 40-hex SHA. A trailing `# v2` comment is
    encouraged so a reader can still tell what the pin means.
  * Local actions (`./…`) and Docker actions (`docker://…`) are out of scope:
    they are not fetched from a tag at all.

This does NOT claim to fix flaky downloads. On 2026-08-17 a `L0 + L1` job here
failed with three consecutive 429s fetching `oven-sh/setup-bun`, and a SHA pin
would not have changed that — the request still goes to codeload. Pinning is
about knowing WHAT ran, not about whether the fetch succeeds. Saying otherwise
would be selling the guard on a benefit it does not deliver.

Fail-closed: no workflow files, or no `uses:` lines at all, exits 2 rather than
reporting a clean scan of nothing.
"""
import re
import sys
from pathlib import Path

WORKFLOWS = Path(".github/workflows")
USES = re.compile(r"^\s*(?:-\s*)?uses:\s*([^\s#]+)")
SHA40 = re.compile(r"^[0-9a-f]{40}$")
FIRST_PARTY_OWNERS = {"actions", "github"}


def main() -> int:
    if not WORKFLOWS.is_dir():
        print(f"::error::{WORKFLOWS} does not exist — scope regression, refusing to pass")
        return 2

    files = sorted(list(WORKFLOWS.glob("*.yml")) + list(WORKFLOWS.glob("*.yaml")))
    if not files:
        print(f"::error::no workflow files under {WORKFLOWS} — scope regression, refusing to pass")
        return 2

    total = 0
    problems = 0
    for f in files:
        for i, line in enumerate(f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            m = USES.match(line)
            if not m:
                continue
            ref = m.group(1)
            if ref.startswith("./") or ref.startswith("docker://"):
                continue
            total += 1
            if "@" not in ref:
                problems += 1
                print(f"::error file={f},line={i}::`{ref}` has no ref at all — pin it to a commit SHA")
                continue
            repo, _, version = ref.rpartition("@")
            owner = repo.split("/", 1)[0]
            if owner in FIRST_PARTY_OWNERS:
                continue
            if not SHA40.match(version):
                problems += 1
                print(
                    f"::error file={f},line={i}::third-party action `{repo}` is pinned to "
                    f"`{version}`, a tag its owner can repoint. Whatever it points at runs here "
                    f"with this checkout and these secrets, without a commit in this repo.\n"
                    f"    Pin the SHA and keep the tag as a comment:\n"
                    f"      uses: {repo}@<40-hex-sha> # {version}"
                )

    if total == 0:
        print("::error::scanned ZERO `uses:` lines — the parser stopped matching; refusing to pass")
        return 2

    print(f"checked {total} action reference(s) across {len(files)} workflow file(s)")
    if problems:
        print(f"\n{problems} unpinned third-party action(s).")
        return 1
    print("every third-party action is pinned to a commit SHA.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
