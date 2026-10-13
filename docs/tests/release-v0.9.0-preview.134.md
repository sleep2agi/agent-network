# CommHub Server 0.9.0-preview.134

Scheduled execution time starts at attributable consumption, falls back to the legacy execution start, and otherwise uses dispatch creation. Queued time no longer reduces the execution budget. Submission, inbox ACK and node heartbeat do not renew it. The existing interval-based timeout and 24-hour total cap remain bounded. Expired history and late-reply rules stay intact. Continuous task activity renewal is the next phase of #1105, not delivered by this slice (#1112).

## Install

```sh
npm install @sleep2agi/commhub-server@0.9.0-preview.134
```

## Upgrade

Upgrade an isolated managed prefix using the same command, retain the previous prefix for rollback, then run the existing Hub deployment procedure with a consistent database backup and offline preflight. A public package alone does not establish that a live Hub was upgraded. The authoritative service launcher, environment source, backup and rollback procedure are in `deploy/hub/README.md`; external key recovery remains NOT_COVERED.

Validation: the dedicated Docker suite runs real scheduled dispatch, expiry history and UTC-clock contracts on SQLite and PostgreSQL, retaining the existing SQLite-only terminal suite, plus assertion witnesses for creation-based truncation and missing total cap. No new schema, runtime protocol or settings are introduced.
