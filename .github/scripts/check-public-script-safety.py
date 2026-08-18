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

  * (added 2026-08-17) nothing yet — this third rule is preventive. Every one
    of these scripts is fetched over https and piped into bash, so TLS
    verification is the reader's only defence against a tampered download.
    `curl -k` / `--insecure` / `wget --no-check-certificate` removes it, which
    is why it belongs with the other two rather than with human review: there
    is no legitimate reason for a script published at a public https URL to
    skip verifying that URL.

Scope note: three rules, all unambiguous. A guard that cries wolf gets
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
# TLS verification is the only thing standing between the reader and a tampered
# download, and these scripts are meant to be piped straight into bash.
INSECURE_TLS = re.compile(
    r"\b(?:curl\b[^\n;&|]*?(?:\s-{1,2}(?:k|insecure)\b)"
    r"|wget\b[^\n;&|]*?--no-check-certificate\b"
    r"|(?:NODE_TLS_REJECT_UNAUTHORIZED|PYTHONHTTPSVERIFY)\s*=\s*0)"
)


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

        if INSECURE_TLS.search(line):
            out.append((i, "tls-verification-disabled", line.strip()[:90]))
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

    # Keyed by rule, not by an if/else that falls through: a new rule reaching
    # the `else` branch would print another rule's remediation, which is worse
    # than printing none — the reader follows advice for a problem they do not
    # have. (Caught exactly that while adding the TLS rule.)
    HINTS = {
        "rm-rf-outside-product":
            "path is not owned by this product — wiping it damages unrelated "
            "tools on the user's machine. Remove it, or narrow to a path we own.",
        "unscoped-process-kill":
            "pattern-matched kill hits same-named processes owned by anyone. "
            'Scope it: pkill -u "$(id -u)" -f ...',
        "tls-verification-disabled":
            "this script is fetched over https and piped into bash; skipping "
            "certificate verification removes the reader's only protection "
            "against a tampered download. Drop the flag.",
    }
    unknown = sorted({rule for _, _, rule, _ in findings} - HINTS.keys())
    if unknown:
        print(f"::error::rule(s) with no remediation text: {', '.join(unknown)} — "
              "add one to HINTS rather than letting it borrow another rule's advice")
        return 2

    for s, line_no, rule, text in findings:
        print(f"::error file={s},line={line_no}::[{rule}] {text}\n    {HINTS[rule]}")

    print(f"\n{len(findings)} finding(s) across {len(scripts)} scanned script(s).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
