# Hub 0.9.0-preview.129 — authenticated inbox recipients

Release preparation. Publication and production activation are recorded after
the exact-main gates and public-package verification complete.

Includes PR2664 recipient checks for inbox reads and acknowledgements. Nodes
use their token-resolved identity; people use their own inbox, owned nodes or
recipients they administer. Multi-network human calls select network_id when
acting for another recipient. Includes the already-merged PR2662 heartbeat
schema correction for independent node-key capabilities.

## Install

After publication:

```sh
bun add --global @sleep2agi/commhub-server@0.9.0-preview.129
```

## Upgrade

Existing managed Hub deployments use the versioned sibling install, consistent
SQLite backup and rollback procedure in deploy/hub/README.md. Preserve the old
runtime and the original vault-key source. Only restart the selected Hub after
the Git deployment profile and verified package lock are ready; keep its PM2,
Bun, database, port and proxy configuration. The preview channel is used.

No schema or dependency changes from Hub128. Software rollback selects the
preserved Hub128 runtime; database contents, vault keys and accounts come from
their existing backups or authentication, not from Git. Runtime/CLI and
business-node upgrades are separate. Package publication does not prove actual
node-key operations, model access or production message consumption.

Source evidence: docs/tests/report-test688-inbox-recipient.txt and
docs/tests/report-test1075-node-secret-capability-wire.txt. Core source checks
passed in Docker; the formal release workflow rebuilds from merged main.
