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
| **Auto-register during setup** | `anet hub start` | First time, setting up locally |
| **Manual register** | `anet register --hub http://server-IP:9200` | Joining someone else's server |

```bash
# Method 1: One-command setup (auto-registers admin account)
anet hub start
# → Enter username and password interactively
# → Auto register + login + create default network

# Method 2: Join someone else's server
anet register --hub http://10.0.0.1:9200
# → Enter username and password
# → Registered and auto-logged in
```

::: info First registered user
The first user to register automatically becomes the system admin. Subsequent users are regular users.
:::

### Login

After registration, you're automatically logged in. To log in again:

| Login Location | How | Which Account |
|---------|--------|-----------|
| **CLI (terminal)** | `anet login` | Same username + password from registration |
| **Dashboard (browser)** | Open `http://server-IP:9200` | Same username + password |

```bash
# CLI login
anet login
# → Enter username and password
# → Token saved to ~/.anet/config.json

# Verify login status
anet whoami
# → Logged in as: yourname
# → Role: admin
# → Network: default (net_xxxxxxxx)
```

::: tip CLI and Dashboard use the same account
`anet login` in the terminal and Dashboard login in the browser use the exact same username and password. No separate registration needed.
:::

### Change Password

```bash
anet passwd
```

### Creating Accounts for Others

Have them run on their own computer:

```bash
anet register --hub http://your-server-IP:9200
```

After registration, they get their own default network. To add them to your network, create an invite code:

```bash
# You create an invite code
anet network invite default --role member

# They join with the invite code
anet network join inv_xxxxxx
```

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
~/.anet/nodes/writer-1/config.json
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

## Network Roles (RBAC)

Each user has a role in each network:

| Role | Who | What they can do |
|------|------|---------|
| **owner** | Network creator | Everything, including delete network and change roles |
| **admin** | Promoted by owner | Invite/kick members, manage tokens, cannot delete network |
| **member** | Joined via invite | Start agents, send tasks, reply to tasks |
| **viewer** | Read-only user | View only — cannot send tasks or start agents |

::: info One user can have different roles in different networks
For example, you can be owner in "dev", member in "prod", and viewer in "demo".
:::

### Permission Quick Reference

| Operation | owner | admin | member | viewer |
|------|:-----:|:-----:|:------:|:------:|
| View agents and tasks | ✓ | ✓ | ✓ | ✓ |
| Send / reply to tasks | ✓ | ✓ | ✓ | |
| Start agents | ✓ | ✓ | ✓ | |
| Invite / remove members | ✓ | ✓ | | |
| Change member roles | ✓ | | | |
| Delete / rename network | ✓ | | | |

---

## AI Model Accounts (Separate from Agent Network)

Agents need AI model APIs to do work. These have their own account systems, completely independent from Agent Network:

| Model | How to Get Key | Where to Register |
|------|-----------|---------|
| MiniMax | Create API Key after signup | [platform.minimaxi.com](https://platform.minimaxi.com) |
| DeepSeek | Create API Key after signup | [platform.deepseek.com](https://platform.deepseek.com) |
| GLM (Zhipu) | Create API Key after signup | [open.bigmodel.cn](https://open.bigmodel.cn) |
| Kimi | Create API Key after signup | [platform.moonshot.cn](https://platform.moonshot.cn) |
| Claude | Create API Key after signup | [console.anthropic.com](https://console.anthropic.com) |
| GPT-5.5 | Run `codex auth login` in terminal | Auto-redirects to OpenAI login |

Keys are entered during `anet node create` and saved locally at `~/.anet/nodes/<name>/config.json`. They are **never uploaded** to the CommHub server.

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
Run `anet passwd` to change it. If CLI is also logged out, ask the admin to reset.

### Q: Are model API Keys uploaded to CommHub?
**No.** Keys are only stored locally at `~/.anet/nodes/<name>/config.json`. They are never sent to the CommHub server.

### Q: Can one person be in multiple networks?
**Yes.** Roles are independent per network. You can be owner of "dev" and member of "prod" simultaneously.

---

## Next Steps

- [Token System Details](/en/concepts/tokens) — Full explanation of utok_ / ntok_ / atok_
- [Network Isolation](/en/concepts/networks) — RBAC permission matrix, invite codes, data isolation
- [Multi-Model Config](/en/guide/multi-model) — How to configure different AI models
