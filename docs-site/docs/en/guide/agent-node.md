# Agent Node

Agent Node is the working unit in Agent Network -- it receives tasks, invokes an AI model to process them, and reports results.

::: tip Not sure which Runtime to pick?
- Not sure? Start with `claude-agent-sdk`; `anet node create` walks you through 7 provider presets + custom: MiniMax / DeepSeek / GLM / Kimi / InternLM / OpenRouter / Claude / Custom. Other Anthropic-compatible providers (e.g. Xiaomi MiMo / vLLM) plug in via the "Custom" option + `ANTHROPIC_BASE_URL` env — [full provider table in multi-model.md](/en/guide/multi-model).
- Want AI to **write code / run commands** --> `codex-sdk`
- Want AI to **write copy / translate / analyze** (programmatic API) --> `claude-agent-sdk`
- Want AI to **work like Claude in your terminal** --> `claude-code-cli`
- Want to use **domestic models (MiniMax/DeepSeek/GLM)** --> `claude-agent-sdk` + `ANTHROPIC_BASE_URL`
:::

## Installation

```bash
# Global install
npm install -g @sleep2agi/agent-node

# Or run directly with npx (recommended, no install needed)
npx @sleep2agi/agent-node --help
```

## Runtimes

Agent Node supports three AI runtime engines covering all major models:

### claude-agent-sdk

Based on the [Anthropic Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

| Property | Description |
|------|------|
| **Models** | Latest Claude Sonnet / Opus / Haiku (specific IDs at [Anthropic Models](https://docs.anthropic.com/claude/docs/models-overview)) |
| **Prerequisites** | Anthropic API Key or any Anthropic-compatible API key (MiniMax/DeepSeek/GLM/Kimi, etc.) |
| **Strengths** | Programmatic Anthropic-compatible API calls for stable background agents |
| **Isolation** | `settingSources: []` fully isolates host config |

```bash
npx @sleep2agi/agent-node \
  --alias reasoning-master \
  --runtime claude-agent-sdk \
  --model claude-sonnet-4-6 \
  --hub http://YOUR_IP:9200
```

::: details Prerequisites checklist
- [ ] Anthropic API Key or MiniMax API Key (paid)
- [ ] CommHub Server is running
:::

::: info Verify
After starting, you should see `SSE connected, waiting for tasks...`. If you get an `auth` / `401` / `invalid x-api-key` error: check that `ANTHROPIC_API_KEY` (for api.anthropic.com) or `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` (for a third-party Anthropic-compatible endpoint) is set correctly — see [runtimes — common pitfalls](/en/guide/runtimes#claude-agent-sdk). `claude auth login` is for the `claude-code-cli` runtime and has no effect on the SDK path.
:::

### claude-code-cli

Runs a local Claude Code CLI process -- the same `claude` command you use daily in your terminal.

| Property | Description |
|------|------|
| **Models** | Latest Claude Sonnet / Opus / Haiku (specific IDs at [Anthropic Models](https://docs.anthropic.com/claude/docs/models-overview)) |
| **Prerequisites** | Claude Code installed (`npm i -g @anthropic-ai/claude-code`) |
| **Strengths** | Spawns a `claude` child process with full terminal capabilities |
| **Difference** | vs `claude-agent-sdk`: CLI mode = spawns `claude` process; SDK mode = programmatic API calls |

```bash
npx @sleep2agi/agent-node \
  --alias terminal-assistant \
  --runtime claude-code-cli \
  --model claude-sonnet-4-6 \
  --hub http://YOUR_IP:9200
```

::: details Prerequisites checklist
- [ ] Install Claude Code: `npm install -g @anthropic-ai/claude-code`
- [ ] Verify `claude --version` outputs correctly
- [ ] Run `claude auth login` so your local Claude subscription is active (claude-code-cli reuses the local login state)
- [ ] CommHub Server is running
:::

::: info Verify
After starting, you should see `SSE connected, waiting for tasks...`.
- If you get `claude: command not found`, make sure Claude Code is installed globally
- If you get `auth` / 401, re-run `claude auth login` to refresh the subscription session
:::

::: info claude-code-cli vs claude-agent-sdk
- **claude-code-cli**: Spawns a `claude` child process, just like typing commands in your terminal. Has all Claude Code capabilities (file operations, bash execution, MCP tools, etc.).
- **claude-agent-sdk**: Calls Claude through the programmatic SDK API. Better suited for scenarios that need fine-grained control over `settingSources`, `maxTurns`, and other parameters.
:::

### codex-sdk

Based on the [OpenAI Codex SDK](https://www.npmjs.com/package/@openai/codex-sdk).

| Property | Description |
|------|------|
| **Models** | Codex SDK model (set with `--model`; see OpenAI Codex docs for the current model id) |
| **Prerequisites** | `codex auth login` |
| **Strengths** | Strong code generation, flexible tool use |
| **Tools** | Supports Read / Write / Edit / Bash / Glob / Grep |

```bash
npx @sleep2agi/agent-node \
  --alias code-assistant \
  --runtime codex-sdk \
  --model <codex-model-id> \
  --hub http://YOUR_IP:9200 \
  --tools Read,Write,Edit,Bash,Glob,Grep
```

::: details Prerequisites checklist
- [ ] Install codex CLI: `npm install -g @openai/codex` (`@openai/codex-sdk` is already bundled with `@sleep2agi/agent-node@2.3.0`, but the SDK shells out to the `codex` binary — see [runtimes / codex-sdk prereqs](/en/guide/runtimes#codex-sdk))
- [ ] Run `codex auth login` to authenticate with OpenAI (or `export OPENAI_API_KEY=sk-xxx`)
- [ ] CommHub Server is running
:::

::: info Verify
After starting, you should see `SSE connected, waiting for tasks...`.
- If you get `Error: spawn codex ENOENT`, the `codex` binary isn't on PATH — run `npm install -g @openai/codex` + check `which codex`
- If you get a `codex auth` error, run `codex auth login` (or check the `OPENAI_API_KEY` env)
:::

### claude-agent-sdk + Domestic Models

Routes claude-agent-sdk requests to domestic model APIs via `ANTHROPIC_BASE_URL`, ideal for low-cost scenarios.

| Property | Description |
|------|------|
| **Models** | MiniMax M2.7, InternLM Intern-S1-Pro, DeepSeek, GLM, Kimi, Xiaomi MiMo, etc. |
| **Prerequisites** | API key for the target model |
| **Strengths** | Low cost, high throughput, direct access in China |
| **Mechanism** | Routes requests to compatible APIs via `ANTHROPIC_BASE_URL` |

```bash
# MiniMax
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-minimax-key \
npx @sleep2agi/agent-node \
  --alias minimax-bot \
  --runtime claude-agent-sdk \
  --model <minimax-model-id> \
  --hub http://YOUR_IP:9200

# InternLM
ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn/anthropic \
ANTHROPIC_AUTH_TOKEN=your-intern-key \
npx @sleep2agi/agent-node \
  --alias intern \
  --runtime claude-agent-sdk \
  --model intern-s1-pro \
  --hub http://YOUR_IP:9200
```

::: details Prerequisites checklist
- [ ] API key for the target model (e.g. MiniMax API Key)
- [ ] Set environment variables `ANTHROPIC_BASE_URL` and `ANTHROPIC_AUTH_TOKEN`
- [ ] CommHub Server is running
:::

::: info Verify
After starting, you should see `SSE connected, waiting for tasks...`. If you get a `401` or `auth` error, double-check your API key.
:::

## Command-Line Parameters

```bash
npx @sleep2agi/agent-node [options]
```

| Parameter | Default | Description |
|------|--------|------|
| `--alias` | (required) | Agent name (display name in CommHub) |
| `--hub` | http://127.0.0.1:9200 | CommHub Server address |
| `--runtime` | claude-agent-sdk | Runtime engine (`claude-agent-sdk` / `codex-sdk` / `claude-code-cli`) |
| `--model` | (per runtime default) | AI model name |
| `--tools` | (none) | Available tools, comma-separated |
| `--max-budget` | 0 | Per-task budget cap (USD; 0 means disabled) |
| `--session` | (new) | Resume a specific session |
| `--config` | (auto-detect) | Config file path |

::: info Where token / network come from
The auth token is supplied via the `token` field in `.anet/nodes/<name>/config.json` or the `COMMHUB_TOKEN` env var — **the CLI does not accept a `--token` flag**. The network ID is inferred from the `ntok_` token claim; no manual flag is needed. The agent-node CLI also **does not parse** single-letter short flags (`-a / -h / -r / -m / -t / -s / -c`) — only the long-form flags in the table above are accepted.
:::

## Configuration Files

Agent Node supports multiple configuration methods, from highest to lowest priority:

```mermaid
flowchart TD
    A["Command-line parameters"] --> B["Environment variables"]
    B --> C["File specified via --config"]
    C --> D[".anet/nodes/&lt;name&gt;/config.json"]
    D --> E[".anet/profiles/&lt;name&gt;.json (legacy format)"]
    E --> F[".agent-node.json (legacy format)"]
```

### Full config.json Fields

```json
{
  "anet_version": "0.1.0",
  "node_id": "n_a1b2c3d4",
  "node_name": "code-assistant",
  "token": "ntok_...",
  "runtime": "codex-sdk",
  "model": "<codex-model-id>",
  "session": "",
  "channels": ["server:commhub"],
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic"
  },
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process",
    "maxTurns": 20,
    "logLevel": "info"
  }
}
```

| Field | Type | Description |
|------|------|------|
| `anet_version` | string | Config version |
| `node_id` | string | Stable unique identifier (n_ prefix + 8-char hex) |
| `node_name` | string | Display name, can be renamed |
| `runtime` | string | Runtime: `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` |
| `model` | string | AI model name |
| `session` | string | session/thread ID. For the `claude-code-cli` runtime, `anet node create` pre-generates a UUID (first `start` binds it via `--session-id <uuid>`, restarts auto-`--resume <uuid>` to continue the conversation; v0.8.2 fixed a prior default session-loss bug). For other runtimes, this is the previous session ID for resume |
| `channels` | string[] | Connected channels list |
| `tools` | string[] | Allowed tools list |
| `env` | object | Environment variable overrides |
| `flags` | object | Runtime flags |

## Task Processing Flow

After starting, Agent Node automatically enters a task listening loop:

```mermaid
stateDiagram-v2
    [*] --> ConnectCommHub: report_status(idle)
    ConnectCommHub --> SSEListening: SSE connected
    SSEListening --> EventReceived: new_task / broadcast

    state EventReceived {
        [*] --> FetchInbox: get_inbox
        FetchInbox --> Acknowledge: ack_inbox
        Acknowledge --> CheckType

        state CheckType <<choice>>
        CheckType --> AIProcess: type=task
        CheckType --> LogOnly: type=message/reply

        AIProcess --> ReportWorking: report_status(working)
        ReportWorking --> Think: Invoke AI model
        Think --> ReplyResult: send_reply
        ReplyResult --> [*]
        LogOnly --> [*]
    }

    EventReceived --> SSEListening: Processing complete
    SSEListening --> Reconnect: SSE disconnected
    Reconnect --> SSEListening: Exponential backoff 3s→60s
    SSEListening --> GoOffline: SIGINT/SIGTERM
    GoOffline --> [*]: report_status(offline)
```

### Message Type Filtering

Agent Node only triggers AI processing for `task` type messages:

| Message Type | SSE Event | Agent Behavior |
|---------|---------|-----------|
| task | `new_task` | processInbox -> AI think -> reply |
| broadcast | `broadcast` | processInbox -> AI think -> reply |
| reply | `new_reply` | Log only |
| message | `new_message` | Log only |
| ack | (not pushed) | -- |

This design prevents message loops (A replies to B -> B replies to A -> infinite loop).

## Tool Configuration

### Available Tools

| Tool | Description | Applicable Runtime |
|------|------|-------------|
| `Read` | Read files | codex-sdk |
| `Write` | Write files | codex-sdk |
| `Edit` | Edit files | codex-sdk |
| `Bash` | Execute commands | codex-sdk |
| `Glob` | File search | codex-sdk |
| `Grep` | Content search | codex-sdk |

```bash
# Specify tools
npx @sleep2agi/agent-node --alias coder --tools Read,Write,Edit,Bash,Glob,Grep

# All tools
npx @sleep2agi/agent-node --alias coder --tools all
```

::: warning Security Note
`--tools all` gives the agent full filesystem and command execution permissions. In production, explicitly specify only the tools needed.
:::

## Budget Control

The `--max-budget` parameter controls the maximum spend per task (in USD):

```bash
# Max $0.10 per task
npx @sleep2agi/agent-node --alias coder --max-budget 0.1

# Max $1.00 per task (complex tasks)
npx @sleep2agi/agent-node --alias reasoner --max-budget 1.0
```

When the budget is exceeded, the task automatically stops and returns the current result.

## Lifecycle

The complete Agent Node lifecycle:

| Phase | CommHub Status | Description |
|------|-------------|------|
| Created | (not in CommHub) | `anet node create` generates config.json |
| Registered | idle | `report_status(idle)` |
| Online | idle | SSE connected, waiting for tasks |
| Running | working | Processing a task |
| Error | error | Runtime error |
| Offline | offline | Process exited |
| Deleted | (not in CommHub) | All data cleared |

### Heartbeat

- Automatic `report_status` heartbeat every **3 minutes**
- Server marks as offline after **10 minutes** without a heartbeat
- Heartbeat also returns `inbox_count` for checking pending tasks

### Reconnection

SSE auto-reconnects on disconnect using exponential backoff:

```
Retry interval: 3s → 6s → 12s → 24s → 48s → 60s (cap)
```

Online status is automatically restored after successful reconnection.

### Graceful Shutdown

On SIGINT (Ctrl+C) or SIGTERM:

1. Report `report_status(offline)`
2. Close SSE connection
3. Exit process

If the process crashes (no time to report), CommHub detects via heartbeat timeout and marks offline after 5 minutes.

## Environment Variables

| Variable | Description |
|------|------|
| `COMMHUB_URL` | CommHub Server address |
| `COMMHUB_TOKEN` | Auth token |
| `ALIAS` | Agent alias |
| `RUNTIME` | Runtime engine |
| `MODEL` | AI model |
| `TOOLS` | Tool list (comma-separated) |
| `SYSTEM_PROMPT` | Custom system prompt |
| `ANTHROPIC_BASE_URL` | Model API URL (required when targeting a third-party Anthropic-compatible endpoint) |
| `ANTHROPIC_AUTH_TOKEN` | Model API key — **for third-party Anthropic-compatible endpoints** (MiniMax / DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo / OpenRouter / vLLM, etc.) |
| `ANTHROPIC_API_KEY` | Model API key — **only for direct api.anthropic.com**; don't reuse it for third-party endpoint keys (see [runtimes — claude-agent-sdk pitfalls](/en/guide/runtimes#claude-agent-sdk)) |

::: tip Docker Usage
When running in Docker, environment variables are the most convenient configuration method. See [Docker Deployment](/en/deploy/docker).
:::

## Next steps

**Get started**:
- [One-shot install](/en/guide/one-shot-install) — first agent in 5 minutes after install
- [Hello World](/en/cases/hello-world) — 6-step walkthrough for your first agent cluster

**Configure deeper**:
- [Runtimes](/en/guide/runtimes) — picking between claude-agent-sdk / codex-sdk / claude-code-cli
- [Multi-model](/en/guide/multi-model) — use DeepSeek / MiniMax / Kimi / Claude
- [Channel plugins](/en/guide/channels) — wire agents to Telegram / WeChat / Feishu

**Production**:
- [Docker deployment](/en/deploy/docker) — containerized agents
- [Production deployment](/en/deploy/production) — multi-machine, TLS, backups
- [Dashboard](/en/guide/dashboard) — monitor agent status, tasks, message flow

**Troubleshooting**:
- [Troubleshooting](/en/troubleshooting) — common issues
- `anet doctor --fix` — auto-detects expired ntok_ and other issues
