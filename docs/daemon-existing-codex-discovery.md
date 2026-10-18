# Existing Codex discovery (#906)

The Provider page separates Hub-bound nodes (existing control authority) from
locally discovered, unbound Codex nodes. Discovery is read-only: it does not
adopt a node, import credentials, change permissions or restart a process.

The Daemon CLI scans its own workspace nodes and the local `child-workdirs.json`
registry, not arbitrary remote paths or all machine directories. It reads only
same-network Codex configs and emits model/provider identifiers, authentication
kind and an opaque home/account reference. Credential contents and filesystem
paths are never returned. File presence is not a successful login or inference.
The Hub filters discovery against registered identities in the current network
and excludes nodes controlled by any Daemon. Unbound rows have a null mutation
revision and never enter the client's provider-switch choices.

Legacy group-writable directories can be read only when their same-owner,
non-symlink ancestor is private (0700). Credential files still require private
permissions and no symlinks/hardlinks. The application resolver keeps its
original strict checks; successful discovery does not grant mutation authority.
If a directory cannot be inspected or a scan limit is reached, the result says
unavailable/limit rather than returning a misleading empty successful scan.

## Compatible rollout

1. Upgrade the Hub first. `pull_daemon_provider_snapshots` adds discovery work
   only when the Daemon advertises `accept_local_discovery=true`.
2. Upgrade the CLI/runtime together from an exact, merged main release. Runtime
   passes `--discover-local` only for negotiated discovery work. Old Daemons
   continue sending the existing bound-only contract.
3. The new client requests `include_discovery=true` on read. The default Hub
   projection removes the additive field, so existing strict clients keep
   working. Old readbacks remain usable and are labelled as not providing local
   discovery, not as an empty local scan.

No new ports, proxies, database migration or secret source is required.
Start/upgrade/verify/rollback selected Daemons via the existing documented CLI
lifecycle and private package-pair deployment descriptor. Verify actual package
paths and original-identity heartbeat before checking the readback; rollback
keeps the original node config and previous private pair. Configs, registry and
Codex sessions/authentication remain operator-managed data requiring secure
backups; cloning Git restores the software and flow, not those contents.

Core reproduction is `Dockerfile.discovery` under
`tests/test906-daemon-provider-management/`. It builds the real CLI and runtime
handler and exercises authenticated human HTTP → Hub → Daemon → CLI → receipt
with synthetic private files, plus old projection and unbound application refusal.
No production state or credentials are mounted. This document is not evidence
of a complete empty-host disaster-recovery rehearsal or a formal release.
