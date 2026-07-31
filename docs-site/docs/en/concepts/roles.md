# Roles & Permissions

::: tip One line
Each network has four membership roles: `owner`, `admin`, `member`, and `viewer`. The server checks the current user's membership in the target network; a `utok_` does not embed one fixed network role.
:::

## The 4 roles at a glance

| Role | Typical use | One-liner |
|---|---|---|
| **owner** | Network creator, top of the hierarchy | Manage members + delete network + all admin ops |
| **admin** | Team lead / trusted operator | Invite and remove members; hub-wide admin APIs require a separate system-admin identity |
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
| `/api/audit-log` — all rows | Only `users.role='admin'` | | | |
| `/api/users` (list users) | Only `users.role='admin'` (same system-level gate) | | | |
| `/api/server-logs` (debug console) | Only `users.role='admin'` | | | |
| `anet hub admin reset-user` (reset any user's password) | Local-only CLI command on the hub host, not role-gated (the hub owner just needs local shell access) | | | |

> ※ `anet node start / stop / delete` are initiated from the local `.anet/nodes/<alias>/` config and do not check network membership (stop/delete still notify the Hub or clean up identity). Whoever holds that local config can run them. `anet node create`, by contrast, requires non-viewer membership to obtain a node credential.

> `send_task`, `cancel_task`, and `reassign_task` are available to owner/admin/member and reject viewers. Cancel and reassign do not have an “only tasks I created” rule. Network rename and deletion are owner-only.

---

## Assigning roles

Choose `admin`, `member`, or `viewer` when creating an invite:

```bash
anet network invite --role admin --uses 1
anet network invite --role member --uses 5
anet network invite --role viewer --uses 1
```

Changing an existing member uses `PUT /api/networks/:id/members/:user_id`, and only an owner may call it. `owner` cannot be assigned through an invite or that endpoint; the user who creates a network becomes its owner.

---

## Hub-global admin (special)

::: warning Different from "network admin"
The four roles above are scoped to one network. A separate system-level `users.role='admin'` can access hub-wide user, audit, and server-log endpoints, but it **does not automatically become a network admin member in every network**.
:::

| Operation | network admin | hub-global admin (`admin` user) |
|---|---|---|
| `/api/audit-log` — own rows | ✅ | ✅ |
| `/api/audit-log` — all rows | ❌ (server auto-filters `WHERE user_id = self`) | ✅ |
| `anet hub admin reset-user` (reset any user's password) | ❌ | ✅ (local-only) |
| Create a user through the public registration endpoint | ✅ (subject to rate limits and password rules) | ✅ |
| List every network directly | ❌ (membership list only) | ❌ (same membership list) |

---

## Where role info lives

A `utok_` binds a user identity; network roles live in `network_members`. Once a request targets a network, the server looks up that user's membership. An `ntok_` additionally carries a fixed `network_id` for one-network node access.

The CLI does not ask you to enter a role. After login, the server uses the user identity and target-network membership for authorization.

---

## Promote / demote a member

::: info Current entry points
The CLI can list members. Use REST for role changes and member removal (see [API — networks members](/en/api/rest#get-api-networks-id-members)).
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
A: `anet whoami`'s `Role:` field is the **system-level role** (`users.role` — either `admin` or `user`), **not the per-network role** (verified at [`agent-network/bin/cli.ts whoamiCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts)):

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

**Q: What role does the first-start `admin` account have?**
A: First-run creation sets it as hub-global admin + owner of the default network.

**Q: Can a user be admin in just one network without being hub-global admin?**
A: Yes. Give them the network's `admin` role; their system-level `users.role` remains unchanged.

**Q: Viewers really can't write anything, not even dispatch tasks?**
A: Correct. If you want "read + occasional dispatch", grant `member`.

---

## Next steps

- **CLI ops for roles**: [CLI commands — network management](/en/guide/cli)
- **Token system mapping**: [Tokens](/en/concepts/tokens) — how the 4 roles relate to `utok_` / `ntok_`
- **Full security model**: [Security design](/en/concepts/security)
