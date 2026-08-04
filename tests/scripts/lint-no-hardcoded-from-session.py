#!/usr/bin/env python3
"""Reject hardcoded `from` / `from_session` in POST /api/task bodies.

Why this guard exists (2026-08-04):

PR #571 bound REST identity to the bearer token. A network token (`ntok_`)
whose name resolves to `node:<alias>` may no longer claim a different
`from_session`; the hub answers 403 `from_session_identity_mismatch`.

At that moment `agent-network/bin/cli.ts` hardcoded `from: "api"` in four
POST /api/task bodies — `anet loop` (scheduled goals) plus the debate,
social and pr-review orchestrators. They worked only because the operator
config happens to hold a `utok_`, which takes the permissive branch.

Measured on the fleet host the same day:

    processes with COMMHUB_TOKEN=ntok_ : 297
    processes with COMMHUB_TOKEN=utok_ : 0

`getToken()` prefers `--token` > `COMMHUB_TOKEN` > config, so any agent
running `anet loop` from its own shell sends a node token, and the
hardcoded `from: "api"` no longer matches its alias -> 403.

Omitting the field is strictly better in both directions:

    user token -> server resolves "api"          (unchanged)
    node token -> server binds the token's alias (correct, and what #571 is for)

So the rule is: never state `from` on this path. Let the server derive it
from the credential — a caller cannot know its own alias more reliably than
the token does.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Only real callers. Test fixtures legitimately post spoofed identities to
# assert the 403 fires, so they are not scanned.
TARGETS = [
    "agent-network/bin/cli.ts",
    "agent-node/src/cli.ts",
]

# `from: "..."` or `from_session: "..."` appearing in an object literal.
PATTERN = re.compile(r'\bfrom(?:_session)?\s*:\s*["\']')

# A bare `from:` hit is a candidate, not a defect. The first draft of this
# guard flagged a code comment that quoted `from:"api"` and an unrelated
# diagnostics object `{ kind: "legacy_alias_field", from: "alias" }` — two
# false reds on correct code. Narrow to the shape that actually goes to
# POST /api/task: an object literal that also carries `priority:`.
SHAPE = re.compile(r'\bpriority\s*:')
WINDOW = 8


# A comment line, i.e. `// ...` or a ` * ...` continuation inside a block.
# Deliberately per-line: an earlier draft stripped `/* ... */` with a
# non-greedy regex over the whole file, and a `/*` sitting inside a string
# literal made it swallow ~4000 lines of real code. The guard then scanned
# blank text and reported OK on a file that did contain the defect — a
# vacuous pass that looks byte-identical to a real one.
COMMENT_LINE = re.compile(r'^\s*(?://|\*|/\*)')


failures = []
scanned = 0

for rel in TARGETS:
    path = ROOT / rel
    if not path.exists():
        # A missing target means the guard silently stops checking it, which
        # is how a scope bug turns into a vacuous pass. Fail loudly instead.
        failures.append(f"{rel}: guard target missing — update TARGETS")
        continue
    scanned += 1
    lines = path.read_text(encoding="utf8").splitlines()
    # Report the denominator per file too: a guard that reads 0 lines and a
    # guard that reads 12000 clean ones both print "OK" otherwise.
    print(f"  {rel}: {len(lines)} lines")
    for lineno, line in enumerate(lines, 1):
        if not PATTERN.search(line) or COMMENT_LINE.match(line):
            continue
        lo = max(0, lineno - 1 - WINDOW)
        hi = min(len(lines), lineno + WINDOW)
        if not any(SHAPE.search(l) for l in lines[lo:hi]):
            continue  # not a task-post body
        failures.append(f"{rel}:{lineno}: {line.strip()[:100]}")

# Report the denominator: "0 hits" is only meaningful next to "n files read".
print(f"scanned {scanned}/{len(TARGETS)} files for hardcoded from_session")

if failures:
    print("\nhardcoded from_session in a hub request body:\n")
    for f in failures:
        print(f"  {f}")
    print(
        "\nRemove the field. The hub derives from_session from the bearer "
        "token (PR #571); stating it makes a node token 403 with "
        "from_session_identity_mismatch."
    )
    sys.exit(1)

print("OK: no hardcoded from_session")
