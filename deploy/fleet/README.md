# PM2 fleet boot — Git authority and recovery boundary

This directory versions the non-secret boot chain that was previously present
only on the production host:

```text
systemd --user pm2-fleet.service
  -> ~/.local/bin/pm2-fleet-boot.sh
  -> pm2 resurrect (only when the live PM2 list is empty)
```

The host files are deployment copies. The files here are the reviewable Git
authority. Installing them does **not** authorize a restart or a fleet upgrade.

## Install the software-side boot chain

The current production recipe is deliberately pinned to user `vansin`, NVM
Node `v20.20.0`, and its PM2 binary. A different recovery user or Node layout
requires an explicit reviewed change; do not silently rewrite paths during an
incident.

```bash
install -d -m 700 "$HOME/.local/bin" "$HOME/.config/systemd/user"
install -m 755 deploy/fleet/pm2-fleet-boot.sh \
  "$HOME/.local/bin/pm2-fleet-boot.sh"
install -m 644 deploy/fleet/pm2-fleet.service \
  "$HOME/.config/systemd/user/pm2-fleet.service"

test "$(git hash-object deploy/fleet/pm2-fleet-boot.sh)" = \
     "$(git hash-object "$HOME/.local/bin/pm2-fleet-boot.sh")"
systemd-analyze --user verify "$HOME/.config/systemd/user/pm2-fleet.service"
systemctl --user daemon-reload
systemctl --user enable pm2-fleet.service
loginctl show-user "$USER" -p Linger
```

Do not start the unit until the process inventory and recovery inputs below are
ready. `RemainAfterExit=yes` means an active/exited unit only proves that the
oneshot completed once; it does not prove every PM2 app is healthy.

## `dump.pm2` is sensitive backup state, not Git configuration

PM2's generated `~/.pm2/dump.pm2` contains much more than app names and script
paths. It can persist the daemon's inherited environment, including
secret-bearing variables. Therefore:

- never commit, paste, or attach the dump to a public issue;
- store it only as an encrypted owner-controlled backup with restrictive file
  permissions;
- restore secret values from their vault/owner source, never from Git;
- after recovery, recreate apps from their repository authorities where
  possible, complete behavior checks, and only then run `pm2 save`.

The exact encrypted backup record name for the dump and node configs is
**NOT COVERED**. Until an owner supplies it, Git-only recovery is incomplete.

## Current non-secret inventory

[`process-inventory.json`](./process-inventory.json) records the five captured
PM2 app names and their authority status without copying args, environment, or
tokens. It is a review inventory, not an executable secret store.

- Hub and Dashboard launchers belong to this repository.
- The representative OpenCode node has a repository process recipe, but its
  identity, token, node config, and session state require encrypted backup or
  fresh registration.
- `weixin-listen` and `weixin-admin` point outside this repository. Their exact
  repository and build commit are **NOT COVERED**; do not claim full fleet
  reconstruction until that ownership link is filled.

## Recovery and verification order

1. Install the pinned Node/PM2 version and the files above.
2. Restore each service from its listed repository authority. Restore data and
   node identity only from approved encrypted backups, or re-register cleanly.
3. Create/start one app at a time from its ecosystem definition. Do not import
   an unreviewed historical dump merely because it exists.
4. Verify real behavior: Hub health and session count; Dashboard external route
   and version; node identity plus a routed task/reply; external service owner
   checks. `pm2 online` alone is insufficient.
5. Run `pm2 save`, record its encrypted-backup coordinate, then start/enable
   the bootstrap unit.
6. Re-run the behavior checks after a controlled PM2 daemon restart before
   declaring the recovery exercised.

## Upgrade and rollback

Before changing any runtime, record per app: current package/runtime version,
launcher/config path, PID, and behavior result. Upgrade no more than ten nodes
per batch. If a node does not resume heartbeat within ten minutes, stop the
batch and restore its prior runtime/launcher while preserving config/session.

The boot-chain rollback is byte-based: restore the prior checked-in launcher
and unit, verify their hashes, `daemon-reload`, and rerun the same behavior
checks. Never use `pm2 kill`, broad `pkill`, or an `ExecStop` that tears down the
whole fleet as a rollback shortcut.

## Honest status

The boot script behavior is exercised by the Docker gate in
`tests/test736-pm2-fleet-rebuild/`. A full empty-host production recovery has
not been performed. External Weixin authority, secret backup record names, and
production data restoration remain NOT COVERED.
