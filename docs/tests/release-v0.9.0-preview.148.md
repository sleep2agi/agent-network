# CommHub Server — create tags with parents, v0.9.0-preview.148

Ships `main` after #2935 (plus the two CI commits #2933 / #2934 that landed
after `.147`). One new capability: a network can now **create** a tag and hang
it under a parent tag, and a tag with **zero tasks** is readable instead of
disappearing.

```
@sleep2agi/commhub-server@0.9.0-preview.148
```

## What changed

- **`tag_tree` capability.** Listed in `REQUIREMENT_CAPABILITIES`. Old clients
  ignore it; a client that sees it may show "new child tag".
- **`POST /api/requirements/tags/create`** `{ "name": "...", "parent_id": null | "parent name" }`
  - 201 `{"ok":true,"tag":{"name","parent_id","depth"},"parent_registered":false}`
  - duplicate (registered node, used by any card, or carrying a color) → **409 `tag_exists`**
  - missing parent → **404 `parent_not_found`** — the child is never silently
    created at the root
  - more than **4 levels** (root = 1) → 400 `tag_depth_exceeded`
  - invalid name → 400 `invalid_tag`; non-string / invalid `parent_id` → 400 `invalid_parent_id`
  - node row + audit entry in one transaction
  - same permission as `tags/ops` (network owner, Hub admin, `task_access='all'`);
    scoped members, viewers and node tokens get **403**
- **`GET /api/requirements/tags` gains `nodes`** (`tags`/`counts`/`colors`/`can_manage`
  keep their meaning): registered nodes ∪ in-use tags the caller can see, with
  `parent_id`, `depth`, `count`, `color`, `registered`. **Zero-task tags are
  included** (`count: 0`) — that is what made a created child tag unreadable before.
- **`tags/ops` maintains the hierarchy**: `rename` rewrites children's parent
  (an existing target is treated as a merge, and a target that is a descendant
  of the source is re-hung on the source's parent instead of self-looping);
  `merge` re-hangs the sources' children on the target; `delete` re-hangs them
  on the deleted tag's parent (root when it had none). The response gains
  `reparented`.
- **Zero-task tags are now manageable**: `tags/ops` used to answer 404 unless a
  card carried the tag; a registered node counts as existing, so a tag created
  before it has any tasks can be renamed, coloured or deleted.

## What did not change

- Tags are still plain strings in `requirements.tags_json`. No card is rewritten
  by this release; the new table only stores "who hangs under whom".
- `GET /api/requirements/tags` keeps `tags` = "names that appear on cards", so
  older clients behave exactly as before.
- No migration of existing tags: legacy tags are returned as `parent_id: null`,
  `depth: 1`, `registered: false`.

## Verification

- `server/src/requirement-tag-tree-http.test.ts`, 18 HTTP cases against a real
  `Bun.serve` and a temporary database: root / child / three levels / the
  4-level boundary, zero-task discoverability, duplicate 409, missing parent 404,
  permission 403 for scoped / viewer / node token with **no row written**,
  invalid bodies, cross-network isolation of identical names, scoped callers not
  seeing unreachable registered names, rename/merge/delete hierarchy maintenance,
  and colour following a rename.
- Together with the existing tag-ops and requirements HTTP suites: **52 pass / 0 fail**.

## Install

```bash
set -e
HUB_DIR="$HOME/.commhub/runtime-v148-preview148"
test ! -e "$HUB_DIR"
install -d -m 700 "$HUB_DIR"
umask 077
npm install --prefix "$HUB_DIR" --ignore-scripts --no-audit --no-fund \
  @sleep2agi/commhub-server@0.9.0-preview.148
```

Run with the same env as the previous instance (at minimum `PORT` and
`COMMHUB_DB`). The database file is shared. This release adds one table
(`network_tag_nodes`) with `CREATE TABLE IF NOT EXISTS`; the existing
`network_tags` colour table is unchanged.

## Rollback

Keep the previous runtime directory (`runtime-v147-preview147`) and point
`HUB_RUNTIME_DIR` back to it. The new table is additive and ignored by `.147`,
so no data rollback is needed.
