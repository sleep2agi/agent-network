# Delegated node permissions (#4616 phase 3)

`permissions` uses existing `node_grants` storage and network / department subtree /
single-node scopes. Only `edit` is accepted. Administrators grant it through the
existing grants endpoint; it does not allow nodes to grant themselves capabilities.

The existing `PUT /api/nodes/:id/permission-mode` and
`PUT /api/nodes/:id/inbox-allowlist` endpoints accept authorized node tokens.
No new MCP tool or runtime config field is introduced. User-token authorization
(node owner, network owner/admin, Hub administrator) is unchanged: humans can
loosen or tighten. All writers update the same current state; last write wins.

Node-token writes require a live scoped `permissions` edit grant. Readonly callers
have edit downgraded to read and cannot write. Self-targeting returns `self`, a
missing/out-of-scope/revoked/read-only grant returns `not_granted`, and a widening
change returns `not_tightening`, all as HTTP 403 with `node_permission_denied`.
Cross-network targets remain hidden as 404. Existing REST allowlists still apply.

Tightening is a pure comparison against the current stored state:

- Modes may stay equal or advance `normal → restricted → readonly` (including skips).
- A nonempty inbox list must be a subset of the old list. NULL is unlimited;
  it can become any nonempty list, but a node cannot clear back to NULL. Empty
  arrays remain invalid (400), not deny-all.
- `!strict` is a control entry disabling implicit human bypass, not a sender.
  Dropping an existing `!strict` is forbidden because it would widen access.

Each successful write emits one existing permission-change audit entry, retaining
from/to plus `actor_node_id`, `via: permissions_grant` and a human-readable
`由 X 节点（授权）修改` label. No additional table or alternate permission overlay exists.

## Isolated verification

```sh
sg docker -c 'docker build -f tests/test4616-permissions/Dockerfile -t anet-test4616-permissions .'
sg docker -c 'docker run --rm --network none anet-test4616-permissions'
```

The runner enables `COMMHUB_NODE_PERMISSIONS=enforce`, checks pure comparisons
before HTTP integration, and prints one observed HTTP response for each of
`not_tightening`, `not_granted`, and `self`. SQLite data lives only inside the
disposable container. No production config, services, secrets or global packages
change. This adds no service, listener or environment variable. Software recovery
uses the normal Hub deployment; existing database backups preserve grants,
permission state and audit history. Reverting software removes delegated writes
while the stored state remains; restoring data requires the normal database backup.
