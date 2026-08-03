# RFC-031 — Server daemon node control closure

Status: implementation candidate

## Outcome

One `host_supervisor` daemon represents one project root on one server. An
admin can use the same contract from the CLI, Dashboard, or Capacitor app to:

- list the nodes physically present under that daemon's `.anet/nodes` root;
- create a node;
- edit the allowed runtime config fields while the node is online or stopped;
- start, restart, stop, and delete a daemon-owned node;
- observe request progress and the final daemon acknowledgement.

Existing `/api/nodes`, `update_node_config`, `restart_node`, `stop_node`, and
`delete_node` response contracts remain compatible.

## Why the current implementation is incomplete

`node_create_requests` records only nodes created through `create_node`.
Therefore an existing local node has no durable daemon ownership. In addition,
`restart_node` and `update_node_config` send an SSE event to the child itself.
A stopped child has no SSE connection and can neither start nor edit itself.

## Data model

Two additive tables are used. No existing row is rewritten during migration.

### `daemon_node_inventory`

The daemon reports a secret-free snapshot after registration and periodically.
The key is `(network_id, daemon_node_id, local_node_id)` and the row contains
only alias, canonical runtime, relative config path, observed process state,
PID when verified, config revision/hash, and timestamps.

The daemon may report only descendants of its fixed project
`<work_root>/.anet/nodes` directory. It skips symlinks, its own profile,
unreadable/invalid JSON, and configs whose `node_id`, alias, network, or hub do
not match the authenticated daemon's network and configured Hub. Tokens,
environment values, prompts, provider secrets, and absolute paths never cross
the wire.

The Hub accepts a row only from a token-bound `host_supervisor`. If a matching
Hub `nodes` row exists, `node_id + alias + network` must all agree. A conflict is
reported and quarantined; it is never auto-rebound or auto-fixed.

### `daemon_node_actions`

An admin/member action is a durable envelope bound to one inventory row. The
supported actions are `start`, `restart`, and `update`. Stop/delete retain the
RFC-027 request table but resolve ownership through inventory first, with the
legacy create-request lookup as fallback.

Every action has one terminal acknowledgement (`succeeded`, `rejected`, or
`failed`). Only the bound daemon token can pull or acknowledge it. One
non-terminal action per local node is enforced by a partial unique index.

## Execution rules

1. The Hub resolves caller network and role on every dispatch. Create and
   security-sensitive edits require admin/owner; ordinary lifecycle operations
   retain existing member+ semantics.
2. The Hub resolves the daemon inventory row in that same network and emits a
   doorbell containing only `action_id`.
3. The daemon pulls the envelope using its node token and revalidates the local
   config path, real path, node ID, alias, network, runtime, and patch.
4. Config writes use mode-0600 temporary file + fsync + atomic rename, with a
   mode-0600 `.prev` backup. Only RFC-024 fields are mutable.
5. Start uses the pinned, verified `anet` binary and a minimal environment.
   Restart/stop signal only a process whose `/proc/<pid>/cmdline` exactly
   matches the inventory alias/config. No `pkill`, `killall`, shell command, or
   substring match is allowed.
6. The daemon acknowledges the outcome. The Hub advances inventory and node
   lifecycle state only after the acknowledgement.

## Compatibility and rollout

- Old daemons ignore the new doorbell and keep all current behavior.
- New daemons keep accepting the RFC-026/027 request types.
- `/api/nodes` shape and row count do not change.
- New REST resources live under `/api/host-supervisors/:daemon/nodes` and
  `/api/host-actions/:id`; the Dashboard proxy exposes the same operations.
- The server is deployed first, then daemon/CLI, then Dashboard/App. Any older
  layer sees an explicit capability-unavailable state, never a false success.

## Acceptance gates

Docker tests run in layers: schema/compatibility, auth/network isolation,
inventory sync, one lifecycle action, full create-edit-stop-start flow,
concurrency/reconnect, and security mutation. The final host test uses a new
daemon and a dedicated acceptance node. Existing profiles and processes remain
untouched.
