#!/usr/bin/env python3
"""Check the published Hub V2 contract inputs against one git commit.

The bundled desktop pin is the published tarball of preview.120, built from
sourceCommit, not from whatever server/src happens to be at HEAD. Hash each
listed file with `git show <commit>:server/<path>`. Do not regenerate the
manifest from the worktree.
"""
import hashlib
import json
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "docs/tests/hub-v2-protocol-inputs.json").read_text())
commit = manifest["sourceCommit"]
if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit):
    sys.exit("sourceCommit must be a 40-character hex git id")
failed = False
for rel, expected in manifest["files"].items():
    blob = subprocess.check_output(["git", "show", f"{commit}:server/{rel}"])
    actual = hashlib.sha256(blob).hexdigest()
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}: {rel} {actual}")
    failed = failed or not ok
if failed:
    sys.exit(1)
print(f"PASS: {manifest['package']}@{manifest['version']} inputs match {commit}")
