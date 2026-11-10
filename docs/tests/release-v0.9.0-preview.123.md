# CommHub 0.9.0-preview.123

Candidate: negotiated read-only Codex discovery and old-client default projection.
Not published or deployed yet. No database migration or new persistent service.

## Install

After publication: `npm install -g @sleep2agi/commhub-server@0.9.0-preview.123`.
Use the existing [Hub launcher](../../deploy/hub/README.md).

## Upgrade

Back up the Hub database and retain the previous private runtime. Activate this
exact formal package and verify running version plus authenticated readback.
Then upgrade selected Daemons to CLI .165/runtime .131; no business-node restart.
Old Daemons are not sent discovery work; old clients receive the old projection.

## Rollback and recovery

Use the existing Hub deployment guide for startup, reverse proxy/ports, secrets,
activation and rollback. Software rollback does not undo private account custody
or database content. Keep secure backups and existing pending-operation journals.
No new ports or secret sources; Git alone does not recover production data.

## Evidence and publication

[Core report](report-test906-existing-codex-discovery.txt): 1/1 selected real HTTP
authentication/Hub/Daemon/CLI test; unrelated tests not rerun. Formal publication
requires an exact full40 main SHA via release.yml and verified downloadable bytes.
Keep latest unchanged; this candidate is not publication evidence.
