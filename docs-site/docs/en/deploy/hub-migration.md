# Moving the Hub

“After the Hub moves, do the nodes only need a new Hub address?”

**No.** If the address clients already use stays the same, nodes and apps change nothing. If the address must change, change only that address; do not reissue tokens. Changing the address without moving the database and the vault key connects everyone to an empty Hub.

This page is the SQLite Hub as it works today. If `DATABASE_URL` starts with `postgres://` or `postgresql://`, the Hub is not using the file below, and these steps do not apply. **PostgreSQL support is still in development and does not work yet**: a Hub configured this way refuses to start (see [RFC-039](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-039-hub-postgresql-backend.md)).

## What moves

Stop the Hub process before the final backup. While that process is running, its scheduler still writes.

| Move | Default | Notes |
|---|---|---|
| Database | `~/.commhub/commhub.db` | If `COMMHUB_DB` is set, that path is the one that moves |
| Uploads | `~/.anet/server/uploads` | If `COMMHUB_UPLOADS_DIR` is set, that directory is the one that moves. Take the whole tree, including `.index` |
| Vault master key | `ANET_HUB_SECRET_VAULT_KEY` | 64 hex characters. If the launcher reads `~/.commhub/hub.env` (override the path with `HUB_ENV_FILE`), move that file too and keep it mode `0600` |
| Pinned runtime and launcher | Only if you already start that way | See below |

A Hub started with `anet hub start` has no separate runtime directory to copy. Install Bun and `anet` on the new machine, put the database, the uploads directory, and the same key in place, then start **one** process. See [Keeping the Hub running](/en/deploy/keep-alive).

If the process you run is the launcher [`deploy/hub/hub-daemon.sh`](https://github.com/sleep2agi/agent-network/blob/main/deploy/hub/hub-daemon.sh), also move the script and the directory named by its `RUNTIME_DIR=` line. Use the script that is actually running, not an example path from the repository. If `BUN_BIN` in `hub.env` is an absolute path from the old machine, point it at a `bun` binary that exists on the new machine; otherwise the launcher refuses to start. Do not move `/tmp/bunx-*` caches. Those are not the install.

The key reaches the Hub only through `hub.env` or the process environment. `anet hub start` does **not** read `hub.env` by itself. A newly generated key does not decrypt existing `network_secrets` or `providers` ciphertext.

Routine backups stay on the `sqlite3 .backup` command in [Production](/en/deploy/production). For a move, use the command below. It writes one standalone file. Do not `cp` a database that is in use, and do not treat `-wal` / `-shm` files as the backup.

```bash
umask 077
mkdir -p "$HOME/.commhub/backups"
src="${COMMHUB_DB:-$HOME/.commhub/commhub.db}"
dst="$HOME/.commhub/backups/commhub-migrate.db"
bun -e "new (require('bun:sqlite').Database)(process.argv[1],{readonly:true}).exec(\"VACUUM INTO '\" + process.argv[2] + \"'\")" "$src" "$dst"
bun -e 'const {Database}=require("bun:sqlite"); const db=new Database(process.argv[1],{readonly:true}); const ic=db.query("PRAGMA integrity_check").get(); if(ic.integrity_check!=="ok") throw new Error(JSON.stringify(ic)); for (const t of ["sessions","tasks","nodes","api_tokens"]) console.log(t, db.query("SELECT COUNT(*) AS n FROM "+t).get().n);' "$dst"
```

`integrity_check` must be `ok`. Write down the four counts and compare them after the new machine boots. The backup holds accounts and messages. Treat it as sensitive, and do not paste values from `hub.env` anywhere else.

### What does not move

- `.anet/nodes/<node-name>/config.json` on each machine. The node token’s plaintext lives here; the database stores only a hash.
- Schedules on the node’s own machine (crontab and the rest) and the node’s rules files. They are not in the Hub database.
- `-wal` / `-shm` files, logs, and `/tmp/bunx-*`.
- The Dashboard install. It does not hold the Hub database. See below.
- The desktop app’s Local workspace. That is a different Hub on that computer.
- `~/.anet/server/admin-utok.json`. That file is the admin user token saved by `anet hub start` on that machine, not the database. Without it, `anet hub start` tries to register again. If the username is already in the moved database, registration returns `username already taken`, the command logs that the admin account already exists, and it does not change the password. Sign in with `anet login` and the original username and password.

## Do tokens stay valid?

Yes, once this database is the one the new process opens. Checks do not use the machine or its hostname.

All three token kinds are rows in `api_tokens`. The table stores SHA-256 of the token string (`hashToken`), not the token itself. `resolveToken` looks up `token_hash`, then checks expiry and revocation. The query has no hostname and no machine id.

| Token | Prefix | Where it sits |
|---|---|---|
| User token (login session) | `utok_` | `scope = 'user'` and `network_id` is null |
| Node token | `ntok_` | `scope = 'network'`. `bound_node_id`, when set, points at a node row in this database, not at a machine |
| API token | `atok_` | `scope = 'full'`, from `createToken` |

Passwords are in the same database, as `scrypt$<N>$<salt>$<hash>` with a random salt. The salt is not mixed with a hostname, so the same username and password still log in.

User tokens also expire after idle time: 30 days unused by default (`COMMHUB_SESSION_IDLE_DAYS`; `0` turns it off). That clock does not depend on the move. Node tokens and API tokens are not idle-expired.

The vault master key is not part of token checks. Without it, the tokens above still resolve; encrypted network secrets and provider settings do not decrypt.

## What each side changes

**Keep the public address (recommended): change nothing on the clients.** Point the domain or the reverse proxy at the new machine. Nodes, daemons, the desktop and mobile apps, and the Dashboard keep using the address they already have.

Change the rows below only when the address itself must change. Leave token fields alone. Do not run `anet daemon init --force`; that mints a new node token.

| Side | What to change | Address only? |
|---|---|---|
| Node | `hub` in `.anet/nodes/<node-name>/config.json`. If that key is absent, `hub` in `~/.anet/config.json` | Yes. Restart the node |
| Daemon | The same `hub` key. A daemon is a node whose `role` is `host_supervisor`. See [anet daemon](/en/deploy/daemon) | Yes. Restart it. Do not pass `--force` |
| CLI | `COMMHUB_URL`, or `anet login --hub <new-address>` | Yes. Precedence is below |
| Desktop and mobile app | Settings → Switch account → Add account. The server field is labeled 服务器地址. Sign in with the same username and password, then switch to that row | Yes. The old row still points at the old address |
| Dashboard | `COMMHUB_URL` in the Dashboard process (default `http://127.0.0.1:9200` when unset) | Yes. Restart the Dashboard process |

The address a node actually dials is, in order: `--hub`, then `COMMHUB_URL`, then `hub` in that node’s `config.json`, then `hub` in `~/.anet/config.json`, then `http://127.0.0.1:9200`. If a process manager sets `COMMHUB_URL`, editing `config.json` alone does nothing.

The app has no field that only rewrites a saved address. Add an account for the new address instead. The label on that field is the Chinese text 服务器地址. See [Desktop and mobile clients](/en/guide/desktop-app). Do not add the Local workspace here.

Dashboard logins use the user token in the database. As long as `COMMHUB_URL` still reaches this Hub, or the proxy in front of it, do not reissue tokens. See [Dashboard](/en/guide/dashboard).

## Cut over and roll back

1. **Stop writes.** Stop the process manager that keeps the Hub up, and confirm no second Hub is listening. Unplugging only the proxy leaves the scheduler writing to the old database.
2. **Take the last backup** with `VACUUM INTO` above. `integrity_check` is `ok`. Record the `sessions`, `tasks`, `nodes`, and `api_tokens` counts.
3. **Start the new machine in private.** Place that database, the uploads directory, and the same `ANET_HUB_SECRET_VAULT_KEY`. Do not send public traffic yet. Anonymous `GET /health` returns `ok: true`. `sessions_count` is the number of rows in `sessions` and must match the backup. `version` is the server you meant to run. `sse_connections` may be 0; clients have not moved yet.
4. **Cut traffic.** Preferred: change the domain or reverse proxy, and leave the public address as it is. If the address must change, then update nodes, daemons, apps, and the Dashboard one machine at a time, as above.
5. **Watch.** Existing SSE connections drop once and reconnect on their own. A node backs off from about 1 second up to 30 seconds, and gives up only after an hour of continuous failure; on reconnect it registers again. The desktop and mobile event stream doubles from 2 seconds up to 30 seconds and keeps trying. The Dashboard retries after 3 seconds by default. `sessions_count` stays the same.

**Rollback is pointing traffic back at the old machine.** Stop the Hub on the new machine, start the old machine on the database from the moment writes stopped, then point the proxy back. Tasks and messages written after the cut exist only on the new copy.

If you also changed client addresses, point those back too.

## Do not write on both

- If the old and new machines both accept writes, you get two databases that will not match later. Two machines also must not write one SQLite file at the same time.
- Every Hub process starts the scheduler for Hub schedules. Two processes on two copies each dispatch. Two processes on one database can claim a single occurrence through the unique key on `scheduled_task_runs` (`schedule_id` + `scheduled_for`); that is not how a move works. Keep one Hub process during the move. Crontab and the other plans on a node’s own machine are not this process. They stay put when the address stays put. If the address changes, change that node’s `hub`, or they keep calling the old address. See [Schedules](/en/guide/schedules).
- `hub-daemon.sh` refuses to start when its port is already taken, so a second Hub cannot attach to the same database. Do not bypass that check. `anet hub start` does not make this check, so do not start a second process by hand either.
