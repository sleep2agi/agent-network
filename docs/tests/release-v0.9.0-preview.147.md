# CommHub Server — a hard ceiling on avatar storage, v0.9.0-preview.147

Ships `main` after #2054 / PR2907. One behaviour change: the Hub refuses to host
more avatar bytes than it is configured to keep, instead of growing without bound.

```
@sleep2agi/commhub-server@0.9.0-preview.147
```

## What changed

- **Total avatar storage cap** (`MAX_AVATAR_STORAGE_BYTES`, default **1 GiB**).
  When the next upload would exceed it, the Hub answers **503
  `avatar_storage_full`** and stores nothing — no partial write, no eviction of
  an existing avatar.
- **Why a cap and not eviction**: reclaiming is a policy decision (unverified
  accounts? 90-day expiry? per-network quotas?) and an automatic eviction here
  would silently replace someone's picture. This release only *refuses to
  grow*; deciding what to reclaim is a later card.
- Measured on the production network before shipping: **0 uploaded avatars**
  (`users.avatar_url` had 2 rows, both built-in images), so the cap cannot
  reject anything that already exists.

Also in this release: nothing else — the two CI-only commits (#2921 / #2925)
that stop the required lint workflows from re-running on every `main` push.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v147-preview147"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.147
```

Run with the same env as the previous instance (at minimum `PORT` and `COMMHUB_DB`).
The database file is shared. This release adds no table.

## Upgrade / rollback

Prod runs a pinned runtime directory through `deploy/hub/hub-daemon.sh`, so an
upgrade means **a new `RUNTIME_DIR`**:

```bash
# 1) what is running now
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
# 2) build the new runtime dir (explicit version, never a bare tag)
DIR="$HOME/.commhub/runtime-v147-preview147"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.147"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# 3) point RUNTIME_DIR at $DIR in ~/.local/bin/hub-daemon.sh, then reload pm2
pm2 reload commhub-hub
# 4) read the version back
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
```

Rollback: point `RUNTIME_DIR` back at the previous directory and reload. No data
migration to undo — the cap is a runtime check, not a schema change.

`anet hub start` resolves the `preview` dist-tag (the pinned constant is a
minimum, not the launched version), so a restart through that path also picks
this release up.
