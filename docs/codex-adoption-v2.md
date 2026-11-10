# Codex three-stage adoption (board #657 / #658 / #659 A)

Adoption, stop, and **native** three-stage start are implemented. External-appserver
start still returns `adopt_codex_external_start_unproven`: that launcher does not
publish the adoption marker, so the daemon does not call it. Native start invokes
the pinned `anet node start`, then acknowledges only after the rotated marker,
three stages, and the saved loopback listen all match. It does not prove the Codex
binary version or rollout ordinal, and it does not add restart. No production
service or deployment is changed here.

Hand-started candidate discovery (`daemon_capabilities.adoption_candidates`
and `GET /api/adoption-candidates`) does not list these three-stage nodes, or
other co-presence nodes. It does not adopt, start, or stop them.

## Start inputs and preflight (board #659 A)

After live three-stage identity verification, adoption may add `start_inputs`
to the existing version-1 local receipt. These are **config-derived inputs**,
not captured argv or proof of a working launcher: full UUID thread ID, explicit
literal-loopback WebSocket endpoint, canonical owned project directory inside
the workspace, verified layout/socket/marker/home/UID, node ID, adoption request
ID and config hash. No token value, environment snapshot or shell command is
copied. Configured CODEX_HOME overrides must agree with the verified home.
Missing or invalid startup metadata leaves the node stop-only; adoption and
safe stop do not require it. Existing receipts are not silently upgraded.

Start preflight compares the complete saved input record with freshly read
identity/config/scope, requires the same active binding generation, checks for
live stages/escaped marker processes and occupied role names (including dead
panes), and probes the explicit port. It checks the local binding again after
the asynchronous probe. The probe briefly binds and closes a listening socket;
it does not reserve the port for later startup. No signal, tmux mutation,
registry write or `.hub-stopped` deletion occurs. A passing preflight continues into native stage execution. External-appserver
still stops before any spawn.

Native start re-reads `list_my_children.binding_request_id` before launch and
again before the receipt write. A missing or different generation returns
`adopt_codex_binding_generation_unproven`. Local receipt IDs never fill that
field. `get_start_request` must still be open; a superseded request returns
`adopt_codex_start_superseded` and the new stages are stopped.

Still open after this slice: proving the Codex executable and rollout ordinal,
external-appserver start, and restart. Marker rotation is recorded only after
the three stages and the loopback listen match. A failed launch restores the
previous marker file and does not supersede `.hub-stopped`. Preflight is not a
reusable authorization token. The extended `test658-codex-adopt-stop` Docker
suite covers the native launch, the listen refusal, and the generation rollback.

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
Absent `codexLaunchLayout` means native (TUI=alias, bridge=alias-桥);
`external-appserver` means TUI=alias-tui, bridge=alias. Both use alias-appsrv.
Unknown layouts refuse. The selected layout is persisted and checked against
the binding. This does not bypass missing marker/identity evidence in older
external launchers: refresh that evidence before adoption. Extra same-marker
processes outside the selected trees, including mixed-layout residue, refuse
before any signal. Pane roots must have the workspace cwd; verified descendants
may also use subdirectories of that workspace, never sibling/prefix lookalikes.

## Stop and recovery boundary

Stop validates all live stages before any signal, then revalidates each remaining
stage in bridge → TUI → app-server order. The verified tree stop helper checks
PID generation before signals. Marker/home checks guard destructive signals;
SIGCONT only resumes the already-verified frozen generation (a terminating
process may no longer expose environ). Retained dead panes are removed only by
their previously verified opaque pane ID. Other sessions on the shared/default
socket must survive.

Only after all three live stages and remaining marker processes are absent is
`.hub-stopped` written and success acknowledged. A completed stop can be retried
using fresh absence checks, not trusting the receipt alone. Missing stages are
permitted only after a global marker census excludes processes outside the
remaining verified trees. A replay can stop surviving or SIGSTOP-frozen stages.
Detached marker processes still refuse without signals: the operator must
reconcile those processes explicitly; retry then resumes the remaining stages.
Dead remain-on-exit panes from an earlier daemon are not live processes.
Existing boot scanning honors the marker. Receipts include marker and binding
request ID; successful re-adoption removes an old receipt. A manual restart
that rotates the marker returns `adopt_codex_readopt_required`: revoke the old
binding and re-adopt after refreshing the three-stage evidence. No automatic
transfer of authority to a new generation is performed. A stale receipt never
prevents normal verified stop of a live same-generation node.

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

Tests use only container-owned fake Codex stages. The Bun tmux suites require
both Docker detection and explicit image opt-in, otherwise they skip before
fixture setup. Each test uses a random private socket and cleanup tracks only
pane IDs returned by its own creation calls, never a census of all panes.
The standalone Docker HTTP regression retains its container-owned default-socket
decoy. No real Codex model, host tmux or production node is used. See
`docs/tests/report-test658-review-fixes.txt` for current measured results and
`docs/tests/report-board658-evidence.txt` for the earlier implementation record.
