# REST API: Administration

Part of the [REST API reference](/en/api/rest): tokens, network members, files, node rename, debugging and legacy endpoints. Shared conventions (address, auth, error format) are on the [overview](/en/api/rest).

## Token Management Endpoints

**Requires a user token.** A node token cannot list, mint, or revoke tokens. The response is 403 `user_token_required`.

### POST /api/auth/node-token


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Create a network-bound `ntok_` for a node. `anet node create` calls this automatically and writes the result into `.anet/nodes/<node-name>/config.json` `token` field.

```bash
curl -X POST http://localhost:9200/api/auth/node-token \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"network_id": "net_xxx", "node_name": "coder-1"}'
```

**Response** (success):

```json
{
  "ok": true,
  "token": "ntok_xxxxxxxxxxxxxxxx"
}
```

The `token` is the `ntok_` for that `(node_name, network_id)` pair. The hub force-binds the `network_id` to the token — when an agent calls MCP with this token, the server locks operations to that network and rejects cross-network access. See [Tokens — ntok_](/en/guide/account-system#tokens) for more.

**Common 4xx errors** (verify [`auth.ts createNetworkTokenForNode()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) + [`server.ts` route](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)):

Node identity uses exact bindings. Both name-only and explicit `node_id` issuance check same-network alias conflicts. A new name-only credential binds on its first successful registration. Refreshing an existing identity requires its owner or the same holder's existing valid node credential, and returns an exactly bound credential. Refresh does not backfill a legacy node's owner.

**Intentional behavior change:** when a legacy node has neither an owner nor any historical node credential, an administrator can no longer mint a token merely by knowing its alias. Network administration is not proof of node ownership. This change provides no implicit claim; an explicit, audited administrator-claim workflow is separate future work and is not currently available.

Legacy unbound daemon credentials remain compatible only with a unique network alias. Ownerless legacy nodes accept only pre-upgrade credentials. Duplicate aliases are never resolved by database row order; use an existing exactly bound credential.

The upgrade persists token issuance epochs. Upgrade all token issuers together, including the CLI that writes directly to the database. Do not mix old Hub versions or issuers with new ones, and do not roll back to an old issuer: newly issued credentials could be mistaken for legacy ones. Preserve this field in database backups and recover using a version containing this fix. This compatibility layer is not an end-to-end certification of message attribution or SSE identity.

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `network_id and node_name required` | Body is missing `network_id` or `node_name` |
| 400 | `not a member of this network` | Caller is not in `network_id` (must `join` first to mint an `ntok_`) |
| 400 | `no write access to this network` | Caller is `viewer` (viewers cannot create full-access network tokens) |
| 400 | `node_owner_mismatch` | Alias conflict, ambiguous identity, or unauthorized holder |
| 400 | `node_owner_unclaimed` | Explicit ownerless legacy node has no same-holder credential evidence; no implicit claim |
| 401 | `auth required` / `invalid token` | Missing / invalid utok_ |

### POST /api/auth/tokens


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Create an API token.

```bash
curl -X POST http://localhost:9200/api/auth/tokens \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "network_id": "net_xxx"}'
```

**Response**:

```json
{
  "ok": true,
  "token": "atok_xxxxxxxxxxxxxxxx",
  "token_id": "tok_abc123def456"
}
```

::: warning The plaintext token is returned only once
The `token` field is the plaintext token, **returned exactly once at creation** — the hub stores only its hash. If you lose it, use [DELETE /api/auth/tokens/:id](#delete-api-auth-tokens-id) to revoke + create a fresh one.
:::

::: info This endpoint creates the legacy `atok_`
This path goes through [`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) — grep `generateToken` (3 sites), which issues an `atok_` prefix + `scope='full'` token — a V2-era compatibility path, not the v0.8 mainline (`utok_` / `ntok_`). For new code:
- **`utok_` (user token)**: issued automatically by [POST /api/auth/login](/en/api/rest#post-api-auth-login) or [POST /api/auth/register](/en/api/rest#post-api-auth-register)
- **`ntok_` (network token)**: created via [POST /api/auth/node-token](#post-api-auth-node-token) (bound to a network + node alias)

See [Token system](/en/guide/account-system#tokens) for the full picture.
:::

### GET /api/auth/tokens


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

List all user tokens.

```bash
curl http://localhost:9200/api/auth/tokens \
  -H "Authorization: Bearer utok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "tokens": [
    {
      "token_id": "tok_abc123def456",
      "name": "node:coder-1",
      "scope": "network",
      "network_id": "net_xxxxxxxx",
      "last_used_at": "2026-04-12 10:00:00",
      "created_at": "2026-04-10 09:00:00"
    },
    {
      "token_id": "tok_xyz789",
      "name": "user-login",
      "scope": "user",
      "network_id": null,
      "last_used_at": null,
      "created_at": "2026-04-12 10:30:00"
    }
  ]
}
```

The 6 fields per row map directly to [`auth.ts` `listTokens`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L466) `listTokens` SELECT: `token_id / name / scope / network_id / last_used_at / created_at`. `scope` is one of `user` (utok\_) / `network` (ntok\_) / `full` (legacy atok\_); `network_id` is only set for `network` / `full` scope. Sorted by `created_at DESC`. The plaintext `token` field is **not** returned here (only at POST creation).

### DELETE /api/auth/tokens/:id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Revoke a token (immediate server-side invalidation). `anet logout` revokes the current **login session** instead (via [`DELETE /api/auth/sessions/:token_id`](/en/api/rest#sessions)) and does not revoke explicit API tokens.

```bash
curl -X DELETE http://localhost:9200/api/auth/tokens/tok_xxx \
  -H "Authorization: Bearer utok_xxx"
```

**Response** (success):

```json
{ "ok": true }
```

**4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 404 | `token not found` | `token_id` does not exist or does not belong to the current user ([`auth.ts` `revokeToken`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L518) `DELETE ... WHERE token_id=?1 AND user_id=?2` affects 0 rows) |

Writes audit log `action='token_revoked'`. After revocation, the next request using that token returns 401 `invalid token`.

---

## Network Member Endpoints

**Requires a user token.** A node token cannot list, invite, join, change roles, or remove members. The response is 403 `user_token_required`.

### GET /api/networks/:id/members

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Get network member list (owner / admin only).

```bash
curl http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx"
```

**Response**:

```json
{
  "ok": true,
  "members": [
    {
      "user_id": "u_abc123",
      "username": "alice",
      "display_name": "Alice",
      "role": "owner",
      "joined_at": "2026-04-12 10:00:00"
    },
    {
      "user_id": "u_def456",
      "username": "bob",
      "display_name": "Bob",
      "role": "member",
      "joined_at": "2026-04-15 14:30:00"
    }
  ]
}
```

`anet network members` CLI renders this response (using `m.display_name || m.username` for the name, with a role emoji icon).

### POST /api/networks/:id/members

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Add a member to the network (owner / admin only; the invite flow is usually smoother — see [POST /api/networks/:id/invite](#post-api-networks-id-invite) to issue a code that the recipient can redeem).

```bash
curl -X POST http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u_def456", "role": "member"}'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `user_id` | string | &check; | Target user ID |
| `role` | enum | | `admin` / `member` / `viewer` (default `member`) |
| `agent_access` | enum | | `granted` (default, only granted agents) / `all` (fully trusted member); see [Users & Agent Access Endpoints](#users-agent-access-endpoints) |

**Response** (success):

```json
{ "ok": true }
```

**Common 4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 403 | `not a member of this network` | Caller is not a member of the network |
| 403 | `owner/admin required` | Caller is `member` / `viewer` — cannot add members |
| 400 | `user already a member` | `user_id` is already in the network |

Writes audit log `action='member_added'`; the `detail` column records `<user_id> as <role>`.

### PUT /api/networks/:id/members/:user_id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Change a member's role (owner only; cannot change the owner's own role).

```bash
curl -X PUT http://localhost:9200/api/networks/net_xxx/members/u_def456 \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `role` | enum | &check; | New role: `admin` / `member` / `viewer` (cannot promote to `owner`) |

**Response** (success):

```json
{ "ok": true }
```

**Common 4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 403 | `not a member of this network` | Caller is not a member of the network |
| 403 | `owner required` | Only owner can change roles (admin cannot) |
| 400 | `cannot assign owner role` | `role` is `owner` — server rejects (owner is obtained by creating the network, not by promotion) |
| 400 | `member not found or is owner` | Target `user_id` is not in the network, or is the owner (owner role is immutable) |

Writes audit log `action='member_role_changed'`; the `detail` column records `<user_id> → <new_role>`. This is the endpoint that FAQ Q17 mentions for "changing roles".

### DELETE /api/networks/:id/members/:user_id

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Remove a member (owner / admin only; cannot remove the owner).

```bash
curl -X DELETE http://localhost:9200/api/networks/net_xxx/members/u_def456 \
  -H "Authorization: Bearer utok_xxx"
```

**Response** (success):

```json
{ "ok": true }
```

**Common 4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 403 | `not a member of this network` | Caller is not a member of the network |
| 403 | `owner/admin required` | Caller is `member` / `viewer` — cannot remove members |
| 400 | `not a member` | Target `user_id` is not in this network |
| 400 | `cannot remove owner` | Target is the owner (delete the whole network to remove the owner — see [DELETE /api/networks/:id](/en/api/rest#delete-api-networks-id)) |

Writes audit log `action='member_removed'`; the `detail` column records `<user_id>`.

In the same transaction, every token the removed user holds **for this network** is revoked (node tokens and invite-code tokens get `revoked_at` set to now; their tokens for other networks are untouched). Even for older tokens left behind without revocation, the Hub only accepts a network token while its user is still a member of that network: a non-member's token gets 401 with `reason: "not_network_member"` on every REST / MCP / SSE path. A restricted member's network token (Agent access limited to granted Agents) is likewise 401 with `reason: "node_owner_restricted"`; both carry a `hint` saying how to recover.

### POST /api/networks/:id/invite

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Create an invite code.

```bash
curl -X POST http://localhost:9200/api/networks/net_xxx/invite \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"role": "member", "max_uses": 5, "expires_days": 7}'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `role` | enum | | `admin` / `member` / `viewer` (default `member`) |
| `max_uses` | number | | Max usage count (default `1`; `-1` for unlimited) |
| `expires_days` | number | | Expiration in days (omit for never-expire) |

**Response** (success):

```json
{
  "ok": true,
  "invite_code": "inv_abc123def456"
}
```

**Common 4xx errors** (verify [`auth.ts createInvite()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) + [`server.ts` route handler](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `invalid role` | `role` is not one of `admin` / `member` / `viewer` |
| 403 | `not a member of this network` | Caller is not a member of the network ([`server.ts` callerRole gate](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)) |
| 403 | `owner/admin required` | Caller is `member` / `viewer` — cannot issue invites |

The recipient joins via `anet network join inv_abc123def456` or `POST /api/networks/join`. `invite_code` is `inv_` prefix + 12 characters (`auth.ts` `createInvite` `slice(0, 12)`).

### POST /api/networks/join


> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Join a network with an invite code.

```bash
curl -X POST http://localhost:9200/api/networks/join \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"invite_code": "inv_abc123def456"}'
```

**Response** (success):

```json
{
  "ok": true,
  "network_id": "net_abc123",
  "role": "member"
}
```

**Common 4xx errors** (verify [`auth.ts joinByInvite()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)):

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `invalid invite code` | `invite_code` does not exist |
| 400 | `invite code fully used` | `used_count >= max_uses` (max_uses=-1 means unlimited) |
| 400 | `invite code expired` | `expires_at < now()` (omit `expires_days` to create a never-expire code) |
| 400 | `already a member of this network` | Caller is already a member |

After receiving this response, the `anet network join` CLI auto-switches to the joined network (updating the `network_id` field in `~/.anet/config.json` to `res.network_id`) and prints `Joined network as <role>`. The server also auto-issues a network-bound token for the joiner ([`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) — grep `"auto-join", "full"`, `name='auto-join' scope='full'`) and writes a `network_joined` audit row.

---

## Users & Agent Access Endpoints

**Requires a user token.** A node token calling these endpoints gets 403 `user_token_required`.

Multi-user accounts: a hub admin (or a network owner / admin) creates accounts, and a new member **sees no agents by default** until agents are granted one by one. Human-to-human direct messages are not affected.

**Rule** (`server/src/agent-access.ts`): a user whose network `role` is `member` / `viewer`, whose `agent_access` is not `all`, and who is not a hub admin is a **restricted member**. A restricted member:

- sees only the agents granted to them (`/api/status`, `/api/nodes`, MCP `get_all_status` / `get_session_status`, the requirements people picker);
- can send tasks / messages only to granted agents with `can_message=true`, always as their own username;
- tasks and task events (`/api/tasks`, `/api/tasks/:id`, `/api/task_events`, MCP `list_tasks` / `get_task`): if they can see an agent (directly or through a group grant), they see its **whole timeline** — whoever sent each message (including the owner and other members), and including history from before the grant — the same view the owner gets for that node (#563). Rows whose other side is an agent they **cannot** see stay hidden. Inbox rows (`/api/messages`, alias branch) are still limited to their own exchange with a granted agent;
- cannot subscribe to an agent's SSE channel (even a granted one — that channel carries everyone's tasks to it); the network observer stream carries routing events they are part of, plus routing events on a granted agent's timeline (not those whose other side is an agent they cannot see);
- cannot hold network tokens (`ntok_` / invite tokens): minting is refused, and tokens issued before the restriction stop resolving;
- can download only files they uploaded, files the other side (a granted agent, a DM sender) attached for them, and attachments other people or the agent put on messages in a granted agent's timeline, and cannot forward a `file_id` they cannot see to an agent;
- gets **fail-closed** behaviour on every other agent-facing endpoint (node config / logs / files / rules / rename / schedules / node creation / broadcast / stats): nothing is returned for the restricted network and writes are 403; MCP tools outside the allow-list return `agent_access_restricted`.

- **Granted ≠ administer**: even for a granted agent, a restricted member cannot read or write its rules file / skills / project files / run log, change its config, rename, start or stop it — a grant means "can see it and talk to it";
- a schedule acts on behalf of its creator: once the creator is restricted and not allowed to message the target agent, the schedule stops dispatching (run `error_code=creator_access_revoked`);
- if a member's username collides with an agent alias registered after they joined, their username channel, "own traffic" and granted agents' timelines in that network are closed, because "sent to them" and "sent to that agent" can no longer be told apart.

Owners / admins and hub admins are unaffected. **Membership rows that existed before the upgrade** default to `agent_access='all'`, so nobody's visibility changes on upgrade; members / viewers added afterwards (admin-created, `POST /members`, invite codes) default to `granted`.

⚠️ Granting an agent means trusting that person with whatever the agent can do (the agent's own network token can read files in the network and call tools).

### POST /api/admin/users

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) (`adminCreateUser`)

Creates a user with the same rules as `/api/auth/register` (username 2–50 chars, password ≥ 8 and not a common one, a personal network is created) but **returns no tokens** — the user gets tokens by logging in.

- Hub admin: `network_id` optional;
- Network owner / admin: must pass a `network_id` they manage (the new user joins it); a network admin cannot create `role=admin` members.

```bash
curl -X POST http://localhost:9200/api/admin/users \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"<at least 8 chars>","display_name":"Alice","network_id":"net_xxx","role":"member"}'
```

**Response**:

```json
{ "ok": true, "user": { "user_id": "u_abc", "username": "alice", "role": "user" }, "personal_network_id": "net_own", "membership": { "network_id": "net_xxx", "role": "member", "agent_access": "granted" } }
```

| Status | `error` | When |
|------|---------|------|
| 400 | `username already taken` / `password must be at least 8 characters` / `password is too common` | register() rules |
| 403 | `admin required` / `owner/admin required` | caller not allowed |
| 404 | `network_not_found` | unknown `network_id` |
| 409 | `username_collides_with_agent_alias` | the username equals an agent alias in that network (user channels are addressed by username); the account is not created |

Writes audit log `admin_user_created` (`admin_user_create_denied` when refused).

### GET /api/admin/users

Hub admin only. Returns every user with `networks: [{network_id, network_name, role, agent_access}]`; no password hashes.

### GET / PUT /api/networks/:id/members/:user_id/agent-grants

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/agent-access.ts) (`replaceAgentGrants`)

Read / replace the agents a member can access. Owner / admin / hub admin; a network admin cannot change an owner or another admin. User tokens only.

```bash
curl -X PUT http://localhost:9200/api/networks/net_xxx/members/u_abc/agent-grants \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"grants":[{"node_id":"node_x"},{"node_id":"node_y","can_message":false}]}'
```

| Field | Type | Notes |
|------|------|------|
| `grants` | array | Each item `{node_id}` or `{alias}` (only for legacy sessions without a node_id) + optional `can_message` (default `true`). A plain array of `node_id` strings is also accepted. Replaces the whole set |
| `agent_access` | `all` \| `granted` | Optional. `all` lifts the restriction (legacy semantics), `granted` restricts to grants |
| `group_grants` | array | Optional. Grants to [agent groups](#agent-groups): each item `{group_id}` + optional `can_message`; a plain array of `group_id` strings is also accepted. **Omitted = unchanged** (older clients send only `grants` and cannot wipe group grants); when present it replaces the whole set |

Any item that is not an agent of this network → 400 `agent_not_in_network`; a group from another network → 400 `group_not_in_network`; nothing is written. On success writes audit log `member_agent_grants_changed` and drops the member's open observer / user streams so they reconnect under the new access.

Visible = direct grants ∪ the current members of granted groups; `can_message` is the union (any source granting it counts).

**Response**: `{ ok, network_id, user_id, agent_access, restricted, grants: [{node_id, alias, can_message}], group_grants: [{group_id, name, can_message}] }` (GET also returns `role`).

### Agent groups {#agent-groups}

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/agent-access.ts) (`createAgentGroup` / `replaceAgentGroupMembers` / `deleteAgentGroup`) · design: RFC-038 §8

Admin-defined sets of agents. Once a group is granted, **agents added to it later become visible automatically** (computed per request). Owner / admin / hub admin, user tokens only; ordinary and restricted members get 403 (they only see the agents they can reach).

| Method · path | Notes |
|---|---|
| `GET /api/networks/:id/agent-groups` | `{ groups: [{group_id, name, description, node_ids, member_count, granted_user_count, …}] }` |
| `POST /api/networks/:id/agent-groups` | `{name, description?, node_ids?}`; a duplicate name in the network → 409 `group_name_taken` |
| `PATCH /api/networks/:id/agent-groups/:group_id` | `{name?, description?}` |
| `PUT /api/networks/:id/agent-groups/:group_id/members` | `{node_ids}` replaces the members; response has `added` / `removed` |
| `DELETE /api/networks/:id/agent-groups/:group_id` | Deletes the group and every grant on it; response `affected_user_ids` |

A node outside the network → 400 `agent_not_in_network`, nothing is written. Audit: `agent_group_created` / `agent_group_renamed` / `agent_group_members_changed` (diff only) / `agent_group_deleted`, all with `network_id`. When a group or its members change, members granted that group have their live streams dropped so they reconnect under the new access. `GET /api/networks/:id/members` also returns `agent_group_count` per member.

### GET /api/networks/:id/humans

Any member (restricted ones included): the network's human directory, with only `user_id` / `username` / `display_name`, for picking a DM recipient (DMs go through MCP `send_desktop_message`).

User tokens also get each person's presence: `online` (whether they have a live `/events/users/me` user stream right now, per person, across networks) and `last_seen_at` (ISO; refreshed on connect / keepalive / disconnect; kept in hub memory only, so it is `null`, meaning unknown, for anyone who has not connected since the hub restarted). Node tokens still get only the three identity fields above.

When a person's first user stream connects or their last one disconnects, the hub pushes `{"type":"member_presence","member_user_id","online","last_seen_at"}` to the other members with a live user stream in every network that person belongs to (`user_id` in the event is the recipient). Older clients ignore unknown event types.

### POST /api/dm · GET /api/dm · GET /api/dm/threads {#human-dm}

Human-to-human direct messages between two users of the same network (restricted members included). User tokens only.

- `POST /api/dm` `{network_id?, to_user_id | to_username, message, attachments?, client_request_id?}` — written to the recipient's user_inbox (`kind=human_dm`) and pushed over `/events/users/me`; the hub records `sender_user_id` from the token and ignores any `from` in the body. Retrying with the same `client_request_id` does not create a second message. Unknown users and users outside the network both get 404 `dm_target_not_in_network`. A restricted member attaching a file they cannot see gets 403 `attachment_not_accessible`, and so does anyone attaching a DM file they cannot see (uploaded with `purpose=dm`, and they are neither the uploader nor in a DM that carries it). Upload DM attachments with `POST /api/upload?purpose=dm`.
- `GET /api/dm?network_id=&with=<user_id>[&limit&before]` — both directions with that person, newest first, each row with `direction: in | out`.
- `GET /api/dm/threads?network_id=` — one row per counterpart: `{other_user_id, last_at, unread}`. Also `group_threads`: one row per department group I am in, `{group_id, name, department_id, last_at, unread, last_read_seq, last_message}`, where `last_message` is `{text (first 80 chars; empty when the message is attachments only), attachment_count, sender_user_id, sender_name, at}` or `null`. Group endpoints exist when the hub's `/health` `capabilities` contains `chat_groups`.

Mark read with `POST /api/messages/ack` (a DM is a row in the recipient's user_inbox).

Each `GET /api/networks/:id/members` item also carries `agent_access` (effective value) and `agent_grant_count`; `POST /api/networks/:id/members` accepts an optional `agent_access` (default `granted`); `GET /api/auth/me` `networks[]` carries `agent_access`, which clients use to show "no agents assigned yet, ask an admin".

## File Endpoints

Attachment (image, etc.) upload / download — backs Dashboard image sending, commhub attachments, codex-sdk image input, and the like. Both endpoints require `Authorization: Bearer <token>`.

### POST /api/upload

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Uploads a file and returns a downloadable `url`.

- Request: `multipart/form-data` with a `file` field; a `Content-Length` header is required.
- Size cap **12 MiB** (`MAX_UPLOAD_BYTES`), checked in two stages: fail-fast on `Content-Length`, then re-verify the parsed size.
- Rate limit: **60/hour** (keyed by token id, falling back to IP); over the limit returns `429 rate_limited` (with `X-RateLimit-*` headers).
- `?purpose=dm` (optional): the file is uploaded for a human DM and becomes a **DM file**. Only the uploader, the two sides of any DM that carries it, and Hub admins can download it; other members of the network and node tokens get `404 not_found`. Without `purpose` nothing changes, and a file first used elsewhere (for example in an agent chat) does not become a DM file when it is later forwarded into a DM. Any other value returns `400 bad_purpose`. See [human DMs](#human-dm).

```bash
curl -X POST http://localhost:9200/api/upload \
  -H "Authorization: Bearer utok_xxx" \
  -F "file=@./cover.png"
```

Success `200`:

```json
{ "ok": true, "file_id": "...", "url": "/api/files/<file_id>", "size": 12345, "mime": "image/png" }
```

Common errors: `411 length_required` (no `Content-Length`) · `413 payload_too_large` (over 12 MiB, includes `limit_bytes`) · `415 unsupported_media_type` (not `multipart/form-data`) · `400 missing_file` (no `file` field) · `429 rate_limited`.

### GET /api/files/:file_id

File downloads accept only the `Authorization: Bearer ...` header. To prevent
credential leakage, this endpoint rejects `?token=` URL authentication for both
`GET` and `HEAD` requests.

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Downloads a file returned by `POST /api/upload`. Always forces `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` (the browser won't inline-render it — XSS defense).

```bash
curl -OJ http://localhost:9200/api/files/<file_id> -H "Authorization: Bearer utok_xxx"
```

Common errors: `400 bad_file_id` (malformed id) · `404 not_found` (no index entry) / `404 blob_missing` (indexed but the file is gone from disk).

---

## Node Rename Endpoints (RFC-010)

> Coordination endpoints for the RFC-010 active-rename two-phase transaction, called internally by `anet node rename` (flow: [node-lifecycle §7](https://github.com/sleep2agi/agent-network/blob/main/docs/node-lifecycle.md)). Not normally called by hand — listed here for integrators. All three require `Authorization: Bearer` (missing token 401 / invalid token 401). A node token may rename only itself: the network it is bound to, and the old alias must be the node that token represents. Renaming any other node, or a node in another network, **requires a user token**; otherwise the response is 403 `user_token_required`.

### POST /api/node-rename/prepare

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

PHASE 1: register a rename transaction (old node untouched, fully rollbackable). On success writes a `node_rename_prepared` audit row.

```bash
curl -X POST http://localhost:9200/api/node-rename/prepare \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"network_id":"net_xxx","old_alias":"old-bot","new_alias":"new-bot"}'
```

| Field | Required | Description |
|------|------|------|
| `network_id` | ✅ | Network the node belongs to |
| `old_alias` | ✅ | Current alias |
| `new_alias` | ✅ | Target alias |

**Response**: `{ ok, txn_id }` — `txn_id` is used for the subsequent commit / abort. Missing any of the three fields returns 400.

### POST /api/node-rename/commit

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

PHASE 2 C1: commit the rename transaction (CommHub routing switches to `new_alias`). On success writes a `node_rename_committed` audit row.

```bash
curl -X POST http://localhost:9200/api/node-rename/commit \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"txn_id":"..."}'
```

body `{ txn_id }` is required (missing → 400).

### POST /api/node-rename/abort

> [Source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Roll back the rename transaction (called before C1; old node restored). On success writes a `node_rename_aborted` audit row.

```bash
curl -X POST http://localhost:9200/api/node-rename/abort \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"txn_id":"..."}'
```

body `{ txn_id }` is required (missing → 400).

---

## Tmux Debug Endpoints (opt-in)

::: warning Off by default
Only available when the hub is started with `COMMHUB_ENABLE_TMUX=1` ([`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)). **Otherwise all paths return 404 `tmux disabled`**. Even when enabled, you still need (a) the caller IP to be inside `COMMHUB_TMUX_ALLOWLIST` (comma-separated, defaults to localhost only; verify [`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)) and (b) `users.role = 'admin'` system-admin auth. Intended use: expose tmux sessions running agents on the hub machine to local devs / Dashboard. **Never expose on the public internet.** Public-deploy hardening: [Production §5 Verify tmux control plane is off](/en/deploy/production#_5-verify-the-tmux-control-plane-is-off).
:::

### GET /api/tmux/:name

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Capture the tail of a tmux session's current pane (`tmux capture-pane -t <name> -p` wrapper).

```bash
curl "http://localhost:9200/api/tmux/anet-node-coder-1?lines=50" \
  -H "Authorization: Bearer utok_xxx"
```

**Query parameters**:

| Parameter | Description |
|------|------|
| `lines` | Tail line count (default 30) |

**Response** (success):

```json
{ "ok": true, "tmux_name": "anet-node-coder-1", "lines": 50, "output": "...captured pane content..." }
```

### POST /api/tmux/:name/send

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Send keys into a tmux session (`tmux send-keys -t <name> "<text>" Enter` wrapper).

```bash
curl -X POST "http://localhost:9200/api/tmux/anet-node-coder-1/send" \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"text": "/help", "enter": true}'
```

**Request body**:

| Field | Type | Required | Description |
|------|------|:----:|------|
| `text` | string | &check; | Keys to send |
| `enter` | boolean | | Append Enter (default `true`) |

**4xx errors (shared by both endpoints)**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 404 | `tmux disabled` | `COMMHUB_ENABLE_TMUX=1` not set |
| 403 | `tmux access denied from this ip` | Caller IP outside `COMMHUB_TMUX_ALLOWLIST` (defaults to localhost only) |
| 401 / 403 | Admin auth required (same gate as [GET /api/server-logs](/en/api/rest-data#get-api-server-logs)) |
| 400 | `text is required` (POST only) | Body missing `text` |
| 400 | `<tmux stderr>` | `tmux` subprocess exited non-zero (e.g. session not found) |

### GET /ws/tmux/:name

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

WebSocket endpoint — live-streams a tmux session's pane output. It's the live counterpart of `GET /api/tmux/:name`: the HTTP one is a one-shot `capture-pane`, this one keeps streaming once connected. Auth gating is **identical** to the two HTTP endpoints above (same `requireTmuxAccess` — `COMMHUB_ENABLE_TMUX=1` + caller IP in `COMMHUB_TMUX_ALLOWLIST` + `users.role='admin'` auth; any failure is rejected before the WS upgrade).

```
ws://localhost:9200/ws/tmux/anet-node-code1
```

Once connected the server periodically runs `tmux capture-pane` and pushes the pane content; polling stops automatically on disconnect. Same rule — **never expose this on the public internet**.

---

## Legacy Endpoints (v0.6 era — frozen in OSS)

::: warning Not required since Apache 2.0
Since v0.8 the project is Apache 2.0 open-source + self-hosted — there is no official paid license. The two endpoints below are leftovers from the v0.6 trial/activation flow. The hub still keeps a `licenses` table and an initial 14-day trial as a safety net, but new users and the main docs do not need to touch them. If you hit `license_expired`, see [troubleshooting](/en/troubleshooting#license-expired-license-expired-legacy-behavior).
:::

### GET /api/license

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Reads the first row of the `licenses` table (by `created_at` ascending) and returns trial / pro status with `days_left`.

```bash
curl http://localhost:9200/api/license
# → Public endpoint (no Authorization header required)
```

**Response** (trial / pro):

```json
{
  "ok": true,
  "license": { "type": "trial", "expires_at": "2026-04-25 12:00:00", "days_left": 12, "expired": false },
  "limits": { "max_agents": 5, "max_networks": 3, "max_tasks_day": 500 }
}
```

**Response** (no license row):

```json
{ "ok": true, "status": "no_license" }
```

### POST /api/license/activate

> [View source ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

Inject a pro license key. [`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) only checks that `key.startsWith('anet-') && length >= 16` — **there is no real server-side validation**. The endpoint deletes any existing license row and writes a fresh pro license (limits 50 agents / 10 networks / 10000 tasks/day, expires in 365 days).

```bash
curl -X POST http://localhost:9200/api/license/activate \
  -H "Content-Type: application/json" \
  -d '{"key": "anet-anything-16-plus-chars"}'
```

**Response** (success):

```json
{ "ok": true, "type": "pro", "expires_in_days": 365 }
```

**4xx errors**:

| Status | `error` value | Trigger |
|------|------------|---------|
| 400 | `key required` | Body missing `key` |
| 400 | `invalid license key` | `key` does not start with `anet-` or is < 16 chars (**prefix-and-length check only, no real signature**) |

> Effectively a self-service bypass kept around purely so that anyone hitting `license_expired` has an escape hatch in the OSS era. See [troubleshooting — license_expired](/en/troubleshooting#license-expired-license-expired-legacy-behavior) and [CLI `anet activate`](/en/guide/cli#other).

---
