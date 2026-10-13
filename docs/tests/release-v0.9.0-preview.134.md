# CommHub Server 0.9.0-preview.134

Scheduled execution time starts at attributable consumption, falls back to the legacy execution start, and otherwise uses dispatch creation. Queued time no longer reduces the execution budget. Submission, inbox ACK and node heartbeat do not renew it. The existing interval-based timeout and 24-hour total cap remain bounded. Expired history and late-reply rules stay intact. Continuous task activity renewal is the next phase of #1105, not delivered by this slice (#1112).

## Install

```sh
npm install @sleep2agi/commhub-server@0.9.0-preview.134
```

## Upgrade

Upgrade an isolated managed prefix using the same command, retain the previous prefix for rollback, then run the existing Hub deployment procedure with a consistent database backup and offline preflight. A public package alone does not establish that a live Hub was upgraded. The authoritative service launcher, environment source, backup and rollback procedure are in `deploy/hub/README.md`; external key recovery remains NOT_COVERED.

Validation: the dedicated Docker suite runs real scheduled dispatch, expiry history and UTC-clock contracts on SQLite and PostgreSQL, retaining the existing SQLite-only terminal suite, plus assertion witnesses for creation-based truncation and missing total cap. No new schema, runtime protocol or settings are introduced.

Formal release `38342053049` from exact main `c641a82626d16c1ad627fb977011f14835ec9b2c` passed all four gates and publication/registry verification. Public SHA256 `14cd606f422f098b97d4003f51d53803231b90bf83c693d67323aa966fc1d61f`. Deployment main `875137cbe333fd83da97a8f008d1c84186ad8c26` selected v117, confirmed secured134 at `2026-10-13T03:36:09.412881+00:00`. See `report-test1112-hub134-activation.txt` for bounded traffic, snapshot and rollback evidence. Parent #1105 remains open for continuous task activity renewal.
