# CommHub v0.9.0-preview.91

This release carries the Hub changes merged since `0.9.0-preview.90`. Production is on `0.9.0-preview.90`. It is built from main at 019da082.

- #2264 (a7d73b02) **MCP context cost (#476).**
  - `requirements_events` without a requirement id (network-wide) now defaults to 50 events per page, newest first, with `next_cursor` for older events. The per-task call and the REST endpoint are unchanged. Parameters are strict: an unknown one returns `-32602` listing the valid ones.
  - `tools/list` is smaller (76.8 KB → 71.4 KB on main before this PR) by trimming repeated parameter descriptions. No tools removed, no schema shapes changed. A test caps the total at 72,500 B.
- #2267 (da61b5c3) **Department heads (RFC-040, #455).**
  - A department head (the department's `leader_user_id`) manages their subtree, computed per request, so it ends the moment they stop being head. Viewers never get it.
  - Heads can create sub-departments anywhere in their subtree, and rename / move / delete / set the head of strict sub-departments. People can be moved only within the subtree. Outside it: `403 department_scope_denied`. Non-heads get the previous 403 body unchanged.
  - Heads can see and edit their department's task cards; a delete made only as head writes a `requirement_deleted_by_leader` audit event and DMs the card owner. Access is a union with existing grants; nothing is revoked.
  - New: `managed_department_ids` on `/api/auth/me`, `viewer_can {manage, create_child}` on departments, department project grants (owner/admin only, covering sub-departments), a read-only department node list, and a `department_id` filter on the task list (also on MCP `requirements_list`).
- #2268 (019da082) **Network tokens require membership (#488).**
  - A network token whose user is no longer a member of that network is rejected at authentication (`401`). Before, REST reads such as `GET /api/status` still answered for a removed member's token.
  - Removing a member revokes that user's tokens for the network in the same transaction.
  - A restricted owner's node token now gets a `401` with reason `node_owner_restricted` and a hint, instead of a bare `unauthorized`.

Migration: one new table, `network_department_project_grants`. No existing table or column changes.

Checked in Docker with `tests/hub-release-compat`, candidate 019da082bfdb5603e2da3980b7944de1ffd61118, baseline `0.9.0-preview.90` from npm, apps 0.2.166 / 0.2.181 / 0.2.195, `SCHED_BASELINE=counted CHECK_BYTES=1 EXPECT_BACKFILL=0`:
- A1 and A2: steps=62, check_failures=0 each, unexpected=8 each, all acknowledged:
  - `requirements_events` `additionalProperties` → `false`: the intended #476 strictness.
  - `stop_node`, `restart_node`, `delete_node`, `update_node_config`, `read_node_rules_file`, `write_node_rules_file`, `tail_node_logs`: only the `description` text of `node_id` / `child_node_id` / `alias` changed (#476 trim). Types and required fields are unchanged.
- B, upgrade → rollback → re-upgrade on one database with the byte check: upgrade_check_failures=0.
- The old-app owner coercion tests (`requirements-http`, `requirements-owner-strict-mcp-http`) pass on the candidate: 27/27.
- The packed server (`npm pack` of `server/` at the candidate, global install into a throwaway prefix) starts and answers `/health` in under 1 s.
- Production had 0 live network tokens whose user is not a member, and 0 live tokens of restricted members, so #488 changes nothing for current callers.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.91`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.91
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.91
```

The new table is created on first start. Existing MCP and REST callers keep working, except that a token belonging to someone no longer in its network is now refused.

## Rolling back

`0.9.0-preview.90` starts on a database that `.91` has run on: it ignores `network_department_project_grants`. Department heads lose their extra access, and removed members' tokens revoked by `.91` stay revoked.

Do not overwrite published packages. The package contains no existing data, users, network members or secrets.
