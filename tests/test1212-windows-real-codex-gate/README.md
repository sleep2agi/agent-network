# test1212 — protected Windows real-Codex gate

This is deliberately **NOT-IN-CI**: it is not an automatic/public CI claim. A
Draft PR is scheduled only when a reviewer applies the
`windows-real-codex-gate` label (and rescheduled on later commits), or it can be
requested explicitly with `workflow_dispatch`. Execution still requires a
human-approved `windows-latest` runner job in the protected
`windows-codex-real-gate` environment. The environment supplies
`CODEX_AUTH_JSON`; forks and ordinary PR jobs never receive it. Missing auth,
wrong source SHA, a non-Draft PR, a non-Windows host, or a Codex version other
than exactly 0.148.0 fails closed.

The non-credential preflight also queries environment metadata and refuses to
schedule the Windows job unless that environment already exists with at least
one protection rule. This prevents a misspelled/missing environment from being
silently auto-created without approval. It reads no secret names or values.

The journey uses real Codex `app-server`, the real Codex TUI through ConPTY,
the repository-built agent-node, and a disposable Hub/database. It requires
normal and high tasks to remain in one active human turn for at least 60s,
same thread/remote/HOME, exactly one bridge, clean stop, and history-preserving
restart. `turnStartOutcomeDelta: 0` is explicitly a production bridge outcome
(two `(steered)` messages and no queued/new-turn outcome), not a raw WebSocket
capture. test751 remains fake-wire coverage; the Linux #1193 report remains
Linux host evidence. Neither is relabelled as Windows real-Codex evidence.

Only `result.json` and `report.txt` are uploaded. They contain no credential,
raw terminal/app-server/bridge log, absolute private path, or raw thread/turn
ID. The entire private root is ACL-restricted and deleted after the run.
