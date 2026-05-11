# Node Runtime

Every Agent Node has a **Runtime** (engine kernel) that decides how the node calls models and runs tools. Agent Network ships three Runtimes — **and you can mix them on a single Hub**: a Claude Code CLI agent dispatches a translation task to a MiniMax agent, then asks a Codex agent to write code, and merges the results back.

## Three runtimes at a glance

| Runtime | Engine | When to pick | Default models | Auth |
|---|---|---|---|---|
| `claude-code-cli` | spawn local `claude` CLI | Reuse your Claude subscription | Claude Sonnet / Opus | `claude` already logged in |
| `claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` | Programmatic access to any Anthropic-compatible API | Anthropic / MiniMax / DeepSeek / GLM / Kimi | API Key |
| `codex-sdk` | `@openai/codex-sdk` | Code writing / shell commands | OpenAI Codex (gpt-5) | `codex auth login` |

::: tip Not sure which one?
- **Want to reuse a Claude subscription** → `claude-code-cli`
- **Writing copy / translation / analysis (programmatic)** → `claude-agent-sdk`
- **Writing code / running commands** → `codex-sdk`
- **Using MiniMax / DeepSeek / GLM / Kimi** → `claude-agent-sdk` + `ANTHROPIC_BASE_URL`
- **Mix-and-match (recommended)** → run all three on one Hub, pick the best engine per role
:::

---

## claude-code-cli

Reuses your **already-logged-in Claude CLI session** — no API key, no token, just works.

### Prerequisites

`@sleep2agi/agent-network` **does not** install the Claude CLI for you — it spawns the `claude` binary that's already on your machine. You have to install and authenticate the CLI yourself first.

**1. Install Claude Code CLI** (npm global):

```bash
npm install -g @anthropic-ai/claude-code
```

**2. Log in to your Claude.ai subscription** (one-time OAuth flow in the browser):

```bash
claude
# The first launch prompts you to log in — follow the on-screen flow.
```

**3. Verify**:

```bash
claude --version
# Expected: claude-code 1.x.x (exact version may differ)

which claude
# Expected: a path on your PATH, e.g. /usr/local/bin/claude or ~/.npm-global/bin/claude
```

**Common failure**: after install, `claude: command not found`. Cause: npm's global bin directory isn't on your PATH. Fix:

```bash
npm config get prefix
# Append /bin to the output and add it to PATH, e.g.:
# export PATH="$(npm config get prefix)/bin:$PATH"
```

Add that line to `~/.bashrc` / `~/.zshrc` and `source` it.

### How it works

```
anet node start  →  spawn `claude` subprocess
                 ↓
         commhub MCP (stdio) tools injected
                 ↓
         receive send_task → forward to Claude session → reply
```

- The node spawns a `claude` CLI subprocess on start
- The commhub MCP server (over stdio) injects "receive task / dispatch task / reply" tools into the Claude session
- When a task arrives, the Hub pushes via SSE → MCP forwards to Claude → Claude processes and replies

### When to pick

- You already use [Claude Code](https://claude.com/claude-code) (claude.ai subscription)
- You want to plug your daily Claude session into multi-agent collaboration
- You don't want to pay for API access separately

### Config

```bash
anet node create my-bot --runtime claude-code-cli
anet node start my-bot
```

`config.json`:
```json
{
  "runtime": "claude-code-cli",
  "session": "",
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process"
  }
}
```

### Notes

- Requires a working `claude --version` (Claude Code CLI installed and authenticated)
- `session` is auto-saved; you can `anet node resume` later to keep the conversation
- Key difference vs the SDK runtime: CLI gives you the full Claude Code toolset (file ops / Bash / MCP)

---

## claude-agent-sdk

Programmatic access to **any Anthropic-compatible API** — Anthropic by default, but redirectable to MiniMax / DeepSeek / GLM / Kimi via `ANTHROPIC_BASE_URL`.

### Prerequisites

This runtime **requires no extra binary** — `@anthropic-ai/claude-agent-sdk` is bundled inside `@sleep2agi/agent-node@2.3.0`. All you need is anet itself plus an API key.

**1. Install anet** (if you haven't):

```bash
npm install -g @sleep2agi/agent-network@2.1.2
```

**2. Get an API key** (pick one provider):

| Provider | Env var | Where to get one |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| MiniMax | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic` | MiniMax platform |
| DeepSeek / GLM / Kimi / Moonshot / InternLM | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=<provider endpoint>` | Each provider's platform |

Full provider endpoint table: [Multi-model setup](/en/guide/multi-model).

**3. Verify**:

```bash
anet --version
# Expected: 2.1.2

# Start a node and check the logs
anet node start planner
# Expected: the log shows "spawned @anthropic-ai/claude-agent-sdk" without an SDK-not-found crash
```

**Common failure**: the node starts but immediately hits `401 Unauthorized` or `invalid x-api-key`. Cause: confusion between `ANTHROPIC_AUTH_TOKEN` (third-party endpoints) and `ANTHROPIC_API_KEY` (Anthropic direct). Fix:

- Talking to **api.anthropic.com** → use `ANTHROPIC_API_KEY`
- Talking to **any third-party Anthropic-compatible endpoint** → use `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`

### How it works

```
anet node start  →  spawn agent-node subprocess
                 ↓
         @anthropic-ai/claude-agent-sdk
                 ↓
         POST → ANTHROPIC_BASE_URL (default api.anthropic.com)
                 ↓
         commhub MCP (stdio) over SSE
```

- The agent-node process drives the SDK to call any Anthropic-compatible API
- Override the base URL with `ANTHROPIC_BASE_URL` to redirect to any compatible provider
- `settingSources: []` fully isolates the agent from your local `~/.claude/` config

### When to pick

- Direct Anthropic API (no subscription required)
- Domestic Chinese models (MiniMax / DeepSeek / GLM / Kimi — cheap / high-throughput / fast)
- Per-task model switching

### Config

**Anthropic direct**:
```bash
ANTHROPIC_API_KEY=sk-ant-xxx \
anet node create planner \
  --runtime claude-agent-sdk \
  --model claude-sonnet-4-6
```

**MiniMax**:
```bash
anet node create translator \
  --runtime claude-agent-sdk \
  --model MiniMax-M2.7 \
  --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=sk-cp-xxx"
```

### Verified models

| Provider | Model | `ANTHROPIC_BASE_URL` |
|---|---|---|
| Anthropic | claude-sonnet-4-6 / claude-opus-4-7 / claude-haiku-4-5 | `https://api.anthropic.com` |
| MiniMax | MiniMax-M2.7 | `https://api.minimaxi.com/anthropic` |
| DeepSeek | deepseek-v3-0324 | (per provider docs) |
| Zhipu GLM | glm-4-plus | (per provider docs) |
| Moonshot Kimi | kimi-k1.5 | (per provider docs) |
| InternLM | intern-s1-pro | `https://chat.intern-ai.org.cn/anthropic` |

---

## codex-sdk

OpenAI **Codex CLI** runtime — best for writing code and running shell commands.

### Prerequisites

`@openai/codex-sdk` ships inside `@sleep2agi/agent-node@2.3.0`, but the SDK **spawns a `codex` binary under the hood** — so you still have to install the codex CLI globally.

**1. Install codex CLI** (npm global):

```bash
npm install -g @openai/codex
```

**2. Authenticate to OpenAI** (pick one):

```bash
# Option A: OAuth flow (recommended, reuses your ChatGPT Plus / Pro)
codex auth login

# Option B: raw API key
export OPENAI_API_KEY=sk-xxx
```

**3. Verify**:

```bash
codex --version
# Expected: codex 0.x.x (exact version may differ)

codex auth status
# Expected: shows the logged-in OpenAI account or API key state
```

**Common failure**: node startup errors with `Error: spawn codex ENOENT`. Cause: `codex` isn't on your PATH — `@openai/codex-sdk` is just the Node wrapper, the actual `codex` global binary still has to be findable. Fix:

```bash
which codex
# If empty, codex isn't installed or npm's global bin isn't on PATH.
npm install -g @openai/codex
# If still missing, see the PATH fix in the claude-code-cli section.
```

### How it works

```
anet node start  →  spawn @openai/codex-sdk
                 ↓
         OpenAI API (OPENAI_API_KEY)
                 ↓
         commhub MCP (stdio) over SSE
```

- Driven by the official `@openai/codex-sdk` package
- Supports Read / Write / Edit / Bash / Glob / Grep tools
- Auth via `codex auth login` (OAuth) or `OPENAI_API_KEY`

### When to pick

- OpenAI's official Codex / latest gpt-5
- Code generation / shell command execution
- Heavy tool calling / function calling

### Config

```bash
codex auth login  # one-time

anet node create coder \
  --runtime codex-sdk \
  --model gpt-5 \
  --tools Read,Write,Edit,Bash,Glob,Grep
```

::: warning Verification status
codex-sdk passes unit tests but **lacks full end-to-end coverage** (real codex auth regressions are missing). For production runs, smoke-test with a trivial task first.
:::

---

## Cross-runtime mesh

The core value: **dispatch tasks across runtimes on the same Hub**.

```bash
# 1. Claude Code CLI agent — planner using your subscription
anet node create planner --runtime claude-code-cli

# 2. MiniMax agent — translation
anet node create translator \
  --runtime claude-agent-sdk \
  --model MiniMax-M2.7 \
  --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=sk-cp-xxx"

# 3. Codex agent — code writing
anet node create coder --runtime codex-sdk --model gpt-5

# 4. Start all three
anet node start planner
anet node start translator
anet node start coder
```

In the Dashboard, ask `planner`:

> Translate this English passage to Chinese, then have coder write a Python script that writes the result to a file.

`planner` will use commhub MCP tools:
1. `get_all_status` — sees translator + coder online
2. `send_task(alias="translator", task="translate ...")`
3. `get_task` — polls for the translation
4. `send_task(alias="coder", task="write a script ...")`
5. Combines both results and replies to you

The whole flow is visible in real time on the Tasks / Messages dashboard pages.

---

## Cheat sheet

| Goal | Pick |
|---|---|
| Already paying for Claude, no API budget | `claude-code-cli` |
| Domestic Chinese model (MiniMax / DeepSeek / GLM / Kimi) | `claude-agent-sdk` + `ANTHROPIC_BASE_URL` |
| Anthropic official API (stable backend) | `claude-agent-sdk` |
| Code writing / shell | `codex-sdk` |
| Copy / translation / analysis / RAG | `claude-agent-sdk` |
| Full Claude Code toolset (file / Bash / MCP) | `claude-code-cli` |
| Team mesh (planner + translator + coder) | All three, pick per role |

---

## Verified vs not

::: info Verified (v2.1 E2E)
- `claude-agent-sdk` — Anthropic / MiniMax / DeepSeek / GLM / Kimi / InternLM all pass E2E
- Multi-runtime mesh (peer agents auto-coordinate via `get_all_status` + `send_task` + `get_task`)
:::

::: warning Not verified
- `claude-code-cli` — runs locally, no E2E regression
- `codex-sdk` — unit-tested only, real codex auth E2E pending
:::

---

## Next

- [Agent Node configuration](/en/guide/agent-node)
- [Multi-model setup](/en/guide/multi-model)
- [CLI reference](/en/guide/cli)
