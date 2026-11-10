# CommHub v0.9.0-preview.116

Release preparation only; this document is not proof of npm publication or
production deployment. Preview channel only; do not move `latest`.

## Included Hub changes

Compared with `.115` release commit `3abf8f1f8af91725da6f14ded3aedbc6f7ba95ff`:

| Commit | PR | User-visible change |
|---|---|---|
| `ccab0d0a` | #2519 | Independent Agent team hierarchy, membership and scoped management APIs; separate from human departments |
| `a9cd6ed2` | #2512 | Offline scheduled targets skip the round with `target_offline`; warn the creator once per offline episode; resume dispatch when online |
| `c1900537` | #2515 | Newly added network members default to related-only task visibility |
| `e3c8a5d1` | #2510 | Suspected orphan tasks generate an event and notify the sender; task status is not rewritten |

The human-department node assignment in #2508 was reverted by #2518 before
this release. It is not a feature of `.116`. CLI and agent-node changes in the
same repository are not released by this Hub-only version change.

## Data and compatibility

- Additive team tables: `network_agent_teams`, `network_agent_team_members`.
- Additive scheduler column: `offline_alert_at`.
- No new required client request fields. Existing membership defaults are not
  claimed to change retroactively; the new-member policy is intentional.
- Isolated rollback/re-upgrade replay against npm `.115` passed with the
  seeded database. This does not replace backing up production data.
- Token issuance protections remain in effect. Do not mix historical Hub
  issuers against one database or roll back across the security boundary.

## Release gate

Release preparation: package version and lockfile, this note, and the replay's
explicit new-member-policy expectation. No product implementation changes.
Existing product tests are owned by the merged feature PRs; avoid another
redundant local full suite. The isolated `.115` / `.116` replay with App
`desktop-v0.2.224` passed. PR CI and `assert-pr-mergeable` must still pass.

After merge, dispatch `release.yml` with package `commhub-server`, version
`0.9.0-preview.116`, `publish=true` and the exact 40-character main commit.
Verify the workflow's actual package input choice before dispatch. Only one
release workflow should run at a time; registry propagation is not a reason to
reuse or skip a version number. Recheck the package in isolated Docker after
publication. This task does not upgrade production, change port mappings,
alter credentials or modify live data. Production data remains in its existing
backup system; the package is not a data backup.

## Install

After npm publication, install into the intended isolated environment:
`npm install -g @sleep2agi/commhub-server@0.9.0-preview.116`.
Do not run this on a shared development host as part of testing.

## Upgrade

Back up the database using the deployment runbook, install the exact version
above in the replacement environment, then verify the running version and
health. Installing a package alone does not replace an existing Hub process.
Production upgrade is a separate operation and is not performed by this PR.

## Validation status

Docker offline version metadata check: 3/3, rc=0 (package and both lockfile
version entries). Compatibility: A1/A2 each 62 steps, zero unexpected changes
and zero check failures; upgrade/rollback/re-upgrade B zero failures, rc=0.
See `report-hub116-compat.txt` for the initial stale-expectation failures and
the explicit release parameters. PR CI remains pending; no npm publication
or production upgrade is claimed.
