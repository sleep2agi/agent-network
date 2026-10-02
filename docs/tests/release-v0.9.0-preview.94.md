# CommHub v0.9.0-preview.94

This release carries the Hub changes merged since `0.9.0-preview.93`. Production is on `0.9.0-preview.93`. It is built from main at 66dcb2ac.

- #2289 (e961ce74) **Task due reminders (#491/#492) and due filters (#494).** An in-process check (every 10 minutes) reminds a card's human owner and human participants when it is due soon, due today, or overdue (at most once a day, stopping after 7 days); the agent owner gets a message only with `COMMHUB_DUE_REMINDER_NODES=1`. Calendar days use Asia/Shanghai (`COMMHUB_DUE_REMINDER_TZ`). Rollout guards: `COMMHUB_DUE_REMINDERS=0` turns the check off; `COMMHUB_DUE_REMINDER_NETWORKS=<id,…>` limits it to listed networks (unset = all); cards that were already overdue when a network is first covered never get overdue reminders. `requirements_list` (MCP) and the REST list accept `overdue` and `due_within_days`.
- #2288 (649b7d31) **`group_membership_changed` event (#457, RFC-042 §9.3).** Sent to the person added or removed and to current group members only after the membership change commits; nothing on rollback.
- #2074 (1c0e0010) **claude-code channel nodes report `node_id`**, so they get a nodes row and can be picked for schedules and targeted.
- #2060 (66dcb2ac) agent-node side only (daemon rejects non-ASCII workdirs); no Hub change.
- Tests/docs only: #2285 (PG ladder derives its databases from `run_pg_tests_rc` lines), #2266 (RFC-041 accepted).

Migration: additive only — new table `requirement_due_reminders` and a partial index for cards with a due date. No existing column changes.

Checked in Docker with `tests/hub-release-compat`, candidate 66dcb2acc78caf228523296870aabf19ae65793e, baseline `0.9.0-preview.93` from npm, apps 0.2.166 / 0.2.181 / 0.2.197, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, unexpected=0, check_failures=0 each. MCP `tools/list`: 74 → 74 tools, additive new params `requirements_list` + `[overdue, due_within_days]`.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.
- A copy of a real database (29 users) upgraded to the candidate, rolled back to `.93` and re-upgraded; every start answered `/health`; `integrity_check` ok. Due reminders on that copy: `COMMHUB_DUE_REMINDERS=0` → 0 reminder rows after 4 ticks; allowlist set to a network with no cards → 0 rows; positive control (allowlist = a real network) → 1 `due_today` reminder, 0 node messages.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.94`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.94
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.94
```

The new table is created on first start. Due reminders are on by default for every network; set `COMMHUB_DUE_REMINDERS=0` (or `COMMHUB_DUE_REMINDER_NETWORKS`) before starting if you want to roll them out gradually. Existing apps keep working: older apps ignore the new event and the new list filters.

## Rolling back

`0.9.0-preview.93` starts on a database that `.94` has run on: it ignores `requirement_due_reminders`. Reminders stop while rolled back; already-sent reminders are not repeated after re-upgrade.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
