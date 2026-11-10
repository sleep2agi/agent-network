# CommHub v0.9.0-preview.118

Release preparation, not evidence of publication or production deployment.
Hub #818 is the release slice of P0 #815; authoritative Issue #2533.

## Included change

Compared with .117 main commit `67c92ddbb801eb488f22bd4f432f07b0725ec896`,
the only server change is #2534, merged as
`e9d148b11025cfb01d634cecc4aaa6298dad71c7`:

- Node MCP `schedule_batch_interval` accepts 1–100 explicit schedule IDs and
  one `every_seconds` interval. Duplicate IDs are processed once.
- It returns per-ID success or failure, allowing partial success. Invalid
  interval input is rejected before any write. This is not a transaction over
  the entire batch.
- Existing ownership rules remain: nodes may edit only schedules they created,
  not human-created schedules merely targeting them. Only interval schedules
  are eligible; cron and one-shot schedules are rejected.
- The existing single-update path retains revision checks and paused status.
  Identical intervals do not move the next run; already queued tasks remain.

No database migration, client/runtime upgrade, daemon change, new background
job or permission expansion is included. Existing interfaces are unchanged.
The .116 scoped-access default and old-token compatibility are retained.

## Validation

Feature PR #2534 passed all 157 CI checks and the standalone merge gate.
Focused Docker results are in `report-test816-schedule-batch-interval.txt`.
The .117 baseline API/upgrade/rollback release replay is recorded separately
in `report-test818-hub118-compat.txt`; version PR and formal release gates
remain required. No production schedule is modified by the release tests.

## Install

After publication, install the exact package in the intended environment:
`npm install -g @sleep2agi/commhub-server@0.9.0-preview.118`.
For tests, use a disposable Docker container, not a shared host global install.

## Upgrade

Use the existing deployment runbook and launcher: back up the database,
install the exact package into the replacement runtime, switch that runtime,
then verify its version, health and authenticated tool availability. Installing
the package alone does not upgrade a running Hub. This release changes no
launcher, port, reverse proxy, tunnel, environment variable or secret source.
Production data must still be recovered from existing database backups, not npm.

Rollback to .117 removes the batch tool; no schema reversal is necessary.
Interval edits already made remain data changes and are not undone by software
rollback. Do not cross the existing token-issuance security boundary or use
incompatible issuers against one database.

## Publication

After merge, dispatch `release.yml` from `main` with package `commhub-server`,
version `0.9.0-preview.118`, publish=true and the verified full 40-character main
SHA. Wait for the previous release run to finish before dispatch. Publish only
preview; do not move latest. Verify registry metadata, tarball integrity and
the actual installed package before completing #818. Registry delay is not a
reason to republish. No production upgrade is authorized by these test results.
