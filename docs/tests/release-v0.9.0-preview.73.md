# CommHub v0.9.0-preview.73

This release carries the Hub changes merged since `0.9.0-preview.72` (built from 99955d80). Production is on `0.9.0-preview.72`.

- #2162 (6117a945067d4dca74f21355bf3c834c51b9d804) **A cleanly stopped Hub leaves a complete `.db` (fixes #2151).**
  - After more than 20 distinct SQL statements, bun:sqlite's `close()` could no longer close the connection, so SQLite never checkpointed. The latest writes stayed in `-wal`, and a copy of the `.db` file alone could be empty.
  - `SQLiteAdapter.close()` now runs `PRAGMA wal_checkpoint(TRUNCATE)` first. After a clean `SIGTERM`/`SIGINT` stop, `-wal` is empty.
  - A crash or `kill -9` still leaves a `-wal`, which SQLite replays on the next open. Keep copying with `VACUUM INTO` / `.backup`.
- #2165 (50f513666b141e6f648839aef7b54f2a05546cac) **Member presence for people in a network.**
  - `GET /api/networks/:id/humans` with a user token adds `online` and `last_seen_at` for each person.
    - `online` is true when the person has a live `/events/users/me` stream right now.
    - `last_seen_at` is an ISO time kept in Hub memory only. It is `null` for anyone who has not connected since the Hub started.
  - With a node token the response is unchanged: the three identity fields only.
  - When a person's first user stream connects or their last one disconnects, the other members with a live user stream get `{"type":"member_presence","member_user_id","online","last_seen_at"}`. Older apps ignore unknown event types; app 0.2.160 / 0.2.161 were checked against it.
- #2155 (d078eb103087dd17563fcc5e2d4d29eca9ceae5f) **`commhub-server` refuses what it does not understand (fixes #2153).**
  - An unknown subcommand or flag, a `--flag=value` form, or a value flag with no value now exits 2 with a usage message.
  - Before this, each of those started a Hub on the defaults (`~/.commhub/commhub.db`, `:9200`).
  - `--version` / `-v` prints the package version. On older versions `--version` also started a Hub.
- #2157 (33cd6d4200d608a2c12a44d4c0ed090fcb3d9959) **Skill search treats `%` and `_` as text (fixes #2141).** On both SQLite and PostgreSQL, `list_skills` escapes the query, so `_` no longer lists every skill.
- #2159 (52add259957d49e99591e52f33698f93203ca979) **`commhub-server migrate-to-pg` (RFC-039 S5b), experimental.**
  - Offline copy of a stopped Hub's SQLite database into an empty PostgreSQL database, in one transaction, verified with per-table row counts and content hashes before COMMIT. `--dry-run` is available.
  - It refuses a database that a running process holds, a source under `~/.commhub` (unless `--i-know-this-is-a-copy`), and a non-empty target.
  - This is the first version that has the command. Do not run it against an older installed server: older versions start a Hub instead. On those, even `--version` does, so check the version with `npm ls` or the package's `package.json`.
- #2150 (43a1e452444081da669e26157932a2c447bb95e8), #2158 (addab652a911dbd47665533405f348ca9eee946f) **PostgreSQL work (RFC-039 F6, S5a).** PostgreSQL only: skill search keeps SQLite's case-insensitivity via `ILIKE`, and `REAL` columns are `DOUBLE PRECISION`. PostgreSQL is still in development and not usable without `COMMHUB_PG_EXPERIMENTAL=1`. SQLite paths are unchanged.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.73`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.73
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.73
```

For an existing instance, the operator backs up the database in an authorised window, then restarts the process with its usual service manager.

Migrations at startup: none. No table, column or index changes since `0.9.0-preview.72`.

Changed at shutdown: a clean stop now checkpoints the WAL (#2162). The first stop after upgrading consolidates whatever the previous run left in `-wal`.

Behaviour change for scripts: `commhub-server` with an unrecognised argument now exits 2 instead of starting a Hub (#2155). Check any wrapper that passes extra arguments. `anet hub start`, `deploy/hub/hub-daemon.sh` and the Feishu docker setup pass only supported flags.

The package contains no existing data, users, network members or secrets. To roll back, use `0.9.0-preview.72`. No data restore is needed, since there is no schema change. Do not drop production tables or overwrite published packages.
