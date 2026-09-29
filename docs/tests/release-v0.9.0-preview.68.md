# CommHub v0.9.0-preview.68

This release carries 4 Hub changes, all already on main (merge order):

- #2097 (d52406e90f02d9ec2ea9a09590b54379a22a051f) **Task tags.** A requirement can have up to 10 tags of up to 20 Unicode characters each.
  `PATCH` without `tags` keeps them and `tags: []` clears them. An invalid tag returns 400 `invalid_tags`.
  New `GET /api/requirements/tags` returns the tags used in the network. REST and the existing MCP write tools both accept tags.
- #2103 (5a38a71294ead5a3e6c82f72aa5cc92ba6773e45) **`archived=true` lists only archived requirements**, and wins over `include_archived=1`.
  The default listing and `include_archived=1` on its own are unchanged.
- #2084 (8cbb138e65f0164eaa2d177b923d14db943c567c) **Multi-user accounts and per-member agent access (slice 1).**
  Admins can create users (`POST /api/admin/users`). A member or viewer added **after** this upgrade sees no agents until an owner or admin grants them specific ones.
  Membership rows that exist before the upgrade are migrated to `agent_access='all'`, so nobody loses access they have today.
- #2086 (82417286d4d095d06fdf2ade14f9cec428c8e9dd) **Agent access slice 3, human DM API, and a node-token privilege fix.**
  - Remaining agent paths honour grants (scheduled tasks from a creator who lost access, rename fan-out, username/alias collisions).
  - A granted member can see and talk to an agent, but not administer it.
  - Human-to-human DMs: `POST /api/dm`, `GET /api/dm?with=`, `GET /api/dm/threads`.

## 🔴 Security fix: node tokens no longer act as their owner

Before this release, a node token (`ntok_`) resolved to the user who minted it, which in production is almost always the hub admin.
Several endpoints then treated **any node** as that admin. A node could list all users, read server and audit logs, mint user and node tokens,
change the owner's profile and password, create, rename or delete networks, manage members and invites, and read other networks' details
and the full SSE topology.

From .68:
- Account, token, network and member management require a **user token**. A node token gets 403 `user_token_required`.
- Hub-admin status requires a user token everywhere (`/api/users`, logs, admin endpoints).
- For a node token, `/api/stats/sse` is scoped to its bound network, and `/api/auth/me` reports `credential: {kind: "node", …}` and only the bound network.
- A node token may still prepare, commit or abort a rename of **itself** (`anet node rename`). Renaming another node, or anything in another network, is refused.
- Unchanged for nodes: `report_status`, `send_task`, the inbox, SSE, and reading and writing requirements with a node token.

Who could be affected: any script that used a node token for account or network management. `anet` CLI login and `node create` use the user login token and are not affected.

This note is not proof of publication. Publish only by running release.yml from the full main SHA that contains these changes:
package `@sleep2agi/commhub-server`, version `0.9.0-preview.68`, channel preview.

## Install

In an isolated environment you are allowed to install into (the Hub needs Bun), install the exact version:

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.68
```

Startup, secrets and the data directory follow the repository deploy docs. The install command does not by itself switch any production process.

## Upgrade

```sh
npm install -g @sleep2agi/commhub-server@0.9.0-preview.68
```

For an existing instance, the operator backs up the database in an authorised window, then restarts the process with its usual service manager.

Migrations at startup (all additive):
- `requirements.tags_json TEXT NOT NULL DEFAULT '[]'` (#2097).
- `network_members.agent_access TEXT NOT NULL DEFAULT 'all'`. Every existing member row becomes `all` (#2084).
- New table `network_member_agent_grants`, with partial unique indexes on `(network_id, user_id, node_id)` and `(network_id, user_id, alias)` (#2084).
- `user_inbox.sender_user_id` plus index `idx_user_inbox_dm` (#2086).

The package contains no existing data, users, network members or secrets. To roll back, use `0.9.0-preview.67` with a previously prepared data
restore plan. Do not drop production tables or overwrite published packages. After a rollback, the new columns and tables stay in the database,
and .67 neither reads nor writes them.
Rolling back also rolls back the node-token security fix.
