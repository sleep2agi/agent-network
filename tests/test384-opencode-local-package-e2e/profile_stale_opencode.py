#!/usr/bin/python3
"""Tripwire binary planted on the node profile PATH.

The launcher must bind the parent-verified absolute OpenCode executable after
profile env merge, so this file must never be invoked for either --version or
ACP. Writing the marker before argument handling detects both paths.
"""

from pathlib import Path
import sys

suite = Path(__file__).resolve().parents[1].name
marker = Path("/tmp") / suite / "profile-stale-opencode-was-executed"
marker.write_text("executed\n", encoding="ascii")

if "--version" in sys.argv:
    print("1.17.13")
    raise SystemExit(0)

print("profile-controlled stale OpenCode must never execute", file=sys.stderr)
raise SystemExit(77)
