# CommHub Server — tag reparent, v0.9.0-preview.156

Ships `main` after `.155`. One new tag operation, nothing that changes existing behaviour.

```
@sleep2agi/commhub-server@0.9.0-preview.156
```

## What changed

- **A tag can move under another tag.** `POST /api/requirements/tags/ops` accepts:

  ```json
  { "op": "reparent", "tag": "子标签", "parent": "父标签" }
  { "op": "reparent", "tag": "子标签", "parent": null }
  ```

  It changes **only the tree edge**: no card is rewritten, nothing is renamed. The two existing
  values in the response therefore always read `affected: 0, reparented: 1`.

- **Four rules, each refused explicitly rather than silently adjusted**
  1. the parent must already exist in this network (used by a card, has a colour, or is a
     registered tree node) → `404 tag_parent_not_found`;
  2. no cycles — the parent cannot be the tag itself or one of its own descendants →
     `400 tag_parent_cycle`;
  3. the deepest level after the move stays within 4 (the root counts as level 1). The check is
     **the new parent's depth plus the height of the tag's own subtree**, so a 3-level branch is
     not waved through just because its new parent sits near the root → `400 tag_depth_exceeded`;
  4. `parent` must be sent explicitly: a missing key is `400 invalid_tag_parent_id`, while `""`
     or `null` moves the tag to the top level. Silently rooting a tag on a missing field would
     make the client's preselection and the stored value disagree.

- **A refusal writes nothing.** The cycle and depth checks run on a virtual tree before any row is
  written. This matters because returning an object from the transaction callback **commits** it;
  the earlier draft registered a legacy tag as a node and then answered `404`, leaving a row
  behind under a "nothing changed" error. `requirements-tag-ops-http.test.ts` now asserts the
  legacy tag is still `registered: false` after a refused move.

- **Legacy tags work too.** A tag that has only ever appeared on cards (never registered as a
  node) is registered as a top-level node and attached in the same transaction.

- **Same permission lock as rename / merge / delete** — network owner, admin, or a member with
  `task_access='all'`. Node tokens and scoped members get `403`. Audit action:
  `requirement_tag_reparent`.

## Compatibility

- **Additive.** `rename / merge / delete / color` behave exactly as before; a client that never
  sends `reparent` sees no difference.
- Tag ids are still names (`parent_name` in `network_tag_nodes`), so `.155` and `.156` share the
  same storage with no migration.

## What this release does NOT do

- No UI. The client's "manage tags" page can call the new op; whether it shows a "change parent"
  control is the client's work.
- No MCP tools for tags yet. `tools/list` is at 86,264 / 86,500 bytes, so adding
  `requirement_tags_list` / `requirement_tag_op` requires compressing existing descriptions first
  — tracked separately rather than raising the ceiling.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v156-preview156"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.156
```

## Upgrade

```bash
curl -s localhost:9200/health | grep -o '"version":"[^"]*"'
DIR="$HOME/.commhub/runtime-v156-preview156"
install -d -m 700 "$DIR" && umask 077
printf '{"name":"commhub-runtime","private":true,"version":"1.0.0","dependencies":{"@sleep2agi/commhub-server":"0.9.0-preview.156"}}' > "$DIR/package.json"
(cd "$DIR" && bun install --production)
# point HUB_RUNTIME_DIR at $DIR, then
pm2 reload commhub-hub --update-env
curl -s localhost:9200/health | grep -o '"version":"0.9.0-preview.156"'
```

## Rollback

Point `HUB_RUNTIME_DIR` back at `runtime-v155-preview155` and reload. No schema change, so nothing
to undo: a rolled-back Hub simply rejects the `reparent` op with `invalid_tag_op` and keeps the
tree as it was.

## Verification

- `server/src/requirement-tag-ops-http.test.ts` — 22 pass (13 pre-existing + 9 new): move under
  another tag and back to the root · refusal when the parent is a descendant · refusing to be its
  own parent · subtree height exceeding 4 levels while moving a leaf to exactly 4 still works ·
  missing parent / missing key / empty string · a legacy in-use tag gets registered then attached ·
  node token and viewer get `403` · **a refused move leaves no registration behind**.
- `server/src/requirement-tag-tree-http.test.ts` (18) and `requirements-etag-http.test.ts` (5)
  unchanged and green.
- Docs: `docs-site/docs/guide/task-tags.md` and its English counterpart gained the `reparent` row
  and the four rules; `check-doc-claims` / `check-doc-source-pins` / `check-doc-symbol-pins` /
  `check-mcp-tool-anchor-sections` / `check-mcp-tool-index-coverage` all pass locally.
- Published after: `scripts/verify-hub-release.sh 0.9.0-preview.156` must PASS.

## Also in this build (test-only)

- `tests/test658-codex-adopt-stop` no longer reads a half-written `child-pid` file
  (`Number("") === 0` made `processStamp` throw `adopt_pid_invalid`); the fixture now publishes
  the PID atomically and the barrier waits for a valid value. No product code changed, so this
  build is the first one where that suite cannot fail for the old reason.
