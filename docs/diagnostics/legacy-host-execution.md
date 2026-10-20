# Legacy host commands: accepted is not running

This candidate adds a refusal gate and metadata receipts for host commands. It
does **not** enable unattended legacy Claude startup or recover a remote host.
The legacy `node-server` channel does not handle an exit-75 restart doorbell,
and the daemon's headless `anet node start` does not supply the PTY that the
Claude CLI requires. A daemon heartbeat or launcher PID cannot repair either
contract. This change never adds auto-confirm, permission flags or credentials.

## Capability boundary

The Hub rejects `restart_node` for `claude-code` / `claude-code-cli` runtime
rows, and for a node whose latest exact-node/network session reports the legacy
`agent=claude-code` channel. It refuses **before** writing a cu request or
changing lifecycle state. `command_accepted=false`, `request_id=null` and
`legacy_restart_unsupported` mean no restart was dispatched; repeated refusal
creates no orphan command. Scoped `/api/nodes/:id/config` explicitly exposes
`restart_only_supported=false` and masks any conflicting claimed config bit.
This is a negative capability, not a new self-reported positive authorization.

The daemon also refuses legacy create/start requests before provisioning a
local config or spawning a child on the unsafe headless lane. If a request
already exists, it ends with fixed `legacy_execution_unsupported` metadata.
The request's existing identity/network and credential lifecycle rules remain.
Other runtimes retain their existing restart dispatch rules; absence of a
legacy classification does not attest to an arbitrary host's safety.

## Receipt contract

Authenticated `get_start_request`, `get_stop_request` and `get_create_request`
advertise `execution_receipt_capable=1` only on an atomic-feature-capable Hub
adapter. New Linux handlers can add strict `execution_receipt` metadata to the
existing ACK tools. The Hub checks the same daemon binding/network first, then
binds request id, operation, child id and alias to its own request row.
No additional privileges, roles or identity sources are introduced.

| Field | Meaning |
| --- | --- |
| `request_id`, `child_node_id`, `child_alias`, `operation` | Exact authenticated request/child coordinates |
| `session_id` | Selected existing local session coordinate when known; otherwise NULL |
| `observed_at` | Host observation time in milliseconds; not fresh liveness at read time |
| `process.pid`, `start_ticks`, `boot_id` | Observed PID generation, not a PID-only identity claim |
| `process.state` | `present`, `absent` or `unknown`; unreadable/unsupported is unknown |
| `process.executable_sha256` | Executable bytes observed through `/proc/PID/exe` |
| `process_role` | `launcher`, `recorded-child` or `none`; never silently called the CLI |
| `wrapper_sha256`, `tui_sha256` | Selected executable fingerprints if actually known; otherwise NULL |
| `consumer_ready` | Always `unknown` here; no admission/turn-start hook is invented |
| `failure` | Closed enum: legacy unsupported, main process not started, process evidence unavailable, execution failed, execution outcome unknown |

Process observation reads only `/proc/PID/stat`, `/proc/PID/exe` and the kernel
boot id. It checks generation and executable inode/device around hashing;
zombie/dead processes are absent. It does not read cmdline, environ, pane text,
prompt or logs. Wrapper fingerprints use only the already-selected executable.
The helper never opens credentials or copies config/body fields into receipts.
The existing executor's identity/signal guards remain; an executable hash alone
is not authority to signal a process or proof of the complete child tree.

A receipt can label a process `present` only with a live observed PID generation
and matching ACK PID. An unreadable observer retains the existing command ledger
but explicitly reports `process_evidence_unavailable` / `unknown`; it must not
mark a potentially live launch failed/stopped and invite another spawn. An
already-exited launcher is a fixed failure. A recorded PID
still present after stop cannot become a successful stopped receipt. Unknown
stop process evidence remains unknown, even if the command ledger says stopped.
Finite Codex/OpenCode co-presence and adopted launchers keep their existing
separate readiness contracts, rather than reinterpreting their finite launcher
PID using this receipt. Non-Linux/old-Hub combinations omit the new field.

## Hub readback and truth table

The existing scoped human read route accepts:

- `/api/node-lifecycle-requests?kind=start&request_id=str_...`
- `/api/node-lifecycle-requests?kind=stop&request_id=sr_...`
- `/api/node-lifecycle-requests?kind=restart&request_id=cu_...` (restart_only only)
- `/api/node-create-requests?request_id=cr_...` retains its existing route.

Start/stop/restart reads reuse the current live-node visibility join; create
retains its existing network-scoped surface. Restricted readers do not receive
the additional create receipt. No host/config/credential inspection occurs in
these reads. The additive `execution` object separates `command_status`,
`host_receipt`, `process_observation` and `consumer_ready`.

| Observation | Command ledger | Process/runtime conclusion |
| --- | --- | --- |
| Unsupported legacy restart | No cu row | Not dispatched; no child failure/success claim |
| Doorbell accepted/delivered or ordinary ACK | Existing pending/started/etc. | Receipt absent => process and consumer unknown |
| Heartbeat / registration | Existing lifecycle remains compatible | No process/CLI evidence synthesized |
| Receipt of live launcher generation | ACK can close as started | Launcher present at observation time; consumer still unknown |
| Receipt of exited launcher | start_failed / failed | No successful startup claim |
| Normal stop result | Existing stopped ledger | Only the recorded process observation is exposed; complete TUI tree may remain unknown |
| Real task reply | Existing task channel only | No cross-inference from host commands |

Old clients can continue reading their old fields, but do not gain a new
verified-running UI. This draft supplies a structured read surface and docs;
it does not rewrite the Dashboard to display every receipt field.
It has no dependency on channel-delivery PR #2813 and changes none of its
admitted/consumed semantics. Host command receipts never mark task consumption.

## Atomicity, duplicates and crash limits

Receipts use existing `audit_log` rows (`host_execution_receipt_v1`) with a
strict metadata-only shape, no schema migration. For negotiated ACKs, receipt,
request finalization and existing state/credential updates share a transaction.
A late write fault rolls them all back. Existing ACKs without receipts keep
their old contract. Same receipt replay is idempotent; changed receipt for the
same request returns `execution_receipt_conflict`. Scoped pulls can return a
persisted terminal receipt without consuming another create credential blob.

Within one daemon process, duplicate doorbells share one in-flight operation.
A lost ACK replays its frozen payload instead of spawning again. The cache is
bounded to 256 receipts, not a durable command journal. The **Hub claim is
persistent**: the pending→delivered compare-and-set identifies the first pull;
a later pull without a frozen terminal receipt returns an unknown outcome.
New handlers stop before another launch/signal/cleanup. A repeated create pull
does not obtain another credential blob. Persisted receipts can be replayed
without repeating the operation, including an older client's fallback ACK.

A delivered start claim is not superseded by the 60-second stale reaper: elapsed
time is not proof of zero execution. Once an unknown outcome is recorded,
automatic start or same-name create is refused with its original request id.
Expired delivered create claims also block a new identity. An undelivered
request can retain the existing safe retry behavior. Thus cache loss/crash
interleavings halt as unknown rather than manufacture another generation.

This is at-most-one **attempt per observed claim**, not exactly-once execution
or proof of the prior effect. The protected HTTP fixtures model a lost pull and
an executor with no cache; they do not crash/recover a real host. Unknown outcomes
need authorized operator reconciliation. There is intentionally no blind clear,
identity reset, multi-node restart or automatic credential borrowing endpoint.
Old Hubs/handlers do not acquire these guarantees merely by ignoring new fields.

## Reproduce and remaining gates

From a clean checkout, run Docker only:

```sh
sg docker -c 'docker build -f tests/test1493-host-execution/Dockerfile -t anet-1493:review .'
sg docker -c 'docker run --rm --name anet-1493-review --network none --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m --user 10001:10002 --cap-drop ALL --security-opt no-new-privileges --pids-limit 256 --memory 1g --cpus 2 anet-1493:review'
```

`exec` applies only to private tmpfs synthetic executable fixtures. Tests have
no host mounts/network, use isolated SQLite and real loopback MCP/HTTP, and
spawn/kill only their own `/bin/sleep` or `/bin/true` children. No tmux or real
Claude session is involved. Source/command/result details are in
[report-test1493.txt](../tests/report-test1493.txt).

Real host/TUI/wrapper/session evidence is **INCOMPLETE**: NULL fingerprints are
not replaced by package versions or guesses. Actual Claude CLI is unavailable
in the test environment. A safe unattended legacy PTY/wrapper implementation,
operator reconciliation of an ambiguous effect, real-host validation, non-Linux
observers and a complete Dashboard rendering remain unqualified by this draft.
PostgreSQL and the full repository test suite are not qualified by SQLite tests.

## Release, recovery and rollback

Source candidate only: no merge, deployment, daemon restart, node recovery,
registry publication, privilege change or credential operation was performed.
Existing entry points (`agent-network/bin/cli.ts`, `agent-node/src/cli.ts`) and
versioned deployment files under `deploy/` remain the launch authority. No new
service, port, reverse proxy, secret or environment variable is introduced.
Existing secure credential sources remain unchanged and must not be copied
between nodes to make this feature pass.

Any future release must be reviewed/rebuilt from exact main through the normal
release procedure. Rollback uses the existing versioned software path; older
code ignores additive receipt fields/events. Do not delete audit rows, restore
an old identity/token snapshot, or restart a shared daemon as diagnostic rollback.
Request/inbox/audit history comes from the existing protected Hub DB backups;
Git restores software, not those data or credentials. This candidate does not
claim a real host or backup restore was exercised.
