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

## See also

- [Tasks](/en/guide/tasks)
- [Requirements / task board](/en/api/mcp-tools#requirements-task-board)
