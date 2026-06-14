# Roles & Permissions

::: tip One line
Agent Network has 4 roles: `owner` / `admin` / `member` / `viewer`. **The role embedded in your `utok_` decides which APIs you can call.** After RFC-001 (landed in v0.8), there is no master-key bypass — everything is role-based.
:::

## The 4 roles at a glance

| Role | Typical use | One-liner |
|---|---|---|
| **owner** | Network creator, top of the hierarchy | Manage members + delete network + all admin ops |
| **admin** | Team lead / trusted operator | Add/remove members + hub settings (Note: `/api/audit-log` / `/api/users` and other admin-only endpoints are gated by **system-level** `users.role='admin'`, **not** by network admin — see [hub-global admin](#hub-global-admin-special) below) |
| **member** | Regular team engineer | Create agents, dispatch tasks, see network data (`anet node start/stop/delete` are local ops, not gated by role — see note ※ below) |
| **viewer** | Intern / auditor / read-only integration | Read only, no writes |

---

## Full permission matrix

| Operation | viewer | member | admin | owner |
|---|---|---|---|---|
| **Read** | | | | |
| List tasks (`anet tasks`) | ✅ | ✅ | ✅ | ✅ |
| List agents (`anet status`) | ✅ | ✅ | ✅ | ✅ |
| Read messages / completions | ✅ | ✅ | ✅ | ✅ |
| View audit log (your own rows only) | ✅ | ✅ | ✅ | ✅ |
| View audit log (other users' rows) | Only **system-level** `users.role='admin'` (**not** network admin) | | | |
| **Agent lifecycle** | | | | |
| Create agent (`anet node create`) | ❌ | ✅ | ✅ | ✅ |
| Start / stop / delete agent (`anet node start/stop/delete`) | Not gated by network role — see note ※ below | | | |
| **Tasks** | | | | |
| Dispatch `send_task` | ❌ | ✅ | ✅ | ✅ |
| `cancel_task` | ❌ | ✅ | ✅ | ✅ |
| `reassign_task` | ❌ | ✅ | ✅ | ✅ |
| **Member management** | | | | |
| Invite (`anet network invite`) | ❌ | ❌ | ✅ | ✅ |
| Change member's role | ❌ | ❌ | ❌ | ✅ |
| Remove member | ❌ | ❌ | ✅ (not owner) | ✅ |
| **Network** | | | | |
| Create network | Any logged-in user (creator becomes owner) | | | |
| Rename network | ❌ | ❌ | ❌ | ✅ |
| Delete network | ❌ | ❌ | ❌ | ✅ |
| **Hub-global** (system-level `users.role` gate, **not** network role) | | | | |
| `/api/audit-log` — your own rows | ✅ | ✅ | ✅ | ✅ |
| `/api/audit-log` — all rows | Only `users.role='admin'` (verified at [`server/src/index.ts:1086-1089`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1086)) | | | |
| `/api/users` (list users) | Only `users.role='admin'` (same system-level gate) | | | |
| `/api/server-logs` (debug console) | Only `users.role='admin'` | | | |
| `/api/admin/wipe-db` (and similar) | Only `users.role='admin'` | | | |
| `anet hub admin reset-user` (reset any user's password) | Local-only CLI command on the hub host, not role-gated (the hub owner just needs local shell access) | | | |

> ※ `anet node start / stop / delete` are **pure local CLI operations** — they read/write the local `.anet/nodes/<alias>/` directory directly, and `startCommand` / `deleteCommand` have **no network-role / owner / per-creator check** whatsoever. Whoever has that node config on their machine can start/stop/delete it, regardless of their network role. The only network-role-gated lifecycle op is `anet node create` (it requests an `ntok_` from the hub, and `canWrite` blocks viewer).

> the three MCP write tools `send_task` / `cancel_task` / `reassign_task` pass through **a single [`canWrite` gate](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L24)** (`role !== "viewer"` — owner/admin/member all pass) with **no per-task ownership check** — a member can cancel / reassign **any** task in the network, not just ones they dispatched. Renaming a network is owner-only ([`auth.ts:218 renameNetwork`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L218) `if (net.owner_id !== userId)`), same as deleting it — admin cannot rename.

---

## Each role in detail

### viewer

For interns, auditors, read-only integrations.

- **Can**: any read endpoint (tasks, agent status, messages, completions), browse dashboard, **view their own audit log rows** .
- **Cannot**: any **network-level write op** (dispatch / `cancel_task` / `reassign_task` / `anet node create` — all blocked by the `canWrite` gate); read **other users'** `/api/audit-log` rows (cross-user access needs system-level `users.role='admin'`).

  > Note: `anet node start / stop / delete` are **pure local CLI operations**, not gated by network role (see note ※ on the permission matrix above) — a viewer can still start/stop/delete an existing node on their own machine. Only `anet node create` is network-role-gated (it requests an `ntok_` from the hub).

Become a viewer:
```bash
anet network invite --role viewer --uses 1
```

### member

For engineers doing production work inside a team.

- **Can**: everything viewer can; create their own agents (`anet node create`); start / stop / delete own agents; dispatch / cancel / reassign tasks (`send_task` / `cancel_task` / `reassign_task` — all gated only by `canWrite`, so a member can cancel/reassign **any** task in the network, not just their own).
- **Cannot**: modify someone else's agents; manage members; hit admin endpoints.

Become a member:
```bash
anet network invite --role member --uses 5      # default role is member
anet network join <code>
```

### admin

For team leads, trusted operators, anyone who needs to manage members.

- **Can**: everything member can; invite new members + remove non-owner members (invite [`index.ts:695`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L695) / remove [`index.ts:681`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L681): `["owner","admin"]` gate).

  > Note: `anet node start / stop / delete` / editing config are **not** admin network-role privileges — they're pure local CLI operations (see note ※ on the permission matrix above), available to whoever holds the node config on their machine, regardless of network role. An admin **cannot** remotely start/stop an agent on someone else's machine.
- **Cannot**: **change an existing member's role** — `PUT /api/networks/:id/members/:user_id` is **owner-only** ([`index.ts:674`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L674) `if (callerRole !== "owner")` → 403); admin can only invite / remove, not re-role existing members. Also cannot: delete the network itself; remove an owner or promote anyone to owner; **read other users' `/api/audit-log` rows** — admin-only endpoints are gated by **system-level** `users.role='admin'` (**not** network admin). A network admin sees only their own audit log rows, same as members and viewers.

Become an admin:
```bash
# Option 1 (recommended): owner issues an admin invite — recipient joins directly with admin role
anet network invite --role admin --uses 1

# Option 2: promote an existing member via REST (v0.10.15 stable still has no CLI promote subcommand; queued for v0.11+ / unscheduled)
curl -X PUT http://localhost:9200/api/networks/<net_id>/members/<user_id> \
  -H "Authorization: Bearer <owner_utok>" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'
# See [API — PUT members](/en/api/rest#put-api-networks-id-members-user-id)
```

### owner

For network creator. Fully privileged. **Every network must have at least one owner.**

- **Can**: everything admin can; delete the network; change other members' roles (`PUT /api/networks/:id/members/:user` requires the caller to be an owner — admin cannot re-role members).
- **Protections**: cannot be downgraded or removed by an admin. If only one owner remains, that owner cannot demote or remove themselves. ⚠ The owner role **cannot be granted** to anyone (`updateMemberRole` / `createInvite` both explicitly reject `owner`) — so "multiple owners" is not a normal path; see "Become an owner" below.

Become an owner:
- Create a network: `anet network create <name>` (creator is auto-owner)
- ⚠ **You cannot be promoted to owner via REST `PUT /members/:user_id`** — the server rejects it with `cannot assign owner role` (400). See [API — PUT members 4xx](/en/api/rest#put-api-networks-id-members-user-id). Owner is acquired only by creating the network.

---

## Hub-global admin (special)

::: warning Different from "network admin"
The 4 roles above are scoped to a single network. There is also a **hub-global admin** — the `admin` user created on first run. This user is automatically admin in every network and can hit hub-level management endpoints.
:::

| Operation | network admin | hub-global admin (`admin` user) |
|---|---|---|
| `/api/audit-log` — own rows | ✅ | ✅ |
| `/api/audit-log` — all rows | ❌ (server auto-filters `WHERE user_id = self`) | ✅ (index.ts:1086-1089) |
| `anet hub admin reset-user` (reset any user's password) | ❌ | ✅ (local-only) |
| Create new users | ❌ | ✅ |
| See all networks on the hub | ❌ (only ones they're a member of) | ✅ |

---

## Where role info lives

Each `utok_` is bound to a `(user_id, network_id, role)` tuple (in the `api_tokens` table's `scope` field).

```ts
const ctx = await resolveToken(req.headers.authorization);
// ctx = { user_id, network_id, role: 'admin' | 'member' | ... }

if (!isAdminLike(ctx.role)) return new Response("403", { status: 403 });
```

The CLI never asks you for role info — `anet login` makes the hub embed it in the token, and the CLI attaches it automatically.

---

## Promote / demote a member

::: warning No `promote` / `demote` CLI subcommand yet
v0.10.x stable still has no CLI promote/demote subcommand — the v0.9.x / v0.10.x stable line never touched member-role management (per-release detail in the [changelog](/en/changelog)); the full CLI entry is queued for v0.11+ / unscheduled. Today you can list members via the CLI, but **role changes / member removal go through REST** (see [API — networks members](/en/api/rest#get-api-networks-id-members)).
:::

```bash
# 1. List all members of the current network with their roles (CLI, shipped)
anet network members

# 2. Change bob's role to admin (REST, owner only)
#    Note: the `role` field cannot be 'owner' — see PUT members 4xx table.
#    Caveat: `anet whoami` / `anet network ls` truncate network_id to 12 chars in their output,
#            but REST calls need the full id — read it from config.json directly.
NET=$(jq -r .network_id ~/.anet/config.json)
UTOK=$(jq -r .token ~/.anet/config.json)
curl -X PUT "http://localhost:9200/api/networks/$NET/members/u_bob_xxx" \
  -H "Authorization: Bearer $UTOK" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'

# 3. Remove bob (REST, owner/admin)
curl -X DELETE "http://localhost:9200/api/networks/$NET/members/u_bob_xxx" \
  -H "Authorization: Bearer $UTOK"
```

Full endpoint docs: [PUT members](/en/api/rest#put-api-networks-id-members-user-id) / [DELETE members](/en/api/rest#delete-api-networks-id-members-user-id).

---

## FAQ

**Q: After `anet login`, what role do I have?**
A: `anet whoami`'s `Role:` field is the **system-level role** (`users.role` — either `admin` or `user`), **not the per-network role** (verified at [`agent-network/bin/cli.ts:3281-3302 whoamiCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L3281)):

```
  User: admin (u_xxxxxx)
  Role: admin              ← system-level users.role ('admin' / 'user'), NOT the network role
  Hub:  http://127.0.0.1:9200

  Networks:
    default (net_xxxxxxxxx) ← current
    my-team (net_yyyyyyyyy)
```

To check your role **within the current network** (owner/admin/member/viewer), run `anet network members` and find your own row (bound to `network_members` — a separate state from `users.role`).

**Q: Can the same user have different roles in different networks?**
A: Yes. Roles are per-network.

**Q: What role does the default `admin / anethub` account have?**
A: First-run creation sets it as hub-global admin + owner of the default network.

**Q: Can a user be admin in just one network without being hub-global admin?**
A: Yes. Make them a network owner without granting hub `admin` (i.e., don't add them to hub-global admin users). They control that one network but cannot reach hub-level admin endpoints.

**Q: Viewers really can't write anything, not even dispatch tasks?**
A: Correct. If you want "read + occasional dispatch", grant `member`.

---

## Relationship to RFC-001

[RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) **landed in v0.8.0**: `COMMHUB_AUTH_TOKEN` is now soft-deprecated (full removal in v1.0). Hub authentication is entirely based on these 4 roles:

- ✅ No master-key bypass for role checks
- ✅ All admin ops = admin-role `utok_` + role check
- ✅ All hub ↔ dashboard internal calls = admin user's `utok_` (Dashboard is a thin cookie-proxy)

The role system is the only auth basis going forward.

## Next steps

- **CLI ops for roles**: [CLI commands — network management](/en/guide/cli) (`anet network members` lists members; role changes go through REST [PUT members](/en/api/rest#put-api-networks-id-members-user-id) — the CLI `promote` / `demote` subcommands are queued for v0.11+ / unscheduled)
- **Token system mapping**: [Tokens](/en/concepts/tokens) — how the 4 roles relate to `utok_` / `ntok_`
- **Full security model**: [Security design](/en/concepts/security)
- **How v0.7 → v0.8 upgrade affects roles**: [Upgrade guide](/en/guide/upgrade#v0-7-v0-8-upgrade-notes-latest)
- **RFC-001 roadmap**: [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md)
