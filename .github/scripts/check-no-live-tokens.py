#!/usr/bin/env python3
"""Block real-looking ANet tokens (ntok_ / utok_ / atok_) from being committed.

Why this guard exists
=====================
2026-11-11: a real network token (ntok_ + 32 hex) sat in a lessons doc in this
public repo for five months. It was unbound, so anyone holding it could dispatch
tasks to every agent in that network. GitHub secret scanning does not know our
token formats, so this check does.

What counts as a token
======================
`(ntok|utok|atok|ctok|dtok)_` followed by exactly 32 hex chars (the shape
db.ts generateToken / generateUserToken / generateNetworkToken produce).

Allowed placeholders (not flagged):
- a run of 8+ identical chars (atok_00000000...)
- a sequence containing `1234567890abcdef` or `0123456789abcdef`
- anything that is not exactly 32 hex chars (ntok_<redacted>, ntok_xxx...)

Scans tracked text files (git ls-files). Exit 0 clean, 1 on findings.
"""

from __future__ import annotations

import re
import subprocess
import sys

TOKEN_RE = re.compile(r"\b(?:ntok|utok|atok|ctok|dtok)_([0-9a-f]{32})\b")
SKIP_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz", ".tgz", ".woff", ".woff2", ".ttf", ".mp4", ".mov", ".lock")
SELF = ".github/scripts/check-no-live-tokens.py"


def is_placeholder(hex32: str) -> bool:
    if re.search(r"(.)\1{7,}", hex32):
        return True
    return "1234567890abcdef" in hex32 or "0123456789abcdef" in hex32


def findings_in(text: str) -> list[tuple[int, str]]:
    out = []
    for lineno, line in enumerate(text.splitlines(), 1):
        for m in TOKEN_RE.finditer(line):
            if not is_placeholder(m.group(1)):
                out.append((lineno, m.group(0)[:10] + "…"))
    return out


def selftest() -> int:
    real = "TOK='ntok_fc200cca7fc445448d3e4ea795028588'"
    assert findings_in(real), "real-shaped token must be flagged"
    for ok in ("atok_00000000000000000000000000000000", "atok_1234567890abcdef1234567890abcdef",
               "ntok_<redacted>", "utok_xxxxxxxxxxxxxxxx", "ntok_abc", "myntok_fc200cca7fc445448d3e4ea795028588x"):
        assert not findings_in(ok), f"placeholder flagged: {ok}"
    print("check-no-live-tokens selftest: ok")
    return 0


def main(argv: list[str]) -> int:
    if "--selftest" in argv:
        return selftest()
    files = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True).stdout.decode().split("\0")
    bad = []
    for path in files:
        if not path or path == SELF or path.endswith(SKIP_SUFFIXES) or "/node_modules/" in path:
            continue
        try:
            with open(path, encoding="utf-8", errors="ignore") as fh:
                text = fh.read()
        except (OSError, IsADirectoryError):
            continue
        for lineno, shown in findings_in(text):
            bad.append(f"{path}:{lineno}: {shown}")
    if bad:
        print("Real-looking ANet tokens are committed (revoke them on the Hub, then replace with ntok_<redacted>):")
        print("\n".join(bad))
        return 1
    print("check-no-live-tokens: clean")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
