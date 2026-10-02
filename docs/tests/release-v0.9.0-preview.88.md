# CommHub v0.9.0-preview.88

This release carries the Hub changes merged since `0.9.0-preview.87`. Production is on `0.9.0-preview.87`.

- #2248 (3d338608) **Stuck scheduled runs alert the creator and time out (#464).**
  - With overlap=skip, a run whose previous task never reached a terminal state used to be skipped forever, with no timeout and no alert.
  - When a run is skipped for the 3rd time behind the same blocking task, the schedule's creator gets one message (`kind=schedule_stuck`, same `user_inbox` + `desktop_message` path as #462). It names the schedule, the blocking task id, the node alias and the start time. Once per blocking task; it re-arms by itself when a run dispatches again and needs no in-memory state.
  - A blocking task older than `max(6 × interval, 1 h)`, capped at 24 h, is marked `expired` the same way the TTL patrol does (task row stays readable, run mirrored to expired/task_expired, task_event by `hub-scheduler`). The next run dispatches normally. A late reply gets `reply_task_terminal` and changes nothing. If a task times out before 3 skips, one "timed out" notice goes out instead.
  - Knobs: `COMMHUB_SCHEDULE_STUCK_NOTICE_SKIPS`, `COMMHUB_SCHEDULE_STUCK_TIMEOUT_FACTOR`, `COMMHUB_SCHEDULE_STUCK_TIMEOUT_FLOOR_SEC`, `COMMHUB_SCHEDULE_STUCK_TIMEOUT_CAP_SEC`.
- #2247 (f12a9ec8) **`GET /api/status` read cache, ETag/304 and gzip (#431).**
  - Serialized `/api/status` bodies are memoized per network, projection and viewer, and invalidated on any status, health or session change. Response bodies are byte-identical to `.87`.
  - Strong `ETag`; a matching `If-None-Match` returns `304`. App 0.2.194 sends it; old agent-node never does.
  - Reusable bodies are gzipped at level 9.
  - CI: the L0 step and the qa-ut-01 / qa-ut-03 images now install `server/` dependencies before running tests.

No schema change.

Checked in Docker with `tests/hub-release-compat`, candidate f12a9ec8f5ff05c53d6ffc5d6d5d34d7b9b23b2d, baseline `0.9.0-preview.87` from npm, apps 0.2.166 / 0.2.181 / 0.2.193, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, unexpected=0, check_failures=0 each.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.88`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.88
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.88
```

No migration; the database is not changed by this release. On first start, any scheduled run already blocked longer than its timeout is expired and its creator gets one notice.

## Rolling back

`0.9.0-preview.87` starts on a database that `.88` has run on: `.88` adds no tables or columns. Tasks `.88` expired stay `expired` (a terminal state `.87` already understands). The status cache lives in memory only.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
