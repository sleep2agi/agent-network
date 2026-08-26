# test1212 — protected Windows real-Codex gate

This is deliberately **NOT-IN-CI**: it is not an automatic/public CI claim and
has no PR trigger. Only the workflow file already present on `main` can be
started with `workflow_dispatch`; it checks out that trusted default branch and
requires the supplied full SHA to equal its HEAD. PR head code is never checked
out by the credentialed job. Execution also requires a human-approved
`windows-latest` job in the protected
`windows-codex-real-gate` environment. The environment supplies
`CODEX_AUTH_JSON`; forks and ordinary PR jobs never receive it. Missing auth,
wrong/main source SHA, a non-Windows host, or a Codex version other
than exactly 0.148.0 fails closed.

The non-credential preflight also queries environment metadata and refuses to
schedule the Windows job unless that environment already exists with a
`required_reviewers` rule. A wait timer or branch rule alone is insufficient.
This prevents a misspelled/missing environment from being
silently auto-created without approval. It reads no secret names or values.

Codex's npm launcher and Windows x64 vendor executable must exactly match the
reviewed SHA-256 allowlist committed beside this file. The secret is removed
from the subprocess environment before npm runs and is written only after both
downloaded executable hashes match.

The journey uses real Codex `app-server`, the real Codex TUI through ConPTY,
the repository-built agent-node, and a disposable Hub/database. It requires
normal and high tasks to remain in one active human turn for at least 60s. The
nonce appears once in the echoed prompt and must appear a second time with the
post-tool `HUMAN_DONE` response at least 60s after task injection. It also checks
same thread/remote/HOME, exactly one bridge, clean stop, and history-preserving
restart. `turnStartOutcomeDelta: 0` is explicitly a production bridge outcome
(two `(steered)` messages and no queued/new-turn outcome), not a raw WebSocket
capture. test751 remains fake-wire coverage; the Linux #1193 report remains
Linux host evidence. Neither is relabelled as Windows real-Codex evidence.

Only `result.json` and `report.txt` are uploaded. They contain no credential,
raw terminal/app-server/bridge log, absolute private path, or raw thread/turn
ID. The entire private root is ACL-restricted and deleted after the run.
