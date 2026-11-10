# CommHub Server — scheduled-task watchers, v0.9.0-preview.141

One behaviour change: **a scheduled task can name human watchers**.

A watcher can see the task (network members could already list it) and can edit its name, content, cadence, target, priority and timezone. A watcher cannot change the watcher list, cancel the task, or run it now.

- New table `scheduled_task_watchers (schedule_id, user_id)`. Old rows have no watchers. The migration is additive.
- `POST` and `PATCH /api/scheduled-tasks` accept `watchers`: an array of user ids (max 20, duplicates dropped). Unknown or out-of-network ids return `400 watcher_not_in_network`.
- Only the creator, a network owner/admin, or a global admin may set `watchers`. Anyone else gets `403 watcher_cannot_manage_watchers`.
- A watcher who is not otherwise allowed to write gets `403 watcher_cannot_cancel` on delete/cancel and `403 watcher_cannot_run` on run-now.
- Responses add `watchers`, `is_watcher`, `can_edit`, and `can_manage_watchers`. Older clients that ignore unknown keys keep working. A Hub older than this build has none of these keys.

Dispatch identity does not change. The schedule still runs as its creator, against the same target node.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-141"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.141
```

Run with the same env as the previous instance (at minimum `PORT` and `COMMHUB_DB`). The database file is shared. The new table is created on first start.

## Upgrade

```bash
# stop the old instance, then start the new one against the SAME database
PORT=9200 COMMHUB_DB="$HOME/.commhub/commhub.db" \
  bun "$HUB_DIR/node_modules/@sleep2agi/commhub-server/bin/commhub.ts"
```

- Creating `scheduled_task_watchers` is idempotent. Re-running startup does not drop rows.
- No client change is required to keep the old schedule screens working.
- Do not send `watchers` to a Hub older than 0.9.0-preview.141. That field is ignored or rejected depending on the route, and the flags will be absent.
