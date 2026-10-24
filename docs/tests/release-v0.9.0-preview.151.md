# CommHub Server — network-scoped rules storage, v0.9.0-preview.151

Ships `main` after `.150`. One new storage + API pair; nothing in the runtime path
reads it yet.

```
@sleep2agi/commhub-server@0.9.0-preview.151
```

## What changed

- **New table `network_rules`** (`network_id` primary key, `content`, `revision`,
  `updated_at`, `updated_by_json`), created with `CREATE TABLE IF NOT EXISTS` on
  first use. No migration of existing rows, no change to any other table.
- **`GET /api/networks/:id/rules`** — any member of the network may read. The rules
  are what nodes would obey, so reading is not privileged.
- **`PUT /api/networks/:id/rules`** `{content, expected_revision}` — owner / admin
  only (a Hub admin must also be a member); a **node token gets 403
  `user_token_required`**.
  - **Compare-and-swap is mandatory**: `expected_revision` must match the current
    revision, otherwise **409 `rules_revision_conflict`** and nothing is written.
    This document is meant to be inherited by every node, so a blind write would let
    two people silently overwrite each other.
  - Before the first write, reads report `revision: 0` with empty content, so a
    client creates with `expected_revision: 0` and there is no separate "create".
  - Size is capped at **200 KiB measured in UTF-8 bytes** → **413 `rules_too_large`**.
  - Every successful write records an audit entry (`network_rules_updated` with
    revision and byte size).

## What this release does NOT do

- It does **not** make any node read these rules. Inheritance (Hub → Daemon → node),
  precedence, conflict handling and injection are the next slice, and they need a
  product decision first.
- It does **not** touch a node's `CLAUDE.md` / `AGENTS.md`, and there is no UI yet.
- The field is additive: an older client or Hub never sees this table.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v151-preview151"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.151
```

## Upgrade

```bash
# 1) what is running now
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
# 2) build the new runtime dir (explicit version, never a bare tag)
DIR="$HOME/.commhub/runtime-v151-preview151"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.151"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# 3) point HUB_RUNTIME_DIR at $DIR, then reload
pm2 reload commhub-hub --update-env
# 4) read the version back
curl -s localhost:9200/health | grep -o '"version":"0.9.0-preview.151"'
```

## Rollback

Point `HUB_RUNTIME_DIR` back at `runtime-v150-preview150` and reload. The new table
is additive and ignored by `.150`, so no data rollback is needed.

## Verification

- `server/src/network-rules-http.test.ts`: 7 pass — member reads an empty document as
  revision 0 · a plain member cannot write · admin writes then reads back · a stale
  `expected_revision` is 409 and does not overwrite · a node token cannot write ·
  oversized content is 413 (bytes) · a non-member cannot read.
- After publishing: `scripts/verify-hub-release.sh 0.9.0-preview.151` must PASS.
