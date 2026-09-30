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

- All matching cards in the network, archived ones included, are rewritten in one transaction. If anything fails, no card changes.
- Each rewritten card's `updated_at` moves forward and `updated_by` records the caller, so `updated_since` sync picks up the change.
- On rename or merge, a target without a color inherits the first source that has one. Source colors are deleted, and so is the color of a deleted tag.
- The response is `{ok, op, affected}`, where `affected` is the number of cards changed.
- Tag names follow the rules above. Invalid input returns 400 `invalid_tag`, `invalid_tag_color`, or `invalid_tag_op`. A source equal to the target returns 400 `same_tag`. A tag that is not in the network returns 404 `tag_not_found`.
- Every successful call writes an audit entry: `requirement_tag_rename`, `_merge`, `_delete`, or `_color`. Its detail includes `affected`.

Who may call it: the same people who can manage projects, meaning the network owner, Hub admins, and members whose task access is **All tasks**. A member limited to related tasks (`task_access = scoped`) gets 403 `permission_denied`, and so does a viewer. A node token gets 403 `user_token_required`.

A scoped member is refused outright rather than allowed to change only the cards they can see, for two reasons. The tag would be split into an old half and a new half. And `affected` would reveal how many cards they cannot see. For a scoped member, `counts` and `colors` also cover only tags on cards they can see.

## See also

- [Tasks](/en/guide/tasks)
- [Requirements / task board](/en/api/mcp-tools#requirements-task-board)
