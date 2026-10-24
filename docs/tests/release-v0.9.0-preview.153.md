# CommHub Server — idempotent rules revision and no orphan rows, v0.9.0-preview.153

Ships `main` after `.152`. Two corrections to the rules storage added in `.151`, plus one
ruler alignment. No new endpoint, no schema change, nothing in the runtime path reads these
rows yet.

```
@sleep2agi/commhub-server@0.9.0-preview.153
```

## What changed

- **Writing the same bytes no longer mints a new revision.** A save whose content is
  byte-identical to the stored text returns the current revision with `changed: false`, and
  writes no audit entry. Previously every save bumped `revision`, even when nothing changed.

  Why it matters: the next slice injects a managed block into node files keyed by
  `revision`. If a no-op save advanced the number, every node in the network would rewrite
  its file for nothing.

- **Deleting a network deletes its rules row.** Both deletion paths are covered — an owner
  deleting their own network, and a Hub admin deleting an empty one. Without this, a later
  path that reuses the same `network_id` would inherit somebody else's rules; the primary
  key here *is* the network id.

- **The size cap is now 256 KiB, the same ruler as `write_node_rules_file`.** It was 200 KiB.
  These two texts are meant to sit next to each other on a node, so a document that fits in
  the Hub must not be refused at the node.

- **Compare-and-swap is unchanged and stays required.** `expected_revision` must still match;
  a stale value is `409 rules_revision_conflict`. Idempotency and CAS solve different
  problems: CAS stops two editors from silently overwriting each other, idempotency stops
  the revision from growing on a no-op.

## What this release does NOT do

- It does **not** make any node read these rules. Inheritance (Hub → Daemon → node),
  precedence and injection are still the next slice and need a product decision first.
- No UI, and a node's `CLAUDE.md` / `AGENTS.md` is untouched.
- Route and payload shape are unchanged from `.152`.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v153-preview153"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.153
```

## Upgrade

```bash
# 1) what is running now
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
# 2) build the new runtime dir (explicit version, never a bare tag)
DIR="$HOME/.commhub/runtime-v153-preview153"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.153"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# 3) point HUB_RUNTIME_DIR at $DIR, then reload
pm2 reload commhub-hub --update-env
# 4) read the version back
curl -s localhost:9200/health | grep -o '"version":"0.9.0-preview.153"'
```

## Rollback

Point `HUB_RUNTIME_DIR` back at `runtime-v152-preview152` and reload. The change is behavior
inside one handler plus a cleanup entry; `.152` reads the same table with the same schema.

## Verification

`server/src/network-rules-http.test.ts` — 11 pass:

- a member reads an empty document as revision 0;
- a plain member cannot write (403), and admin writes then reads back;
- a stale `expected_revision` is 409 and does not overwrite;
- **re-writing identical bytes keeps the revision and reports `changed: false`**;
- **a real edit still moves the revision and reports `changed: true`**;
- **exactly 256 KiB is accepted, 256 KiB + 1 byte is 413**;
- **deleting a network leaves zero rows for that network**;
- a node token cannot write (`user_token_required`), cannot read another network's rules
  (`not_a_member`), and a non-member cannot read.

After publishing: `scripts/verify-hub-release.sh 0.9.0-preview.153` must PASS (it now asserts
the table, the route, the CAS conflict code and the node-token boundary).
