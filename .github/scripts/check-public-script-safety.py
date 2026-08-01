#!/usr/bin/env python3
"""Block destructive patterns from shipping in publicly downloadable shell scripts.

Everything under docs-site/docs/public/*.sh is served from https://anet.sh/<name>
and several of those scripts tell the reader to pipe them straight into bash.
A mistake there runs on a stranger's machine with their privileges.

On 2026-07-31 four such scripts were found to contain, between them:
  * `rm -rf ~/.npm/_npx`  — that directory is not ours. npx unpacks packages
    there and executes FROM there, so wiping it breaks every other npx-based
    tool on the machine. Reproduced in a container: a second tool's files
    went 1 -> 0.
  * `pkill -f agent-node` — pattern matching hits same-named processes owned
    by anyone. This repo has already taken down a production hub that way.

All four were found by hand. This guard exists so the next one is not.

Scope note: only two rules, both unambiguous. A guard that cries wolf gets
disabled, and then it protects nothing. Deliberately NOT flagged here:
  * printing a documented default password (correct for the stable channel,
    which is what these scripts install)
  * binding 0.0.0.0 behind an explicit opt-in env var
Those need judgement, so they stay with human review.
"""
import re
import sys
from pathlib import Path

PUBLIC_DIR = Path("docs-site/docs/public")

# Paths this product owns. Wiping these is the user's stated intent (WIPE=1).
OURS = ("~/.anet", "~/.commhub", "~/anodes/.anet",
        "~/.npm-global/lib/node_modules/@sleep2agi", "~/.anet-grok")

RM_RF = re.compile(r"\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(?P<targets>[^\n;&|]+)")
KILL = re.compile(r"\b(pkill|killall)\b(?P<args>[^\n;&|]*)")
USER_SCOPED = re.compile(r"-u\s+\S")


def check(path: Path):
    """Return a list of (line_no, rule, offending_text)."""
    out = []
    for i, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if line.lstrip().startswith("#"):
            continue

        m = RM_RF.search(line)
        if m:
            for tok in m.group("targets").split():
                if tok.startswith("-") or tok.startswith("2>") or tok == "||" or tok == "true":
                    continue
                if not any(tok.startswith(o) for o in OURS):
                    out.append((i, "rm-rf-outside-product", tok))

        k = KILL.search(line)
        if k and not USER_SCOPED.search(k.group("args")):
            out.append((i, "unscoped-process-kill", line.strip()[:90]))
    return out


def main():
    if not PUBLIC_DIR.is_dir():
        print(f"::error::{PUBLIC_DIR} does not exist — scope regression, refusing to pass")
        return 2

    scripts = sorted(PUBLIC_DIR.glob("*.sh"))
    # A scan that matched nothing and a scan that never ran print the same "0".
    # Report the denominator, and treat an empty scope as a failure.
    if not scripts:
        print(f"::error::scanned ZERO scripts under {PUBLIC_DIR} — scope regression, refusing to pass")
        return 2

    findings = []
    for s in scripts:
        for line_no, rule, text in check(s):
            findings.append((s, line_no, rule, text))

    print(f"scanned {len(scripts)} public script(s): {', '.join(s.name for s in scripts)}")

    if not findings:
        print(f"0 findings across {len(scripts)} script(s).")
        return 0

    for s, line_no, rule, text in findings:
        if rule == "rm-rf-outside-product":
            hint = ("path is not owned by this product — wiping it damages unrelated "
                    "tools on the user's machine. Remove it, or narrow to a path we own.")
        else:
            hint = ("pattern-matched kill hits same-named processes owned by anyone. "
                    'Scope it: pkill -u "$(id -u)" -f ...')
        print(f"::error file={s},line={line_no}::[{rule}] {text}\n    {hint}")

    print(f"\n{len(findings)} finding(s) across {len(scripts)} scanned script(s).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
