# CommHub v0.9.0-preview.93

This release carries the Hub changes merged since `0.9.0-preview.92`. Production is on `0.9.0-preview.92`. It is built from main at 147b090d.

- #2275 (bc9a5b72) **Node permission mode is visible to clients (#489).** `GET /api/nodes` rows carry `permission_mode` and `viewer_can.permission_mode` (true when the caller may change it: node owner, network owner/admin, Hub admin). `/health` `capabilities` gains `node_permission_mode`.
- #2277 (147b090d) **`tools/list` per caller (#478).** A token only lists the MCP tools it can actually call. Node tokens no longer list human-only tools or protocol tools (send `X-Anet-Tools: all` to get the full node list); user tokens no longer list node/protocol tools. `tools/call` behaviour is unchanged. No real client reads the Hub's `tools/list`; the release compatibility replay now compares the node + user union.
- **Department groups (RFC-042, #457):**
  - #2280 (1ffc0e4b) A chat group per department. `POST/GET /api/networks/:id/departments/:dept/group` (owner/admin/Hub admin or a head of that department or a parent), `GET /api/networks/:id/chat-groups[/:gid]`. Agents (node tokens) are never members and get `403 humans_only`; non-members get 404.
  - #2281 (73588497) Membership follows the org chart in the same transaction (move person, change parent or head, create/delete department, remove from network). Manual members: add/remove, rename the group; department-sourced members cannot be removed by hand (409).
  - #2282 (e6abd70a) Group messages: send, history with `before=<seq>` paging, `client_request_id` dedup, per-member read position and unread counts, live `group_message` / `group_read` events. `GET /api/dm/threads` gains `group_threads`. Attachments in a group are readable by current members; a DM-only file cannot be unlocked by posting it into a group.
  - #2284 (68436281) For clients: `last_message` preview on group rows, `username` / `display_name` on member rows, `viewer_can: {manage, post}` on group objects, and `chat_groups` in `/health` `capabilities`.
- Tests/docs only: #2276 (test629 installs from the lockfile), #2279 (RFC-040 accepted, department-head docs).

Migration: additive only — new tables `chat_groups`, `chat_group_members`, `chat_group_messages`, `chat_group_reads`. No existing column changes.

Checked in Docker with `tests/hub-release-compat`, candidate 147b090d8936c814dbfc454367677f6af4d2a1bf, baseline `0.9.0-preview.92` from npm, apps 0.2.166 / 0.2.181 / 0.2.196, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, unexpected=0, check_failures=0 each. MCP `tools/list` (node + user union): 74 → 74 tools, no incompatible change, no new params. `dm.threads`: additive `group_threads`.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.
- A copy of a real database (29 users, 55,773 tasks) upgraded to the candidate, rolled back to `.92` and re-upgraded; every start answered `/health`; `integrity_check` ok.
- The packed server (`npm pack` of `server/` at the candidate, global install into a throwaway prefix) starts and answers `/health` in under a second.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.93`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.93
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.93
```

The new tables are created on first start. Existing apps keep working: older apps ignore `group_threads` and never read `tools/list`.

## Rolling back

`0.9.0-preview.92` starts on a database that `.93` has run on: it ignores the `chat_group*` tables. Department groups and their messages are not reachable while rolled back and come back on re-upgrade.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
