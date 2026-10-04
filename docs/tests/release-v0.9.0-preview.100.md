# CommHub v0.9.0-preview.100

This release carries the Hub changes merged since `0.9.0-preview.99`. Production is on `0.9.0-preview.99`. It is built from main at 12fe4f95.

Hub (`server/`) changes since `.99`, oldest first:

- #2325 (973f52d9) **The sender sees the target's queue; status reads show `queue_depth` (#500 step 2).**
  - `send_task` (MCP) and `POST /api/task` responses gain `queue_ahead`, `target_busy`, `est_wait_minutes` and, when the queue is long, a `warning`. Additive only; nothing is refused because of them.
  - `get_all_status` rows and full-projection `GET /api/status` rows gain `queue_depth`. `light=1` and the old agent-node alias-resolver read are byte-identical.
  - The full-status cache now also depends on writes to `tasks`.
- #2329 (eec86095) **Optional patrol rule for stale `acked`/`running` tasks, off by default (#519); expiry notices count only the last 24 h as "ahead" (fixes a #2322 bug).**
  - `COMMHUB_STALE_OPEN_TASK_HOURS=N` turns the rule on. Unset, `0` or garbage means off. Production does not set it, so nothing changes there until the owner decides.
- #2328 (12fe4f95) **Fix for the `/api/status` regression that #2325 introduced (#500).**
  - On a production-size database, #2325's `queue_depth` query was planned on `idx_tasks_status` and walked every open-status row ever written. Full `/api/status` went from about 8 ms to 66–77 ms (7–8×). That is why `.100` was held back the first time.
  - The query now keeps off `idx_tasks_status`, and a new covering index `idx_tasks_created_queue ON tasks(created_at, status, network_id, to_name)` lets it read only the index.
- Not Hub: the anet / agent-node changes and their release bumps (#2326, #2330–#2340).

## Schema change: one new index

`idx_tasks_created_queue` is created once at boot with `CREATE INDEX IF NOT EXISTS`. It is the only schema change. There are no new tables or columns, and no data is rewritten.

- On a read-only `VACUUM INTO` copy of the production database (57.5k tasks), building it took about 170–300 ms once (bun:sqlite, measured twice: 198 ms and 291 ms). Every later start finds it and does nothing.
- It costs a little on each write to `tasks`, because there is one more index to update.

## Checked

- **`tests/hub-release-compat`:**
  - Setup: candidate 12fe4f95 (same `server/` tree as this bump apart from the version), baseline `0.9.0-preview.99` from npm, apps desktop-v0.2.200 / desktop-v0.2.201 / desktop-v0.2.202, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`.
  - A1 and A2: steps=62, unexpected=0, check_failures=0.
  - B upgrade → rollback → re-upgrade: upgrade_check_failures=0.
- **Upgrade and rollback drill on a read-only `VACUUM INTO` copy of the production database.** The copy ran in a throwaway HOME on a random port, with `COMMHUB_DUE_REMINDERS=0`. The sequence was `.99` → candidate → `.99` → candidate. Each phase ran 150 full `/api/status` reads, each one right after a `POST /api/task`.

  | phase | index present | rows with `queue_depth` | full `/api/status` p50 / p90 |
  |---|---|---|---|
  | `.99` | no | 0 / 306 | 7.8 / 11.3 ms |
  | candidate | created at boot | 306 / 306 | 8.5 / 12.5 ms |
  | `.99` (rollback) | yes, ignored | 0 / 306 | 7.6 / 10.8 ms |
  | candidate | yes | 306 / 306 | 9.1 / 12.9 ms |

  - For comparison, #2325 without this fix measured 66–77 ms on the same kind of copy.
  - Every start answered `/health` with no errors in the log. All 150 task writes succeeded in every phase, including the rollback phase. `integrity_check` is ok at the end.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.100`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.100
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.100
```

On the first start, the Hub creates `idx_tasks_created_queue` once. On a production-size database this takes well under a second. No other migration runs. Existing settings such as `COMMHUB_DUE_REMINDERS` keep working. The stale-task rule from #2329 stays off unless you set `COMMHUB_STALE_OPEN_TASK_HOURS`.

## Rolling back

Rolling back to `0.9.0-preview.99` is safe, because `.99` ignores the extra index:

- `.99` never drops, lists or rebuilds indexes on `tasks`. Its only `DROP INDEX` is for a telemetry index, and it never rebuilds the `tasks` table.
- SQLite keeps the index up to date on `.99`'s writes. The drill above wrote 150 tasks on `.99` with the index present, and the database still passed `integrity_check`.
- Upgrading again later finds the index already there.

The index can stay. If you want it gone after a rollback, run `DROP INDEX IF EXISTS idx_tasks_created_queue;` while the Hub is stopped. This is optional.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
