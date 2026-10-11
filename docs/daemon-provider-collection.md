# Existing Provider collection — implementation slice, not yet published

`anet daemon provider collect <daemon> --revision N` reads a JSON selection
from stdin: `node_id`, `alias`, `node_revision`, `provider_id`, `auth_id`, `label`.
The revision comes from the existing Codex scan. The command resolves the
source from local registered identity, not a caller-supplied filesystem path.
It saves the configured API-key endpoint/model into the selected daemon's
private store and returns the normal redacted Provider snapshot. It does not
restart the source, copy auth.json, call a model, or establish model entitlement.

This slice covers Codex TUI (`codex-app-server`) with a private node-owned home,
Responses-compatible configured provider and a key in the source's private
config/env file. Missing local keys never fall back to the caller's environment.
ChatGPT logins require the existing managed account authorization flow, not
cloning another node's refresh-token chain. External/shared homes and profile
overrides are not silently converted. Existing managed profiles are preserved;
collecting into an occupied authentication ID is refused. Optional request IDs
make a lost acknowledgement replay idempotent.

The local CLI and remote Hub/daemon transport are implemented in test branches.
The client collect button and creation using the daemon catalog remain to be
wired; do not advertise this as a completed client feature or in public165.

## Remote collection contract

A network owner/admin explicitly calls `daemon_provider_snapshot` with
`action: collect`, `id: daemon_node_id`, `network_id`, `revision`, and the
identifier-only selection in `provider`. There is no remote key or path input.
Hub validates source identity/alias binding at enqueue, pull and receipt.
The existing short-lived encrypted write queue is reused (no schema migration).
An older daemon advertising only `accept_writes` never consumes collection.
The new daemon advertises `accept_collections` only over HTTPS or loopback HTTP,
then invokes its pinned CLI `collect` with the selection on stdin.

Source revision CAS and the daemon store revision are checked locally; a lost
ACK reuses the same durable request instead of incrementing twice. A successful
public receipt confirms an API-key profile with its configured model, not
actual model access or an applied configuration. Source ownership changes
before execution refuse the queued work. Failed/expired work clears queue data.
Readback remains the existing `action: read` request-ID protocol. This change
does not collect ChatGPT accounts, restart a node, or silently adopt an identity.

## Operations and recovery

No new resident service or port is added. Daemon startup, CLI/runtime private
pair installation, verification and rollback remain under the checked-in
`deploy/daemon/` authority and `docs-site/docs/deploy/daemon.md`.
Source secrets come only from that source's owner-only config.json/.env; no
secret value belongs in Git, command arguments, logs or scan receipts.

The result lives in the target daemon's `provider-store/state.json` (schema1).
Verify by `provider list` and the resulting revision; configured is not applied.
Version changes use an exact main-built package pair, never this branch build.
Rollback the private software pair using the existing deployment procedure;
collection leaves source configuration/session untouched. If restoration of
the catalog is needed, restore its owner-only state file from an encrypted,
identity-matched data backup. Repository clone restores code, not credentials
or source/daemon data. No new backup facility or disaster-recovery exercise is
claimed by this change.
