# Upgrade Agent Network

This page is for users who already have `anet` installed. Do not copy a fixed
version from documentation: npm's `latest` and `preview` dist-tags define the
stable and preview channels.

## 1. Inspect the plan

```bash
anet --version
anet upgrade --dry-run
```

`--dry-run` resolves targets and prints actions without installing packages. The
current CLI channel is kept by default. Use `--channel latest` or
`--channel preview` only when you intentionally want to switch channels.

## 2. Stop the Hub and back up state

Stop the supervisor that actually owns the Hub. Use `Ctrl-C` for a foreground
process, or stop it through PM2/systemd. Do not use `pkill -f`, and make sure a
watchdog cannot immediately restart it.

Copy the SQLite directory only after the Hub has stopped, so the database, WAL,
and SHM files form a consistent snapshot:

```bash
backup_dir="$HOME/anet-backup-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$backup_dir"

[ ! -d "$HOME/.anet" ] || cp -a "$HOME/.anet" "$backup_dir/"
[ ! -d "$HOME/.commhub" ] || cp -a "$HOME/.commhub" "$backup_dir/"
[ ! -d .anet ] || cp -a .anet "$backup_dir/project-.anet"

find "$backup_dir" -mindepth 1 -maxdepth 1 -print
du -sh "$backup_dir"
```

Confirm that the expected directories are listed before continuing. Backups can
contain tokens; keep mode `700` and never upload them to a public repository or chat.

## 3. Upgrade

```bash
anet upgrade
```

The command upgrades related globally installed packages. Packages fetched lazily
through `bunx`/`npx` are reported as `lazy`. CLI self-upgrade runs in a detached
process; verify it from a fresh shell afterwards:

```bash
anet --version
```

CI and scripted environments can disable process self-replacement:

```bash
anet upgrade --no-auto-self
```

Then follow the printed manual CLI-upgrade instruction from a fresh shell.

## 4. Restart and verify

Start the Hub through its original owner, then restart nodes that need the new
`agent-node` process:

```bash
anet hub start
anet node restart <alias>
anet doctor
anet node ls
curl -fsS http://127.0.0.1:9200/health
```

If PM2/systemd owns the Hub, start it there rather than running a second foreground
Hub. For multiple nodes in one project, run `anet project restart` from that project.

Co-presence nodes (preview) must keep their original co-presence start mode. For example, a
node created with `--copresence` must be restored with `--copresence`; a generic
start can compete for the same alias.

At minimum, verify the CLI version, a non-blocking `doctor` result, Hub health, and
the expected online nodes.

### Configuration ownership in containers

Newer `agent-node` versions reject symlinks and a different UID owner before reading
token-bearing configuration. If Docker or Podman bind-mounts a host `config.json`,
run the container process with the file owner's UID, or copy the configuration into
a container-user-owned `.anet` state directory. Do not work around this check by
loosening permissions: an owner mismatch fails closed at startup.

Legacy configuration owned by the same UID remains compatible. Over-broad file modes
are repaired to `0600`, and Agent Network-managed `.anet` directories to `0700`.

## Very old v0.7 installations {#v0-7-v0-8-upgrade-notes-latest}

v0.7 used the legacy global-token model. Current releases retain read compatibility
for old `atok_` tokens, while new deployments and writes use user tokens (`utok_`)
and node tokens (`ntok_`). When crossing those old releases:

1. Keep an offline backup.
2. Run `anet login` and `anet doctor` after upgrading.
3. Do not edit SQLite tables or copy another node's token.

See the [account system](/en/guide/account-system) and
[changelog](/en/changelog) for context. This page no longer duplicates old
per-package commands or historical default passwords, because they mislead current
installations.

## Forgotten administrator password

Run this on the Hub host:

```bash
anet hub admin reset-user --username <user>
```

::: tip Why this is called out separately
`anet hub --help` does **not** list the `admin` subcommand, so this command cannot be discovered
by reading the help output. Do not reach for direct SQLite edits instead — those bypass
authorization and auditing, and can corrupt related state.
:::

## Rollback does not mean deleting state

Installing an older CLI does **not** roll back migrated configuration or the Hub
database. Without compatibility evidence, do not let an old Hub binary open the
upgraded production database.

If only the CLI is broken, inspect available versions and install a known-good CLI:

```bash
npm view @sleep2agi/agent-network versions --json
npm install -g @sleep2agi/agent-network@<verified-version>
anet --version
```

To restore configuration or the database, first stop the sole Hub supervisor and
move the current state into a new retained directory. Verify the backup path,
contents, and permissions before copying anything. **Never recursively delete the
entire `~/.anet` directory or overwrite state in place.** A database restore must treat the main database, WAL,
and SHM together and be rehearsed outside production first.

If compatibility is uncertain, preserve the evidence and open a
[GitHub issue](https://github.com/sleep2agi/agent-network/issues) with versions,
`doctor` output, and redacted logs.

## Related

- [CLI commands](/en/guide/cli)
- [Process supervision](/en/deploy/daemon)
- [Troubleshooting](/en/troubleshooting)
