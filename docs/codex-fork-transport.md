# Confirmed Codex fork transport — internal candidate (#822)

This is source work for core Issue #2539, not a deployment or release. The daemon
receiver and Hub storage/read path exist in this candidate; daemon capability
advertisement and the final compatible CLI integration gate are still pending.
Do not enable a capability by editing a production snapshot to bypass the gate.

## Contract

`start_node` keeps its existing caller/network/child permissions. Optional
`fork_recovery: {kind: "fork_on_missing_ordinal", confirmed: true}` records
confirmation for that request, alongside `created_by_token` and the existing
dispatch audit actor. It does not change token permissions. Never default a UI
checkbox to confirmation, or send the new field to an old Hub that will strip it.
Clients must negotiate the new tool schema before offering this action.

Dispatch requires a created (not adopted) binding and the daemon's affirmative
`daemon_capabilities.codex_fork_recovery: {protocol: 1, cli_supported: true}`.
This snapshot is advisory: the daemon rechecks the actual pinned CLI before use.
`get_start_request` additionally requires `fork_recovery_capable: true` for a
recovery request. Without it the old daemon receives a rejection, not an ordinary
start envelope. Ordinary starts and old NULL database rows retain their behavior.

The daemon checks the authenticated confirmation and request ID, its private child
identity, and local Codex app-server co-presence configuration. It probes the
pinned CLI help with a bounded, shell-free call, then passes explicit argv:
`node start <verified-dir> --fork-on-resume-failure --yes --fork-recovery-request-id <str_id>`.
The CLI retains responsibility for classifying the missing-ordinal error and
performing its existing snapshot/fork workflow. No new generic error auto-forking.

`ack_start_request` stores launcher status independently from `fork_recovery`:
`forked` contains only validated old/new thread UUIDs; `not_observed` means no
matching record was seen, not proof that no fork happened; `unknown` carries a
bounded reason. A fork followed by failed startup remains a recorded fork.
Missing terminal evidence is unknown, never success fiction. Same-daemon replay
retains the original receipt; this is not durable exactly-once across restarts.

Human readers use the existing authenticated `/api/node-lifecycle-requests`
endpoint with `kind=start` and an exact `request_id`. It applies current node
visibility/grants and returns optional `fork_recovery: {requested: true, result}`.
No raw JSON, snapshot/rollout path, PID or token is added to the response.

Stale confirmed recovery is not automatically superseded by the ordinary start
reaper: it returns `codex_fork_outcome_unknown` with the original request ID.
Reconcile that original launcher/history before further action; do not blindly
create another recovery, delete the request, or infer a stopped process from a
missing heartbeat. Automated cross-restart reconciliation is not in this slice.

## Upgrade, recovery and rollback boundaries

- Existing service launchers, ports, reverse proxies/tunnels and secret sources
  are unchanged. This patch adds no service, environment variable or credential.
- `server/src/db.ts` adds nullable TEXT columns `fork_recovery_json` and
  `fork_result_json` to `node_start_requests`; repeated startup is idempotent.
  The candidate's Docker migration test exercises an old SQLite table twice.
  PostgreSQL migration execution is not validated by that test.
- Deploy only after merge and the existing exact-main-SHA release gate. Upgrade
  Hub before enabling the new daemon/CLI capability. Verify the real daemon's
  reported capability and one isolated request/receipt; an online node or package
  version alone is insufficient. No production deployment was performed here.
- Back up the database using the deployment's established encrypted backup
  process before upgrade. Request confirmations/results require that database;
  per-node CLI fork history and original/snapshot rollouts require their existing
  node-data backups. Git restores code and schema, not any of those records or
  credentials. This change creates no backup destination or secret store.
- Before rollback, stop accepting recovery requests and reconcile/drain all
  pending/delivered rows with `fork_recovery_json IS NOT NULL`. **Do not downgrade
  Hub with such requests outstanding**: an old Hub would omit the recovery field
  during pull and allow an ordinary launch. Retain the extra nullable columns and
  history on rollback; do not drop them or restore an old database over newer
  fork evidence. Software rollback cannot undo a fork.
- This focused storage exercise is not a full empty-server rebuild drill. It
  does not establish that any production backup, launcher or tunnel is recoverable.

Evidence: `docs/tests/report-test822-fork-transport.txt` and the existing Docker
runner `tests/test819-codex-start-completion/run.sh`.
