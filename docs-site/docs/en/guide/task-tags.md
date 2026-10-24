# Task tags

Short labels on a task card, shown in the list and used to filter by one tag. Saving them requires Hub 0.9.0-preview.68 or later. The client has the UI starting with 0.2.151. On an older Hub that does not return a `tags` field, the detail view offers no input and tells you to upgrade. It does not pretend the tags were saved.

Fields and errors are defined in [Requirements / task board](/en/api/mcp-tools#requirements-task-board).

## In the client

In the detail view, type a new tag or pick an existing one. Click the × on a tag to remove it. The board cards and the list show the tags under the title.

On desktop, filter from the left sidebar. On a phone, filter from the top bar. One tag at a time, and it must match the whole label. It combines with the other filters (status, project, and so on): a card has to satisfy all of them. The choices come from cards already loaded in the current list. Switching networks resets the filter to All.

iOS is still TestFlight. There is no public install link yet.

## What gets stored

`tags` is an array of strings.

- At most 10. Each is at most 20 characters, counted in Unicode code points, not UTF-16 units.
- Leading and trailing spaces are removed. Duplicates keep the first one. An empty string or a control character is rejected.
- An invalid value returns 400 `invalid_tags` and leaves the previous tags in place.
- Create without `tags` stores an empty array.
- Patch without `tags` keeps the current value. `[]` clears it.

A node token can read and write tags on tasks in the network it is bound to. A viewer can read them and cannot change them.

`GET /api/requirements/tags` returns the tags that appear in the current network, deduplicated and sorted, including tags that only remain on archived tasks. The suggestions in the detail view come from this list. Another network does not see them.

## Managing tags

When the list response's `capabilities` includes `tag_ops`, the Hub can rename, merge, or delete a tag across the whole network, and store a color for it. The client puts **Manage tags** at the bottom of the sidebar tag group. On an older Hub the entry is hidden.

`GET /api/requirements/tags` returns more than `tags`:

- `counts`: how many cards use each tag. Only cards the caller can see are counted, and archived cards are included.
- `colors`: tags that have a color, as `{"tag": "#rrggbb"}`. A tag with no color is left out, and the client uses the default color.
- `can_manage`: whether this caller may manage tags.

Older clients read `tags` only and ignore the rest.

`POST /api/requirements/tags/ops` takes one of these bodies:

| `op` | Other fields | Effect |
|------|--------------|--------|
| `rename` | `from`, `to` | Every card with `from` gets `to` in the same position. If `to` is already on the card, it is kept once, which amounts to a merge |
| `merge` | `from` (1–50), `to` | On every card with any source, the sources are replaced by a single `to` |
| `delete` | `tag` | The tag is removed from every card. The cards stay |
| `color` | `tag`, `color` (`#rrggbb`, or `null` to clear) | Only the color changes. No card is touched |
| `reparent` | `tag`, `parent` (a parent tag name, or `null` to move it to the top level) | **Only the tree edge changes.** No card is touched and nothing is renamed |

- All matching cards in the network, archived ones included, are rewritten in one transaction. If anything fails, no card changes.
- Each rewritten card's `updated_at` moves forward and `updated_by` records the caller, so `updated_since` sync picks up the change.
- On rename or merge, a target without a color inherits the first source that has one. Source colors are deleted, and so is the color of a deleted tag.
- The response is `{ok, op, affected}`, where `affected` is the number of cards changed.
- `reparent` has four rules, and each one refuses explicitly instead of adjusting silently:
  - the parent must already exist in this network (used by a card, has a colour, or is a tree node),
    otherwise `404 tag_parent_not_found`;
  - no cycles: the parent cannot be the tag itself or one of its descendants → `400 tag_parent_cycle`;
  - the deepest level after the move must stay within 4 (the root counts as level 1). The check is
    "depth of the new parent + height of this tag's own subtree", so a 3-level branch is not waved
    through just because the parent sits near the root → `400 tag_depth_exceeded`;
  - `parent` must be passed explicitly: omitting the key is `400 invalid_tag_parent_id`, while an
    empty string or `null` moves the tag to the top level (silently rooting a tag on a missing field
    would make the UI show one thing and store another).
- A legacy tag that only ever appeared on cards (never registered as a node) can be reparented too:
  it is registered as a top-level node first, then attached under the parent.
- `reparent` changes no cards, so `affected` is always 0 and `reparented` is 1. It uses the same
  permission lock as rename / merge / delete (network owner, admin, or `task_access='all'`);
  node tokens and scoped members get `403`.
- Tag names follow the rules above. Invalid input returns 400 `invalid_tag`, `invalid_tag_color`, or `invalid_tag_op`. A source equal to the target returns 400 `same_tag`. A tag that is not in the network returns 404 `tag_not_found`.
- Every successful call writes an audit entry: `requirement_tag_rename`, `_merge`, `_delete`, or `_color`. Its detail includes `affected`.

Who may call it: the same people who can manage projects, meaning the network owner, Hub admins, and members whose task access is **All tasks**. A member limited to related tasks (`task_access = scoped`) gets 403 `permission_denied`, and so does a viewer. A node token gets 403 `user_token_required`.

A scoped member is refused outright rather than allowed to change only the cards they can see, for two reasons. The tag would be split into an old half and a new half. And `affected` would reveal how many cards they cannot see. For a scoped member, `counts` and `colors` also cover only tags on cards they can see.

## See also

- [Tasks](/en/guide/tasks)
- [Requirements / task board](/en/api/mcp-tools#requirements-task-board)

## Creating tags and parent/child levels

When `capabilities` includes `tag_tree`, the Hub can create tags and nest them under a parent. On an older Hub the client hides "new child tag" and never calls the endpoint below.

Tag names are unique per network and **the name is the id** (there is no separate `tag_id`). `parent_id` is the parent's name.

`POST /api/requirements/tags/create`:

```json
{ "name": "child tag", "parent_id": null }
```

Omit `parent_id` or send `null` to create at the root; a name must already exist in the network to be used as the parent.

- Success is 201 `{"ok":true,"tag":{"name","parent_id","depth"},"parent_registered":false}`; `depth` starts at 1.
- An existing tag (a registered node, used by any card, or carrying a color) returns 409 `tag_exists`; the existing tag is never silently reused.
- A missing parent returns 404 `parent_not_found`; the child is **never** silently created at the root.
- At most 4 levels including the root; deeper returns 400 `tag_depth_exceeded`.
- Name rules are the same as above; an invalid name returns 400 `invalid_tag`, a non-string or invalid `parent_id` returns 400 `invalid_tag_parent_id`.
- When the parent only existed on cards (legacy data with no node row) it is registered as a root node in the same transaction and the response has `parent_registered: true`; the child still hangs under it and is not demoted to the root.
- Node rows and the audit entry are written in one transaction; a failure leaves nothing behind.

With the `tag_tree` capability `GET /api/requirements/tags` also returns `nodes` (`tags` / `counts` / `colors` / `can_manage` keep their meaning):

```json
{ "nodes": [ { "name": "frontend", "parent_id": "requirements", "depth": 2, "count": 0, "color": null, "registered": true } ] }
```

- `nodes` is "registered nodes ∪ in-use tags the caller can see". Tags with **zero tasks are included** (`count: 0`), so the sidebar can show an empty child tag.
- Legacy tags that only appear on cards without a node row keep `parent_id: null`, `depth: 1`, `registered: false` and stay flat.
- Scoped members (`task_access = scoped`) only receive tags they can see; a registered name with no visible card does not leak.

Rename / merge / delete maintain the hierarchy: `rename` rewrites child `parent_id` too (an existing target is treated as a merge and never self-loops); `merge` hangs the sources' children under the target; `delete` reparents children to the deleted tag's parent (or to the root when it had none), so levels are never lost.
