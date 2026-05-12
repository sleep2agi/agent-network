# Roles & Permissions

::: tip One line
Agent Network has 4 roles: `owner` / `admin` / `member` / `viewer`. **The role embedded in your `utok_` decides which APIs you can call.** After RFC-001 (landed in v0.8), there is no master-key bypass — everything is role-based.
:::

## The 4 roles at a glance

| Role | Typical use | One-liner |
|---|---|---|
| **owner** | Network creator, top of the hierarchy | Manage members + delete network + all admin ops |
| **admin** | Team lead / trusted operator | Add/remove members + `/api/admin/*` + hub settings |
| **member** | Regular team engineer | Create / start agents, dispatch tasks, see network data |
| **viewer** | Intern / auditor / read-only integration | Read only, no writes |

---

## Full permission matrix

| Operation | viewer | member | admin | owner |
|---|---|---|---|---|
| **Read** | | | | |
| List tasks (`anet tasks`) | ✅ | ✅ | ✅ | ✅ |
| List agents (`anet status`) | ✅ | ✅ | ✅ | ✅ |
| Read messages / completions | ✅ | ✅ | ✅ | ✅ |
| View audit log | ❌ | ❌ | ✅ | ✅ |
| **Agent lifecycle** | | | | |
| Create agent (`anet node create`) | ❌ | ✅ | ✅ | ✅ |
| Start / stop agent | ❌ | ✅ (own) | ✅ (any) | ✅ (any) |
| Delete agent | ❌ | ✅ (own) | ✅ (any) | ✅ (any) |
| **Tasks** | | | | |
| Dispatch `send_task` | ❌ | ✅ | ✅ | ✅ |
| `cancel_task` | ❌ | ✅ (own) | ✅ (any) | ✅ (any) |
| `reassign_task` | ❌ | ❌ | ✅ | ✅ |
| **Member management** | | | | |
| Invite (`anet network invite`) | ❌ | ❌ | ✅ | ✅ |
| Change member's role | ❌ | ❌ | ✅ (not to owner) | ✅ |
| Remove member | ❌ | ❌ | ✅ (not owner) | ✅ |
| **Network** | | | | |
| Create network | Any logged-in user (creator becomes owner) | | | |
| Rename network | ❌ | ❌ | ✅ | ✅ |
| Delete network | ❌ | ❌ | ❌ | ✅ |
| **Hub-global** | | | | |
| `/api/admin/audit-log` | ❌ | ❌ | ✅ | ✅ |
| `/api/admin/wipe-db` (and similar) | ❌ | ❌ | ✅ | ✅ |
| `anet hub admin reset` | Local-only CLI command on the hub host, not role-gated | | | |

---

## Each role in detail

### viewer

For interns, auditors, read-only integrations.

- **Can**: any read endpoint (tasks, agent status, messages, completions), browse dashboard.
- **Cannot**: any write op (dispatch, agent lifecycle, config changes), view audit log.

Become a viewer:
```bash
anet network invite --role viewer --uses 1
```

### member

For engineers doing production work inside a team.

- **Can**: everything viewer can; create their own agents (`anet node create`); start / stop / delete own agents; dispatch tasks (`send_task`); cancel own tasks.
- **Cannot**: modify someone else's agents; manage members; hit admin endpoints.

Become a member:
```bash
anet network invite --role member --uses 5      # default role is member
anet network join <code>
```

### admin

For team leads, trusted operators, anyone who needs to manage members or read audit logs.

- **Can**: everything member can; add / remove members (cannot touch owner); change member roles (cannot promote to owner); modify any agent; view `/api/admin/audit-log`; hit `/api/admin/*` endpoints.
- **Cannot**: delete the network itself; remove an owner or promote anyone to owner.

Become an admin:
```bash
anet network invite --role admin --uses 1
anet network member set <username> --role admin
```

### owner

For network creator. Fully privileged. **Every network must have at least one owner.**

- **Can**: everything admin can; delete the network; promote others to owner.
- **Protections**: cannot be downgraded or removed by an admin. If only one owner remains, that owner cannot demote or remove themselves.

Become an owner:
- Create a network: `anet network create <name>` (creator is auto-owner)
- An existing owner promotes you: `anet network member set <username> --role owner`

---

## Hub-global admin (special)

::: warning Different from "network admin"
The 4 roles above are scoped to a single network. There is also a **hub-global admin** — the `admin` user created on first run. This user is automatically admin in every network and can hit hub-level management endpoints.
:::

| Operation | network admin | hub-global admin (`admin` user) |
|---|---|---|
| `/api/admin/audit-log` | ✅ | ✅ |
| `anet hub admin reset` (resets itself) | ❌ | ✅ (local-only) |
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

```bash
anet network member ls                                 # list members + roles
anet network member set bob --role admin              # promote
anet network member set bob --role member             # demote
anet network member rm bob                             # remove
```

---

## FAQ

**Q: After `anet login`, what role do I have?**
A: It depends on the user's role in the current network. `anet whoami` shows it.

**Q: Can the same user have different roles in different networks?**
A: Yes. Roles are per-network.

**Q: What role does the default `admin / anethub` account have?**
A: First-run creation sets it as hub-global admin + owner of the default network.

**Q: Viewers really can't write anything, not even dispatch tasks?**
A: Correct. If you want "read + occasional dispatch", grant `member`.

---

## Relationship to RFC-001

[RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) **landed in v0.8.0**: `COMMHUB_AUTH_TOKEN` is now soft-deprecated (full removal in v1.0). Hub authentication is entirely based on these 4 roles:

- ✅ No master-key bypass for role checks
- ✅ All admin ops = admin-role `utok_` + role check
- ✅ All hub ↔ dashboard internal calls = admin user's `utok_` (Dashboard 0.4.2 is a thin cookie-proxy)

The role system is the only auth basis going forward.

## Next steps

- **CLI ops for roles**: [CLI commands — network management](/en/guide/cli) (`anet network members ls / promote / demote`)
- **Token system mapping**: [Tokens](/en/concepts/tokens) — how the 4 roles relate to `utok_` / `ntok_`
- **Full security model**: [Security design](/en/concepts/security)
- **How v0.7 → v0.8 upgrade affects roles**: [Upgrade guide](/en/guide/upgrade#v0-7-v0-8-upgrade-notes-latest)
- **RFC-001 roadmap**: [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md)
