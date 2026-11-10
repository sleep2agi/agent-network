# CommHub 0.9.0-preview.121

Release candidate for Hub #906; not published or deployed yet.

## Included changes

Daemon-scoped Provider read/write and one-node application request transport,
with ownership, capability, revision and request-specific receipt checks. Old
daemon versions cannot silently accept the new operations. Existing token
authentication remains compatible. This is not Hub-level Provider management.

## Install

After publication: `npm install -g @sleep2agi/commhub-server@0.9.0-preview.121`.

## Upgrade

Back up the Hub database using the existing deployment procedure, activate the
exact package and verify its running version and authenticated Provider API.
Then install runtime 2.5.0-preview.129 / CLI 2.3.0-preview.163 and the compatible
client. Package publication alone does not update a running Hub or daemon.
Schema additions are handled by the repository's database initialization code.

## Rollback and recovery

Reconcile pending Provider writes/applications before restoring Hub .120 and
the previous matched CLI/runtime. Keep request history and additive schema;
software rollback does not reverse private node changes. Restore Hub data only
from the existing encrypted database backups. Private daemon Provider files and
node journals have their separate backup/recovery procedure.
See [Hub deployment](../../deploy/hub/README.md) for the startup authority,
activation and rollback, and [#906](../design/906-daemon-provider-management.md)
for private state and secret sources. No new service, port, proxy or tunnel is
introduced; clone alone does not recover production data.

## Evidence and publication

Hub transport checks and the native Linux single-node source chain passed as
recorded in [the #906 report](report-test906-daemon-provider-management.txt).
This is not native desktop package acceptance or a production recovery drill.
Publish a fresh full40 main-SHA build before its runtime/CLI pair; keep latest
unchanged. The client sidecar lock must reference the published package and its
actual registry integrity, never a fabricated hash or a branch artifact.
