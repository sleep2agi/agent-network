# Codex three-stage adoption (board #657 / #658)

This increment adds **adoption and stop**, not start. Three-stage start is
board #659; `adopt_codex_start_not_available` is an intentional refusal until
that implementation is available. Do not present this increment as a complete
stop/start release. No production service or deployment is changed here.

## Authority and evidence

The existing Hub active binding and daemon-token-bound acknowledgement remain
authoritative. Local registration alone grants no lifecycle authority. Node,
network, Hub URL, alias, allowed canonical workspace and UID checks precede
the Codex-specific branch. Other co-presence runtimes retain the v1 refusal.

The node directory must contain a private `codex-home` and an owned, non-writable
by others `copresence-identity.json` with the current boot ID, owner UID and
marker. Recorded PIDs in that file are not used. The original working directory
contains `.anet`, and is not `codex-home` or the node directory itself.

The collector explicitly selects the configured `ANET_TMUX_SOCKET`, or the
current UID's default socket. Both require owned socket/private parent checks.
It uses the shared UTF-8 tmux-format helper with `list-panes -a`, exact CJK name
comparison, and then opaque session/pane IDs. No `-t =name`, prefix targeting or
`kill-server`. All live members of each selected pane tree must carry the exact
marker and CODEX_HOME and agree on UID/cwd. Unproven older layouts refuse; users
must refresh their TUI launch before retrying rather than bypassing identity.
Multi-pane target sessions are currently refused, even if one pane looks valid.

## Stop and recovery boundary

Stop validates all stages before any signal, then revalidates each remaining
stage in bridge → TUI → app-server order. The verified tree stop helper checks
PID generation before signals. Marker/home checks guard destructive signals;
SIGCONT only resumes the already-verified frozen generation (a terminating
process may no longer expose environ). Retained dead panes are removed only by
their previously verified opaque pane ID. Other sessions on the shared/default
socket must survive.

Only after all three sessions and remaining marker processes are absent is
`.hub-stopped` written and success acknowledged. A completed stop can be retried
using that receipt plus fresh absence checks. Partial failure does not claim
success; it currently requires operator reconciliation rather than guessing
which remaining stage may be killed. Existing boot scanning honors the marker.

The local registry records a versioned receipt, socket, marker and config hash,
not process environments or credentials. Revocation must never resurrect it.
Existing config, Codex conversation files and directories are not deleted.
No new port, reverse proxy, secret source or resident service is introduced.
Use the existing daemon launch/deployment process; test via the Dockerfiles in
`tests/test658-codex-adopt-stop`. To roll back, avoid acting on a v2 receipt with
older software: revoke/reconcile the binding first. Conversation history,
credentials and registry/binding state require their existing secure backups;
Git source alone does not recover that data.

## Acceptance scope

Tests use only container-owned fake Codex stages and a real default-socket
decoy. No real Codex model, host tmux or production node is used. See
`docs/tests/report-board658-evidence.txt` for measured results and gaps.
