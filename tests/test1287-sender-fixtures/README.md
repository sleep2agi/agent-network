# Original sender fixtures

CommHub #1287 repairs the two sender inputs under #1268. The original
`test8-runtime` and `qa-hub-10-network-scope-regressions` scripts now omit the
human sender nickname and use the Hub's authenticated username. They check
the stored canonical sender, reject forged user/node senders without task
writes, and retain original runtime registration, SSE, A/B network isolation
and broadcast checks. Product permission/identity code is unchanged.

This independent image pins Node22 and Bun1.3.14 by digest, installs source
dependencies from lockfiles, builds the actual Node/CLI bundles and runs both
original scripts. The image's CLI launchers execute those real bundles; they
are not fake executables. Each baseline/negative case uses a fresh container. It restores each original invalid sender in
the positive call and requires the corresponding identity-mismatch failure.
It restores the scripts byte-for-byte afterwards. It does not qualify the
remaining #1268 docs, TTL or cap failures, real models or production nodes.

`qa-hub-10` uses its own disposable `COMMHUB_DB` directory under `/tmp` and
the existing safe-rm guard; it no longer redefines the system HOME variable.
All credentials/configuration are synthetic inside Docker `--network none`.

## Rebuild and recovery

This is a test-only change. Production startup remains repository
`server/package.json` / `server/bin/commhub.ts` / `server/src/index.ts` and
the original deployment launchers. Proxy/tunnel/port mappings, env and secret
sources are unchanged. Original Owner-managed auth/backup keys remain required
for real data; Git and these scripts do not supply them. Reconstruct the fixture
from an exact checkout with locked inputs and the pinned Dockerfile; the runner
asserts that checkout SHA. Roll back software/test changes normally; no schema
or production state migration is introduced. Actual identities, task history
and adopted settings require their original encrypted data backup. Fixture
fresh state is not production recovery evidence.
