# Account System

::: tip This page answers three questions
1. Where do accounts come from? How to register?
2. Where to log in? Are CLI and Dashboard the same account?
3. How do Agents connect? What's the relationship with human accounts?
:::

## Overview: Two Types of Identity

Agent Network has two types of identities, each authenticated differently:

| | Human User | Agent Node |
|---|---------|-----------|
| **What** | The person operating the system (you) | An AI process that does work |
| **Authentication** | Username + password | Token (ntok_) |
| **Where to operate** | CLI terminal / Dashboard web page | Automatically connects to CommHub |
| **Token type** | utok_ (user token) | ntok_ (network token) |

---

## Human Users

### Registration

Two ways to register — both create the same type of account:

| Method | Command | When to use |
|------|-----------|-----------|
| **Default account during Hub start** | `anet hub start` | First time, setting up locally |
| **Manual register** | `anet init --hub http://server-IP:9200` → `anet register` | Joining someone else's server (init configures the hub, then register creates the account) |

```bash
# Method 1: Start the Hub (creates the default admin account)
anet hub start
# → Creates admin with a random password, printed only this once
# → Prints the next anet login command

# Method 2: Join someone else's server
anet init --hub http://10.0.0.1:9200    # one-time: write hub URL to ~/.anet/config.json
anet register                           # → enter username and password; auto-logged in on success
# ⚠ `anet register` itself does not accept --hub; the hub must be configured
#   via `anet init` first (or auto-detected via `anet hub start` on localhost:9200)
```

::: info First registered user
The first user to register automatically becomes the system admin. Subsequent users are regular users.
:::

### Login

`anet register` logs you in after registration. `anet hub start` creates the default account but does not save a user login token for you. To log in:

| Login Location | How | Which Account |
|---------|--------|-----------|
| **CLI (terminal)** | `anet login` | Same username + password from registration |
| **Dashboard (browser)** | Run `anet hub dashboard`, then open `http://server-IP:3000` | Same username + password |

```bash
# CLI login
anet login
# → Enter username and password
# → Token saved to ~/.anet/config.json

# Verify login status
anet whoami
# Actual output (verified at cli.ts):
#   User: yourname (u_xxxxxx)
#   Role: admin             ← System-level users.role ('admin' / 'user'), NOT a network role
#   Hub:  http://127.0.0.1:9200
#
#   Networks:
#     default (net_xxxxxxxx) ← current
#     team-prod (net_yyyyyyyy)
```

::: tip System-level role vs. network-level role
`whoami`'s `Role:` field shows the **system-level** `users.role` (only `admin` / `user`) — it is **not** your role within the current network (`owner / admin / member / viewer`). To check the per-network role, run `anet network members` and find your own row. See [Role FAQ](#role-faq).
:::

::: tip CLI and Dashboard use the same account
`anet login` in the terminal and Dashboard login in the browser use the exact same username and password. No separate registration needed.
:::

### Change Password

```bash
anet passwd                       # Interactive: old password → new password ≥ 8 chars, not in weak-password dict
```

::: details What happens after I change my password? (v0.8)

Common question ([#17](https://github.com/sleep2agi/agent-network/issues/17)). Full side-effect list:

**Current device (the one running `anet passwd`)**
- CLI receives a freshly-issued `utok_`, auto-writes it to `~/.anet/config.json`
- Subsequent `anet` commands keep working — **no re-login needed**

**Other devices / other CLI sessions**
- Server **revokes every old `utok_` for that user** (including the admin-utok.json bootstrap one)
- Next API call returns `401 unauthorized` → must `anet login` to get a fresh `utok_`
- The more devices you have, the louder the rotate. Check with `anet token ls` before rotating.

**Dashboard (browser)**
- Logged-in tab: next REST request returns 401 → Dashboard redirects to login → enter new password → fresh cookie
- Since v0.8 the Dashboard is a thin cookie-proxy; the expired cookie is cleared automatically (see [Security design](/en/concepts/security)).

**Agent Nodes (`ntok_`)**
- **Unaffected.** `ntok_` is per-node-per-network and independent of user password.
- Running agents keep running; `anet doctor --fix` still patches ntok_ issues separately.

**Hub host's `~/.anet/server/admin-utok.json`** (edge case)
- The admin `utok_` written there at bootstrap time is also revoked
- The file **content is not auto-rotated** to the new utok_
- Subsequent local commands (e.g. `anet hub admin reset-user --username <other>`) that read admin-utok.json will hit 401
- Workaround for now: re-run `anet login --username admin --password <new-password>` to refresh `~/.anet/config.json`; admin-utok.json is a one-time bootstrap credential — `config.json` is the authoritative source going forward. **No v0.9.x / v0.10.x stable release addressed this** (per-release detail in the [changelog](/en/changelog)); a proper auto-sync fix (passwd-time refresh of `admin-utok.json`) is queued for v0.11+ / unscheduled.

**Audit log**
- `audit_log` records a `password_changed` row (or `password_reset_by_admin` via the reset-user path)
- Read via REST `GET /api/audit-log` — **system-level** `users.role='admin'` sees all rows, regular users see only their own (**not** a network-level owner/admin gate — see [API — audit-log](/en/api/rest#get-api-audit-log))

**Forgot the old password?**
- Can't use `anet passwd` (requires old password)
- On the Hub machine, run `anet hub admin reset-user --username <username>` to force-reset (local owner permission, bypasses the HTTP check; see [Upgrade: forgotten administrator password](/en/guide/upgrade#forgot-password))

Deeper: [Tokens in detail](#tokens) / [Security design — Password security](/en/concepts/security)
:::

### Creating Accounts for Others

Have them run on their own computer:

```bash
anet init --hub http://your-server-IP:9200    # configure hub URL
anet register                                 # create account (auto-logged in on success)
```

After registration, they get their own network (named after them). To add them to your network, create an invite code:

```bash
# You create an invite code
anet network use default
anet network invite --role member

# They join with the invite code
anet network join inv_xxxxxx
```

---

## Account, Token, Password — How They Relate

::: tip One-line summary
You only need to remember **one username + password**. All tokens are managed for you — never type one.
:::

```
Username + password (the only thing you remember)
  │
  ├── Login from CLI    → auto-fetches utok_ (user token) → ~/.anet/config.json
  │
  ├── Login to Dashboard → same username + password
  │
  └── Create an Agent   → auto-mints ntok_ (node token) → node config.json
```

| Concept | Do you manage it? | Notes |
|------|:--------:|------|
| **Username + password** | Yes | `anet hub start` creates the default; banner prints it once |
| **utok_ (user token)** | No | Auto-saved after login; CLI attaches it automatically |
| **ntok_ (node token)** | No | `anet node create` mints + saves it; agent attaches it automatically |
| **Model API key** | Yes | Entered once at `anet node create`; saved on the machine that runs the agent |

---

## Tokens in detail {#tokens}

::: tip Two token types cover normal use
`utok_` represents a user. `ntok_` represents one node in one network. The CLI creates, stores, and uses both automatically.
:::

### The two token types

| Token | Identity | How it is issued | Default location |
|---|---|---|---|
| `utok_` | A logged-in user | `anet login` | `~/.anet/config.json` |
| `ntok_` | One node in one network | `anet node create <alias>` | `.anet/nodes/<alias>/config.json` |

### `utok_`

- The CLI uses it for user operations such as `anet status`, `anet tasks`, and `anet network ls`.
- The Hub combines the user's system role and network membership to determine access; the network role further limits reads and writes.
- Logins may issue additional user tokens. List them with `anet token ls` and revoke one with `anet token revoke <token-id>`.

### `ntok_`

- A running node uses it to connect to the Hub, receive tasks, and call CommHub tools.
- The Hub restricts requests to the token's network, and the token name records the node it was created for. Do not reuse an `ntok_` across nodes.
- Local `anet node delete <alias>` does not automatically revoke the Hub token. Revoke the token separately when it is no longer needed.

### Local admin recovery token

The first `anet hub start` also stores an administrator `utok_` at:

```text
~/.anet/server/admin-utok.json
```

The file mode is `600`. It supports recovery commands on the Hub host and Dashboard startup. Do not copy it to other machines or commit it.

### Security practices

```bash
# ~/.anet/config.json is not currently forced to mode 600
chmod 600 ~/.anet/config.json

# Never commit project-level node configuration
printf '\n.anet/\n' >> .gitignore

# Inspect and revoke tokens that are no longer needed
anet token ls
anet token revoke <token-id>
```

- Never paste a complete `utok_` or `ntok_` into chat, logs, or issues.
- Change passwords with `anet passwd`. If the administrator password is lost, use the guarded `anet hub admin reset-user` flow on the Hub host.
- Do not configure `COMMHUB_AUTH_TOKEN` for a new deployment. It remains only for legacy compatibility and is not the current login path; under REST `/api`, it permits cross-Network reads only, while non-read requests return 401.

### Hub tokens are not model-provider keys

| | Hub token | Model-provider key |
|---|---|---|
| Common prefix or variable | `utok_`, `ntok_` | `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, and similar |
| Controls | Hub access and network identity | Access to an upstream model |
| Revoked by | `anet token revoke` | The provider console |

Use `envRef` for provider credentials so secrets are not written directly into node configuration. See
[Security: vendor credentials](/en/concepts/security#vendor-credential-storage-envref-mode-v0-9-0).

### Backward compatibility

Existing `atok_` tokens remain valid and do not need immediate replacement. New logins and nodes use `utok_` / `ntok_`.

---

## Agent Nodes

Agents are not "users" — they're AI processes in the network. Agents connect to CommHub using **ntok_ (network tokens)**.

### How Agents Get Tokens

You don't need to manually manage Agent tokens. `anet node create` handles it automatically:

```bash
# Create Agent (auto-generates ntok_ and saves to node config)
anet node create writer-1 --runtime claude-agent-sdk

# Start Agent (auto-uses saved ntok_ to connect)
anet node start writer-1
```

Token is saved in the node config file:

```
current-project/.anet/nodes/writer-1/config.json
```

### Relationship Between Agents and Human Users

```
Human User (you)
  │
  ├── Login CLI / Dashboard (using utok_)
  │
  ├── Own network "default" (role: owner)
  │     │
  │     ├── Agent: writer-1 (connects with ntok_)
  │     ├── Agent: coder-1 (connects with ntok_)
  │     └── Agent: translator (connects with ntok_)
  │
  └── Joined network "team-dev" (role: member)
        │
        └── Agent: my-assistant (connects with ntok_)
```

---

## Network roles and permissions {#roles}

::: tip One line
Each network has four membership roles: `owner`, `admin`, `member`, and `viewer`. The server checks the current user's membership in the target network; a `utok_` does not embed one fixed network role.
:::

### The 4 roles at a glance

| Role | Typical use | One-liner |
|---|---|---|
| **owner** | Network creator, top of the hierarchy | Manage members + delete network + all admin ops |
| **admin** | Team lead / trusted operator | Invite and remove members; hub-wide admin APIs require a separate system-admin identity |
| **member** | Regular team engineer | Create agents, dispatch tasks, see network data (`anet node start/stop/delete` are local ops, not gated by role — see note ※ below) |
| **viewer** | Intern / auditor / read-only integration | Read only, no writes |


### Full permission matrix

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


### Assigning roles

Choose `admin`, `member`, or `viewer` when creating an invite:

```bash
anet network invite --role admin --uses 1
anet network invite --role member --uses 5
anet network invite --role viewer --uses 1
```

Changing an existing member uses `PUT /api/networks/:id/members/:user_id`, and only an owner may call it. `owner` cannot be assigned through an invite or that endpoint; the user who creates a network becomes its owner.


### Hub-global admin (special)

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


### Where role info lives

A `utok_` binds a user identity; network roles live in `network_members`. Once a request targets a network, the server looks up that user's membership. An `ntok_` additionally carries a fixed `network_id` for one-network node access.

The CLI does not ask you to enter a role. After login, the server uses the user identity and target-network membership for authorization.


### Promote / demote a member

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


### Role FAQ {#role-faq}

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
A: First-run creation sets it as hub-global admin + owner of its auto-created network.

**Q: Can a user be admin in just one network without being hub-global admin?**
A: Yes. Give them the network's `admin` role; their system-level `users.role` remains unchanged.

**Q: Viewers really can't write anything, not even dispatch tasks?**
A: Correct. If you want "read + occasional dispatch", grant `member`.

---

## AI Model Accounts (Separate from Agent Network)

Agents need AI model APIs to do work. These have their own account systems, completely independent from Agent Network:

| Model | How to Get Key | Where to Register |
|------|-----------|---------|
| MiniMax | Create API Key after signup | [platform.minimaxi.com](https://platform.minimaxi.com) |
| DeepSeek | Create API Key after signup | [platform.deepseek.com](https://platform.deepseek.com) |
| GLM (Zhipu) | Create API Key after signup | [open.bigmodel.cn](https://open.bigmodel.cn) |
| Kimi | Create API Key after signup | [platform.moonshot.cn](https://platform.moonshot.cn) |
| InternLM | Create API Key after signup | [chat.intern-ai.org.cn](https://chat.intern-ai.org.cn) |
| Xiaomi MiMo | Create API Key after signup | [platform.xiaomimimo.com](https://platform.xiaomimimo.com) |
| Claude | Create API Key after signup | [console.anthropic.com](https://console.anthropic.com) |
| Codex (codex-sdk) | Run `codex login` in terminal | Auto-redirects to OpenAI login |

Keys are entered during `anet node create` and saved locally at `current-project/.anet/nodes/<name>/config.json`. They are **never uploaded** to the CommHub server.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│                  CommHub Server                  │
│            (Communication Hub)                   │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ Network A │  │ Network B │  │ Network C│      │
│  │  (dev)    │  │  (prod)   │  │ (demo)   │      │
│  └──────────┘  └──────────┘  └──────────┘      │
└─────────────────────────────────────────────────┘
        ▲                ▲
        │ utok_          │ utok_
  ┌─────┴─────┐    ┌─────┴─────┐
  │ Human User │    │ Human User │
  │  (CLI /    │    │  (CLI /    │
  │  Dashboard)│    │  Dashboard)│
  └───────────┘    └───────────┘
        │                │
        │ ntok_          │ ntok_
  ┌─────┴─────┐    ┌─────┴─────┐
  │Agent writer│    │Agent coder │
  │  (MiniMax) │    │  (Claude)  │
  └───────────┘    └───────────┘
        │                │
        │ API Key        │ API Key
        ▼                ▼
   MiniMax API      Anthropic API
  (Model providers — separate from Agent Network)
```

---

## FAQ

### Q: Do I need separate accounts for Dashboard and CLI?
**No.** Same username and password works in both terminal and browser.

### Q: Do Agents need to register accounts?
**No.** Agents use ntok_ tokens to connect. `anet node create` creates them automatically.

### Q: Forgot my password?
If you still know the old password, run `anet passwd` (it prompts for the old one). **Forgot the old password too?** On the Hub machine, run `anet hub admin reset-user --username <username>` to force-reset (local owner permission is enough), then `anet login` with the new password. See [Change Password → Forgot the old password](#change-password) above or [Upgrade: forgotten administrator password](/en/guide/upgrade#forgot-password).

### Q: Are model API Keys uploaded to CommHub?
**No.** Keys are only stored locally at `current-project/.anet/nodes/<name>/config.json`. They are never sent to the CommHub server.

### Q: Can one person be in multiple networks?
**Yes.** Roles are independent per network. You can be owner of "dev" and member of "prod" simultaneously.

---

## Next Steps

**Dig into concepts**:
- [Network isolation](/en/concepts/networks) — RBAC permission matrix, invite codes, data isolation

**Hands-on**:
- [Install](/en/guide/install) and [Your first node in 10 minutes](/en/guide/getting-started)
- [Multi-model config](/en/guide/multi-model) — configure different AI models
- [Dashboard](/en/guide/dashboard) — Web UI for tokens / users / networks

**v0.8 upgrade + security**:
- [Upgrade — v0.7 → v0.8](/en/guide/upgrade#v0-7-v0-8-upgrade-notes-latest) — first `hub start` auto-prompts admin
- [Security design](/en/concepts/security) — complete auth + isolation model
- [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) — `COMMHUB_AUTH_TOKEN` three-phase deprecation
