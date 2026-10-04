# CommHub v0.9.0-preview.101

This release carries the Hub changes merged since `0.9.0-preview.100`. Production is on `0.9.0-preview.100`. It is built from main at 42fb1e4b plus this version bump.

Hub (`server/`) changes since `.100` (the `.100` bump was #2343), oldest first:

- #2345 (c7f9013b) **The creator of a schedule is told when it keeps failing (#523).**
  - `consecutive_failures` = failed runs since the schedule's last successful run. Skipped, cancelled, expired and still-open runs neither count nor break the streak.
  - When the streak reaches N (default 5), the creator gets **one** notice (`user_inbox` kind `schedule_failing`, the same path as the #462/#464 notices). It names the schedule, the target node, the count, the latest error, and how to pause it.
  - Dedup is a conditional write on two new columns. It fires again only after a success re-arms it, or after 24 h with no success. A Hub restart does not resend it.
  - The check runs only when a run ends `failed` (failed at dispatch, or its task ended `failed`). There is no boot-time or periodic sweep, so old failures in the database do not produce notices on upgrade.
  - Optional auto-pause, **off by default**.
  - `GET /api/scheduled-tasks/:id/runs` gains `consecutive_failures`, `failure_alert_threshold` and `last_failure_alert_at`. A failed task's reply text is now returned as the run's `error_message` when the run has none.
- #2346 (5c747ae9) **Due reminders can be turned on per network (#524).**
  - `COMMHUB_DUE_REMINDERS_NETWORKS=<id,…>` turns reminders on for the listed networks only. This also works while `COMMHUB_DUE_REMINDERS=0`.
  - `COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS=<id,…>` leaves networks out while reminders are on.
  - With neither variable set, behaviour is exactly as in `.100`. The Hub now logs the effective scope once at start, for example `[due-reminders] scope: off`.
- Not Hub: #2344 (anet node delete) and #2342 (agent-node watchdog) are released with their own packages.

## Schema change: two nullable columns

At boot, `ALTER TABLE scheduled_tasks ADD COLUMN failure_alert_at TEXT` and `… ADD COLUMN failure_alert_key TEXT` run once. Both columns are nullable with no default, so existing rows are not rewritten. There are no new tables or indexes.

## New environment variables (defaults)

| variable | default | effect |
|---|---|---|
| `COMMHUB_SCHEDULE_FAILURE_NOTICE_RUNS` | `5` | streak length that triggers the notice |
| `COMMHUB_SCHEDULE_FAILURE_RENOTICE_SEC` | `86400` | re-notify after this long with no success |
| `COMMHUB_SCHEDULE_FAILURE_AUTO_PAUSE_RUNS` | `0` (off) | pause the schedule at this streak length |
| `COMMHUB_DUE_REMINDERS_NETWORKS` | unset | due-reminder allowlist |
| `COMMHUB_DUE_REMINDERS_EXCLUDE_NETWORKS` | unset | due-reminder blocklist |

The defaults of all existing settings are unchanged. `COMMHUB_DUE_REMINDERS=0` still turns due reminders off when no allowlist is set. The one new behaviour that is on by default is the failing-schedule notice. It reaches only the schedule's creator, and only after a new failure.

## Checked

- **`tests/hub-release-compat`:**
  - Setup: candidate 42fb1e4b (same `server/` tree as this bump apart from the version), baseline `0.9.0-preview.100` from npm, apps desktop-v0.2.200 / desktop-v0.2.201 / desktop-v0.2.202 (the newest app tag), `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0 OLD_LABEL=.100 NEW_LABEL=.101`.
  - A1 and A2: steps=62, unexpected=0, check_failures=0.
  - B upgrade → rollback → re-upgrade: upgrade_check_failures=0.
- **Upgrade and rollback drill on a read-only `VACUUM INTO` copy of the production database.**
  - Setup: throwaway HOME, random port, the production flags `COMMHUB_DUE_REMINDERS=0 COMMHUB_SESSION_IDLE_DAYS=0`, and no allowlist.
  - The sequence was `.100` → candidate → `.100` → candidate. Each phase ran 150 full `/api/status` reads, each one right after a `POST /api/task`.

  | phase | new columns | full `/api/status` p50 / p90 after a write | task writes |
  |---|---|---|---|
  | `.100` | no | 11.2 / 13.6 ms | 150/150 |
  | candidate | added at boot | 9.5 / 13.1 ms | 150/150 |
  | `.100` (rollback) | yes, ignored | 11.8 / 13.7 ms | 150/150 |
  | candidate | yes | 11.8 / 14.1 ms | 150/150 |

  - **No burst of failure notices at upgrade.** The candidate ran for more than 100 s (10 scheduler ticks) on the copy. Results: 0 `schedule_failing` notices and 0 schedules with `failure_alert_at` set.
    - Only one schedule in the copy has a streak of at least 5: a **paused** schedule with 31 failed runs since its last success and no open runs. A paused schedule does not dispatch, so it cannot fail again, and it stays silent.
    - Every active schedule has a streak of 0.
  - **Due reminders stay off with the production flags.** The log printed `[due-reminders] scope: off`, and `requirement_due_reminders` still had 0 rows.
  - Every start answered `/health`, and none logged an error. `integrity_check` returned `ok` at the end.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.101`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.101
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.101
```

On the first start, the Hub adds the two nullable `scheduled_tasks` columns. No other migration runs. Existing settings keep their meaning; `COMMHUB_DUE_REMINDERS=0` without `COMMHUB_DUE_REMINDERS_NETWORKS` keeps due reminders off. To silence the failing-schedule notice, set `COMMHUB_SCHEDULE_FAILURE_NOTICE_RUNS` to a very large number. There is no separate off switch.

## Rolling back

Rolling back to `0.9.0-preview.100` is safe, because `.100` ignores the two extra columns:

- `.100` reads `scheduled_tasks` through explicit column lists and inserts with named columns. Both new columns are nullable, so `.100`'s inserts leave them `NULL`.
- In the drill above, `.100` ran on the copy with the columns present. It completed 150 task writes, and its scheduler ran with no errors. The copy still passed `integrity_check` afterwards.
- Upgrading again later finds the columns already there.

The columns can stay.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
