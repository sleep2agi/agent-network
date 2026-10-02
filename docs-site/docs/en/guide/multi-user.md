# Multi-user and permissions

Starting with Hub 0.9.0-preview.68, the server has two behaviors that are already live: which Agents a member can access, and a human-to-human direct-message API inside one network.

User management, registration, and direct messages are in the app starting with 0.2.153. A user who just registered, or one an admin created, sees no Agents by default; an admin has to grant them in User management. Existing accounts, tokens, and the four network roles stay as described in [Accounts, Tokens & Roles](/en/guide/account-system). CLI registration and invite codes are unchanged.

## Which Agents a member can access

A member or viewer added from this version on has `agent_access` `granted` by default: until Agents are granted one by one, they see none in that network. Members who were already in the network before the upgrade stay on `all`, so the upgrade does not change what they can see. Owners, admins, and Hub admins are not limited by this rule.

The network owner or admin, or a Hub admin, replaces the grant list through the API. A grant means the person can see that Agent and talk to it. It does not let them change its config, rules, or logs. The rule and the fields are in [Users & Agent Access Endpoints](/en/api/rest-admin#users-agent-access-endpoints).

## Human-to-human messages

Two users in the same network can message each other with these endpoints. User tokens only:

- `POST /api/dm`
- `GET /api/dm`
- `GET /api/dm/threads`

Starting with app 0.2.153, people in the same network can message each other from People. Fields and errors are in [the same section](/en/api/rest-admin#human-dm).

## A node token cannot administer accounts

From this version on, a node token (`ntok_`) cannot call the account, token, network, or member administration endpoints. Those return 403 `user_token_required`. A node can rename only itself: the network the token is bound to, and the old alias must be the node that token represents. Renaming any other node requires a user token. The API reference marks the affected endpoints with "requires a user token".

## Department heads

Each department in the org chart can have a head. A head manages **their department**: the department they lead and every department below it. There is no new role. Head status is worked out from the department's head field on every request, so removing someone as head takes their powers away on the very next request. A viewer who is a head gets no powers.

What a head can do, inside their department only:

- Create sub-departments under it; rename, move, delete (empty ones only), and change the head of those sub-departments. The department they lead themselves is changed by the head above them or by an admin.
- Move people between the sub-departments. Moving people into or out of the department, including to "unassigned", is admin-only.
- See, edit, and delete the department's task cards. A department card is one whose owner is a department member, or whose Agent owner belongs to a department member. When a head edits a card only because they are head, they can hand it only to department members, themselves, or department members' Agents. When they delete a card only because they are head, an audit event `requirement_deleted_by_leader` is written and the card's owner gets a direct message; if the card has no owner, the owner of its Agent does.
- View the status and health of department members' Agents, read-only. Dispatching to an Agent or talking to it still follows Agent grants, and only the node's owner and admins can manage it.

A write outside the department returns 403 `department_scope_denied`. A member who is not a head gets the same 403 `owner/admin required` as before.

**Department project grants**: an owner or admin can grant a project to a department, and the grant also covers every department below it. As with grants to a person, a grant lets people see the project's cards, and `can_edit` lets them edit them.

**Added on top of existing permissions**: head powers and department grants only ever add access. They never take away anyone's per-person grants, task scope, or participant rights. Members whose task scope is "all tasks", owners, and admins behave as before. Node tokens are not affected by departments.

Endpoints:

| Endpoint | What it does |
|---|---|
| `GET /api/auth/me` | `networks[].managed_department_ids`: the departments you manage, sub-departments included; an empty array means you are not a head |
| `GET /api/networks/{id}/departments` | Each department gets `viewer_can: {manage, create_child}`; owners and admins also get `project_grants` |
| `POST / PATCH / DELETE /api/networks/{id}/departments[/{dept}]`, `PUT /api/networks/{id}/members/{uid}/department` | Owners and admins, or a head inside their department |
| `GET / PUT /api/networks/{id}/departments/{dept}/project-grants` | Department project grants. `PUT` replaces the whole list `{project_grants: [{project_id, can_edit}]}`. Owners and admins only; if any project is not in the network, nothing is written and it returns 400 |
| `GET /api/networks/{id}/departments/{dept}/nodes` | Nodes owned by members of the department and its sub-departments: alias, status, health, owner. Read-only. Heads, owners, and admins |
| `GET /api/requirements?department_id=` | Only cards whose owner is in that department (sub-departments included), or whose Agent belongs to such a person, within what the caller can see. Also a `requirements_list` parameter in MCP |

The design and its trade-offs are in RFC-040.

## A node's own permissions

A node's (Agent's) permissions are a subset of its **owner's**, narrowed further by the node's own **mode**. The owner is `nodes.owner_user_id` of the node the token is bound to. For an older token that is not bound to a node, the owner is the user who minted it.

There are three modes. The default is `normal`, so upgrading changes nothing for any node:

| Mode | What the node can do |
|---|---|
| `normal` | Same as today. Whether it is narrowed to the owner's permissions depends on the Hub switch (below) |
| `readonly` | Read, report status, reply to tasks sent to it. Writing tasks, dispatching, broadcasting and managing nodes are refused |
| `restricted` | Only sees and edits task cards assigned to it: it is the Agent owner, a participant or the creator, plus subtasks of those cards. A card it creates must name itself as the Agent owner. It can dispatch only to Agents granted to its owner. It cannot broadcast, or subscribe to another session's stream or the network stream |

**A mode takes effect as soon as it is set**, regardless of the switch. Only the node's owner, a network owner/admin, or a Hub admin can change it. A node token cannot change its own mode, and neither can a department head:

```
PUT /api/nodes/{node_id}/permission-mode   {"mode": "normal" | "readonly" | "restricted"}
```

The response is `{ok, node_id, permission_mode, previous}`, and the change writes the audit entry `node_permission_mode_changed`. Errors:

- A caller who is not a member of the node's network gets 404.
- A member who is neither the owner nor an owner/admin gets 403 `permission_denied`.
- A node token gets 403 `user_token_required`.
- An unknown mode gets 400 `invalid_permission_mode`.

Every row of `GET /api/nodes` gains `permission_mode`.

**Narrowing in normal mode is logged first and enforced later.** It is controlled by the Hub environment variable `COMMHUB_NODE_PERMISSIONS`:

| Value | Behaviour |
|---|---|
| `log` (default) | Allow as before. Each would-be denial is merged per (node, route, reason, hour) into `node_permission_log` |
| `enforce` | Log and refuse |
| `off` | Normal mode is neither evaluated nor logged. Explicit read-only/restricted modes still apply |

Reason codes for normal mode:

- `beyond_owner_visibility`: a task card the owner cannot see or edit.
- `agent_not_granted_to_owner`: an Agent not granted to the owner.
- `human_only`: something only people may do (editing another node, creating or updating projects, writing providers or network secrets, reviewing skills).
- `owner_unknown`: the owner is unknown.

Explicit modes use `mode_readonly` and `mode_restricted_not_assigned`.

A refusal is a 403 over REST; MCP returns the same body:

```json
{"ok": false, "error": "node_permission_denied", "reason": "mode_readonly", "route": "PATCH /api/requirements/:id", "hint": "…"}
```

**Report**: a network owner/admin (user token) can see how many times each node would have been blocked. The default window is 7 days:

```
GET /api/networks/{id}/node-permission-report?since=<ISO time>
```

The response is `{ok, network_id, since, mode, total, nodes: [{node_id, alias, permission_mode, total, by_reason, routes: [{route, reason, hits, sample, last_hour}]}]}`. `mode` is the current switch. Log rows are kept for 30 days, up to 20,000 rows. Once that cap is reached, only existing rows have their counts incremented.

See RFC-041 for the design and trade-offs.

## See also

- [Accounts, Tokens & Roles](/en/guide/account-system)
- [REST: Administration](/en/api/rest-admin)
- [REST API reference](/en/api/rest)
