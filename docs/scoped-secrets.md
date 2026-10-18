# Daemon and node environment secrets — first slice

Requested by admin `idem_9ce674324f3bd2a25e38f9ba0b97e354a63d9fde`.
The client 0.2.248 node/Daemon key forms are demonstrations, not persistence.

## Contract

Wire transport reuses `daemon_provider_snapshot`: actions `secret_list`,
`secret_put`, `secret_delete`, `secret_read`; `provider={node_id?,key?,value?}`
for list/writes, plus the existing top-level revision. Secret work is separate
from Provider work in the existing token-bound pull (`accept_secrets=true`,
`secret_requests`) and acknowledgement (`dsk_` request IDs, names-only snapshot).
No extra tools enter model context; neither scopes nor permissions are merged.

- Human owner/admin selects one registered Daemon and optionally one of its
  authoritative bound nodes. Keys use environment-variable names, not labels.
- Daemon defaults are inherited by its managed children; node keys override
  defaults. Existing explicit process/config and provider credentials retain
  their precedence. A key does not change a Provider/model or authorize OAuth.
- Save/delete requires the latest store revision; values travel only in the
  authenticated private request and local CLI stdin. Names/source only return.
- Hub keeps requests in memory for 120 seconds, not a durable secret archive.
  Hub restart loses pending requests; client must show unconfirmed/timeout,
  never success. Retry is an explicit user action, not an automatic key resend.
- A Daemon receipt confirms local persistence, not a running process update.
  Existing native TUI/server processes require a full node restart by the user;
  no automatic restart, provider switch, production inference or account copy.
- A source marker with no Daemon store means no inherited keys and does not
  require migrating a legacy Daemon just to start an ordinary child. Once the
  store exists, its private permissions and exact parent/node/network identity
  are mandatory; an unsafe or mismatched store is never treated as empty.
- Adopted-node inheritance references the local adoption request; a removed or
  replaced adoption registry entry refuses the old source on the next start.
  Regular newly created children receive their Daemon reference at creation.
  Clone/adoption creation without a saved reference requires setting a key (or
  re-saving Daemon defaults) first; automatic initialization of those paths is
  a later slice, not claimed by this implementation.
- Explicit HTTP remains usable with an HTTPS recommendation. Secret POSTs do
  not follow redirects. Existing human/node token permissions stay unchanged.

## Recovery and release boundary

1. Launch software with the checked-in CLI `anet daemon start <name>` and
   `anet node start <name>`; no private machine launcher is introduced.
2. This adds no ports/proxy/tunnel. Use the existing deployment/network docs.
3. Daemon-owned `scoped-secrets.json` and child `secrets-source.json` are private
   local state (0600 / Windows owner ACL), **not in Git**. Secret values must be
   re-entered from the operator's secret manager, or restored from their
   encrypted data backup. There is no claimed managed backup service here.
   Rebind child references if restore paths change. If a write process crashed
   leaving `.scoped-secrets.lock`, an operator must confirm no secret command is
   running before removing that one lock; never bulk-delete private state.
4. Upgrade Hub/CLI/runtime/client together from a main-SHA formal release.
   Verify names-only Daemon receipt, then restart the selected node and verify
   the application's actual usage separately; saving alone is not usage proof.
5. Retain the previous private install and encrypted state backup for rollback.
   Old software ignores the new scoped store; re-enter keys via its supported
   configuration rather than assuming new store compatibility.
6. Git recovers software/protocol/tests, not secret values, OAuth sessions,
   production DB contents or pending in-memory requests. An empty-machine
   recovery must restore/register identities and re-enter/restore private data.

Tests use only synthetic credentials in isolated Docker. Non-main artifacts
are TEST-ONLY. No production changes are part of this request.

## Independent nodes (#1075)

Node Hub identity tokens are independent of a Daemon. The original `secret_*`
lane above still manages Daemon defaults and bound-child overrides unchanged.
For an unbound node, the client sends `node_secret_list`, `node_secret_put` or
`node_secret_delete` through the same management tool, with `id` equal to the
selected node ID. `secret_read` observes its `nsk_` receipt. Human owner/admin
authorization remains required; runtime callers cannot submit human writes.

The target advertises `config_snapshot.node_secrets_capable` only when it has
a durable config directory, node ID and network ID. An older Hub/runtime or
incomplete durable identity is unsupported, not a requirement to bind a Daemon.
The existing token-bound pull/ack transport opts into `accept_node_secrets`;
only the selected node can pull/ack that request. SSE `node_secrets` and reconnect
catch-up trigger the private management handler, not model tasks or ordinary
message injection. Secret values remain in the short-lived management request;
names/revision/source only appear in receipts. This is not Hub token rotation.

`<node directory>/node-secrets.json` stores the identity-bound revision and
values using the existing private atomic writer. `readScopedNodeEnv` in the CLI
and runtime consumes it on a full start without a Daemon source marker. It
overrides inherited defaults, but existing explicit process/config/Provider
credentials retain their precedence. The initial client uses this lane for
unbound nodes only; bound-node and Daemon pages keep their previous transport.
Saving never restarts a native TUI/server or changes account/model/Provider.

Recovery uses the same checked-in `anet node start` launcher, ports and Hub
configuration as ordinary nodes; no new listener, proxy or tunnel is added.
Upgrade the Hub, CLI/runtime and client from verified exact-main releases,
then check the names-only node receipt and the selected node's actual usage.
No new release version is declared available by this source-only change.
Keep old installations and encrypted state backups for rollback; older software
does not consume the new file. Values must come from the operator's secret
manager or encrypted data backup, not Git. Preserve existing `secrets.env`,
config and Daemon inheritance markers; this change does not migrate or delete
them. A stale `.node-secrets.lock` may be removed only after confirming no writer
is running. Repository clone restores software, not secrets, OAuth sessions,
production databases or pending in-memory requests.

The bounded Actions Docker fixture is `tests/test1075-node-secrets`: real Hub
handlers, the node-local writer, modification/deletion and actual runtime startup
child consumption with synthetic credentials and no Daemon binding. Client
protocol/typecheck and exported unbound-node UI use its existing Docker suite.
Source/CI acceptance is distinct from formal package release and installation.
