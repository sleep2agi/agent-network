# CommHub Server — restart refuses in-flight work, v0.9.0-preview.142

One behaviour change: **`restart_node` does not restart an active node that still has in-flight work.**

The count is the same one `stop_node` already uses. A live task is counted with no age ceiling. A terminal task is not counted. A row with no task status is counted only for 60 minutes.

- An **active** node with that count above zero returns `node_busy_in_flight`, `in_flight_count`, and a hint. No restart is dispatched. Lifecycle state is unchanged. There is no `force` override on this path.
- A **stopped** node can still be restarted. Leftover unacked rows are not treated as live work, so they cannot block the only un-stop path.
- `stop_node` and `delete_node` keep their existing rule, including `force=true`.

Client 0.2.272 already shows this error as “wait, do not restart.” Older clients see the error string and do not retry unless they already did.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v142-preview142"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.142
```

Run with the same env as the previous instance (at minimum `PORT` and `COMMHUB_DB`). The database file is shared. This release adds no table.

## Upgrade

```bash
# stop the old instance, then start the new one against the SAME database
PORT=9200 COMMHUB_DB="$HOME/.commhub/commhub.db" \
  bun "$HUB_DIR/node_modules/@sleep2agi/commhub-server/bin/commhub.ts"
```

- Rollback is the previous runtime directory (`runtime-v141-preview141`). No schema change to undo.
- Do not expect `node_busy_in_flight` from `restart_node` on a Hub older than 0.9.0-preview.142. That path still dispatches the restart.
