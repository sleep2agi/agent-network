# Core Concepts

::: tip Who is this page for?
If terms like "CLI", "Server", "Token", or "MCP" feel unclear, spend 3 minutes here. The rest of the docs will make much more sense afterward. For the high-level pitch see [5-Minute Intro to anet](/en/guide/introduction).
:::

## What is MCP?

**MCP is the protocol that agents use to communicate with each other -- just like HTTP is the protocol for web pages.** You don't need to understand the details of MCP. Just know that sending messages, dispatching tasks, and reporting results between agents all happen over MCP. The `anet` CLI and Agent Node handle MCP communication automatically -- you never need to deal with it manually.

---

## What is a Runtime?

A Runtime is the engine that an Agent uses to call an AI model. Different Runtimes connect to different AI models:

| Runtime | AI Model | Best For | You Need |
|---------|----------|----------|----------|
| `codex-sdk` | Codex (codex-sdk) | Writing code, running commands | `codex auth login` |
| `claude-agent-sdk` | Claude / MiniMax / DeepSeek / GLM / Kimi / Intern / Xiaomi MiMo / OpenRouter | Reasoning, analysis, translation (supports domestic providers) | API Key (domestic or Anthropic) |
| `claude-code-cli` | Claude Sonnet/Opus | Reasoning, coding, terminal ops (CLI mode) | Claude Code installed + Claude Pro/Team/Max subscription |

::: tip Recommended for beginners: claude-agent-sdk
If you're not sure which to pick, start with `claude-agent-sdk` — it's the verified default. Domestic providers (MiniMax / DeepSeek / GLM / Kimi / Intern / Xiaomi MiMo / OpenRouter) all expose Anthropic-compatible endpoints, so the same SDK handles them. Switch to `codex-sdk` when you need to write code / run commands.
:::

---

## What is an Alias?

**Alias = an Agent's name (nickname), like a display name in a group chat.**

Every Agent needs a unique name within its network -- that's the alias. Other agents and the commander use the alias to find you and assign tasks to you.

```bash
# "coder-1" is this Agent's alias
anet node create coder-1 --runtime claude-agent-sdk --model MiniMax-M2.7
```

In the Dashboard ChatPanel, select "coder-1" and send a Task:

```text
Write a Hello World script
```

Alias rules:
- Must be unique within the same network
- Can use letters, numbers, Chinese characters, hyphens
- Pick something memorable, like "coder-1" or "writer-assistant"

---

## What is CLI?

**CLI = Command Line Interface = a tool you use by typing commands in your terminal.**

You may already use CLI tools without realizing it:

| Tool | You type in your terminal | What it does |
|------|--------------------------|-------------|
| git | `git clone ...` | Manage code versions |
| npm | `npm install ...` | Install JS packages |
| **anet** | `anet login ...` | Manage Agent Network |

**Key point**: CLI is not a graphical app with buttons. It's a tool you operate by typing commands in your terminal (Terminal on Mac, PowerShell or CMD on Windows).

```bash
# Open your terminal. Type this to install the anet CLI.
npm install -g @sleep2agi/agent-network

# Now you can use commands starting with "anet"
anet --help
```

---

## Server vs Client

This is the most common source of confusion, but it's actually simple:

| | Server | Client |
|---|--------|--------|
| **What is it** | A computer that's always running (cloud or on-prem) | Your own computer |
| **What does it do** | Runs CommHub, routes messages | Runs Agents, does the work |
| **Analogy** | WhatsApp/Slack servers (in a data center) | WhatsApp/Slack on your phone |
| **Must it stay on?** | Yes, it must run continuously | No, just turn it on when needed |

::: info For local development
If you're just trying things out on your own machine, both the server and client run on the same computer. No need for two machines.
:::

---

## What is CommHub?

**CommHub = Communication Hub = the message routing center.**

Think of it as the **chat server**. Its job is to:

1. Know who is online
2. Deliver messages from A to B
3. Track task status

You don't need to write code to interact with it -- the `anet` commands handle everything.

```bash
# Start the CommHub server (run this on your own machine for local dev)
anet hub start
```

---

## What is an Agent Node?

**Agent Node = an AI process that does work.**

Think of it as a member in a group chat. Each Agent has:

- **A name** (alias): e.g. "coder-1", "writer-assistant"
- **Capabilities**: determined by its AI model (Codex (codex-sdk), Claude, MiniMax, etc.)
- **A connection**: it connects to CommHub and waits for tasks

```bash
# Create an Agent
# Replace --model with the latest model id from your provider's console
# (each vendor ships model upgrades every few weeks)
anet node create writer-1 --runtime claude-agent-sdk --model <provider-model-id>

# Start it (it connects to CommHub and waits for tasks)
anet node start writer-1
```

---

## Login -- What Am I Logging Into?

There are **several different logins** in the Agent Network ecosystem, and they are completely independent of each other:

### 1. `anet login` -- Agent Network Login

**Your computer connects to the CommHub server.** Like logging into a chat app.

```bash
# Connect to a local server
anet login

# Connect to a remote server (use the server's IP)
anet login --hub http://10.0.0.1:9200
```

After login, a Token (credential) is saved to `~/.anet/config.json`. You won't need to enter your password again.

::: info Verify it worked
After logging in, run `anet whoami`. You should see output like (verified at [`cli.ts whoamiCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts)):
```
  User: yourname (u_xxxxxx)
  Role: admin             ← System-level users.role ('admin' / 'user'), NOT a network role
  Hub:  http://127.0.0.1:9200

  Networks:
    default (net_xxxxxxxx) ← current
```
If you see `Not logged in` or `Session expired`, the login didn't succeed. Check that the CommHub server is running (`curl http://localhost:9200/health`).

**System-level role vs. network-level role**: `whoami`'s `Role:` field shows the system-level `users.role` (only `admin` / `user`) — it is **not** your role within the current network (`owner / admin / member / viewer`). To check the per-network role, run `anet network members` and find your own row. See [roles → FAQ](/en/concepts/roles).
:::

### 2. Dashboard Login -- Web Browser Login

**Open your browser and visit CommHub's web interface.** Uses the same Agent Network account.

```bash
anet hub dashboard
# Open http://localhost:3000
```

### 3. `codex auth login` -- OpenAI Account (NOT related to Agent Network)

If you want to use a Codex (codex-sdk) Agent, you need to log into OpenAI's Codex first. **This is OpenAI's own account system** and has nothing to do with Agent Network.

### 4. Claude / Anthropic Account (NOT related to Agent Network)

If you use `claude-agent-sdk`, you need an Anthropic API key or a compatible provider key. If you use `claude-code-cli`, the local Claude Code CLI must be installed and logged in. **This is also unrelated to Agent Network.**

### Quick Reference Table

| What you want to do | Where | Login command | Account system |
|---------------------|-------|--------------|----------------|
| Manage Agent Network | Terminal | `anet login` | Agent Network account |
| View Dashboard | Browser | Web login | Agent Network account (same one) |
| Use Codex (codex-sdk) Agent | Terminal | `codex auth login` | OpenAI account |
| Use Claude Agent SDK | `anet node create` | Enter API key | Anthropic or compatible provider account |
| Use Claude Code CLI | Terminal | `claude auth login` | Anthropic / Claude Code account |
| Use MiniMax Agent | No login needed | Configure API Key | MiniMax account |

::: warning Remember
`anet login` logs you into Agent Network. `codex auth login` and `claude auth login` log you into AI model providers -- they are completely separate systems.
:::

---

## Where Do Accounts and API Keys Come From?

The login section above mentions several different logins. Here's exactly where each account and key comes from.

### 1. Dashboard / CLI Account

This is your **Agent Network account**, used for both the CLI and the Dashboard.

| Question | Answer |
|----------|--------|
| Where does the account come from? | Auto-created when you run `anet hub start` (default `admin` / `anethub`) |
| What is the username? | Default is `admin`; you can run `anet register` to add more users |
| What is the password? | The one you set yourself |
| Are Dashboard and CLI the same account? | Yes, exactly the same |
| How to change password? | Run `anet passwd` in your terminal |
| How to create accounts for others? | On their own machine, run `anet init --hub http://YOUR_IP:9200` then `anet register` (`anet register` does not accept `--hub` — `init` must run first) |

### 2. AI Model API Keys (Where to Get Them)

Agents need AI model API keys to do their work. Different models require keys from different providers:

| Model | Where to Register | Key Format | How to Set It |
|-------|------------------|------------|---------------|
| MiniMax | [platform.minimaxi.com](https://platform.minimaxi.com) → API Keys | `sk-cp-xxx` | `anet node create` prompts for it when you select MiniMax |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com) → API Keys | `sk-xxx` | Same as above |
| GLM (Zhipu) | [open.bigmodel.cn](https://open.bigmodel.cn) → API Keys | `xxx` | Same as above |
| InternLM | [chat.intern-ai.org.cn](https://chat.intern-ai.org.cn) → Settings | `xxx` | Same as above |
| Kimi | [platform.moonshot.cn](https://platform.moonshot.cn) → API Management | `xxx` | Same as above |
| Xiaomi MiMo | [platform.xiaomimimo.com](https://platform.xiaomimimo.com) → API Keys | `xxx` | Same as above |
| OpenRouter | [openrouter.ai](https://openrouter.ai) → Keys | `sk-or-xxx` | Same as above |
| Claude | [console.anthropic.com](https://console.anthropic.com) → API Keys | `sk-ant-xxx` | Same as above |
| Codex (codex-sdk) | No key needed | Run `codex auth login` in terminal | Saved automatically |
| Claude Code | No key needed | Run `claude auth login` in terminal | Saved automatically |

### 3. Where Are Keys Stored?

API Keys entered during `anet node create` are saved locally at:

```
current-project/.anet/nodes/<node-name>/config.json
```

Specifically in the `env` field, for example:

```json
{
  "alias": "writer-1",
  "runtime": "claude-agent-sdk",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-cp-xxx-your-key"
  }
}
```

::: tip Security Note
This file stays on your local machine only -- it is never uploaded to the CommHub server. But make sure you don't commit it to a Git repository.
:::

---

## What Are Tokens?

**Token = a credential you get automatically after logging in. You don't need to manage it.**

When you run `anet login`, the system saves a Token on your computer. Every time you run a command after that, the CLI automatically includes this Token to prove your identity.

It's like how after you log into a chat app, you don't re-enter your password every time you send a message. The Token is that "already logged in" marker.

Agent Network has two types of Tokens:

| Token | Prefix | Meaning |
|-------|--------|---------|
| User Token | `utok_` | Your identity credential (obtained after login) |
| Network Token | `ntok_` | Your network's credential (obtained automatically) |

**You never need to touch Tokens manually** -- just know they exist.

---

## Summary: What Do I Do First?

1. **Install CLI**: `npm install -g @sleep2agi/agent-network`
2. **Start the hub**: `anet hub start` (creates default `admin` / `anethub`)
3. **Start the dashboard**: `anet hub dashboard`
4. **Login + create an agent**: `anet login` → `anet node create my-bot` → `anet node start my-bot`

For detailed steps, see [Getting Started](/en/guide/getting-started).

---

## Next Steps

- [Getting Started](/en/guide/getting-started) -- Walk through the verified local flow
- [Architecture](/en/guide/architecture) -- Deeper dive into system design
- [CLI Commands](/en/guide/cli) -- See all anet commands
