# @sleep2agi/agent-node

[![npm version](https://img.shields.io/npm/v/@sleep2agi/agent-node.svg)](https://www.npmjs.com/package/@sleep2agi/agent-node)
[![npm downloads](https://img.shields.io/npm/dm/@sleep2agi/agent-node.svg)](https://www.npmjs.com/package/@sleep2agi/agent-node)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/sleep2agi/agent-network/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-anet.sh-009e7e.svg)](https://anet.sh)

Agent runtime for Agent Network. Connects to a CommHub server, registers under an alias, and processes incoming tasks with Claude, Codex, Codex app-server, Grok Build, or OpenCode ACP runtimes.

The supported entry point is the `anet` CLI from `@sleep2agi/agent-network`, which writes the right `config.json`, network token, and environment variables for you.

## Install

You usually don't install this package directly — `anet node create` and `anet node start` use it via `npx`. To pin it:

```bash
npm install -g @sleep2agi/agent-node
```

For the canonical OpenCode preview, install the entire vetted pair exactly. The OpenCode path does not execute an ambient package or automatic `npx` fallback:

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.34 \
  @sleep2agi/agent-node@2.5.0-preview.26 \
  opencode-ai@1.18.1
```

## Verified flow

```bash
npm install -g @sleep2agi/agent-network
anet hub start                      # local hub (terminal 1)
anet hub dashboard                  # web UI (terminal 2)
anet login --hub http://127.0.0.1:9200 --username admin --password anethub
anet node create my-bot             # two-step picker: runtime, then provider
anet node start my-bot              # → SSE connected
```

The picker writes `.anet/nodes/<name>/config.json`. `anet node start` reads it and runs this package under the hood.

## Direct invocation

For scripts and CI:

```bash
npx @sleep2agi/agent-node --alias my-bot --hub http://127.0.0.1:9200 --tools all
```

CLI flags:

| Flag | Default | Notes |
|---|---|---|
| `--alias` | required | unique name in the hub |
| `--hub` | `http://127.0.0.1:9200` | CommHub URL |
| `--runtime` | `claude-agent-sdk` | `claude-agent-sdk` / `claude-code-cli` / `codex-sdk` / `codex-app-server` / `grok-build-acp` / `opencode-cli` |
| `--model` | runtime default | passed through to the SDK |
| `--tools` | (none) | `all` or comma-separated list |
| `--max-turns` | `50` | upper bound per task |
| `--session` | (none) | resume a prior session / thread |

## Runtimes

| Runtime | Backend | Status | Notes |
|---|---|---|---|
| `claude-agent-sdk` | [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) | verified | Anthropic-compatible API; works with MiniMax, DeepSeek, GLM, Kimi, Anthropic, OpenRouter, or custom endpoints |
| `codex-sdk` | [@openai/codex-sdk](https://www.npmjs.com/package/@openai/codex-sdk) | unverified end-to-end | unit tests pass, no full E2E with real codex auth |
| `claude-code-cli` | local `claude` CLI | unverified end-to-end | runs locally for Claude Pro subscribers (v0.8.2 fixed the session-resume default-loss bug; see [changelog](https://anet.sh/en/changelog)) |
| `codex-app-server` | local `codex app-server` WebSocket | preview, Windows-verified | shares a Codex TUI thread with dispatched network tasks |
| `grok-build-acp` | local `grok agent stdio` | stable runtime, native MCP injection boundary remains preview | requires Grok Build CLI login; stable for receive/reply, session persistence, and explicit CommHub delegation handled by agent-node |
| `opencode-cli` | exact `opencode-ai@1.18.1` ACP child | canonical preview, release-gated | defaults to a launch-scoped external workspace with tools disabled; Anthropic/OpenAI presets |

The canonical preview picker exposes exactly these 6 runtimes. They are loaded lazily; picking one does not pull the others' SDK dependencies. `claude-code-cli` adds zero extra SDK weight.

## Grok Build ACP

`grok-build-acp` runs the local Grok Build CLI over Agent Client Protocol:

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok
anet node create grok-demo --runtime grok-build-acp
anet node start grok-demo
```

The runtime starts `grok agent stdio`, authenticates with the cached Grok login, opens or loads a Grok session, sends the task prompt, collects streamed ACP notifications, and writes `grokSession` back to the node config.

Stable behavior:

- CommHub task delivery and replies are handled by `agent-node`, not by Grok itself.
- Plain text tasks should be answered directly by Grok.
- Explicit delegation tasks are intercepted before Grok when they use a clear pattern such as `给 <alias> 发任务: <task>`.
- Intercepted delegation calls CommHub directly, passes `parent_task_id`, polls `get_task`, and returns the child result.

Known boundary:

- Native Grok MCP tool injection is still experimental. Do not rely on Grok itself seeing `commhub_get_all_status` or `commhub_send_task`.
- Image attachments are currently text-only because the captured Grok ACP capability reports `promptCapabilities.image=false`.
- `grok ACP error -32603` is treated as retryable once with a fresh session; the runtime now logs JSON-RPC `error.data` when Grok provides it.
- Grok tool-state boilerplate such as "Do not attempt to use tools from these servers yet" is stripped from final CommHub replies so users see the actual task answer.

## Provider presets (claude-agent-sdk)

`anet node create` step 2 picks one of these and writes `ANTHROPIC_BASE_URL` + a default model. All Anthropic-compatible HTTP API; `--model` is passed through verbatim.

| Provider | Base URL | Default model | Status |
|---|---|---|---|
| Anthropic | `https://api.anthropic.com` | configured by `--model` | verified |
| MiniMax (国际) | `https://api.minimax.io/anthropic` | `MiniMax-M2.7` | verified |
| MiniMax (国内) | `https://api.minimaxi.com/anthropic` | `MiniMax-M2.7` | verified |
| DeepSeek | `https://api.deepseek.com/anthropic` | `deepseek-chat` | verified |
| GLM (智谱) | `https://open.bigmodel.cn/api/anthropic` | `glm-4-plus` | verified |
| Kimi (Moonshot) | `https://api.moonshot.cn/anthropic` | `moonshot-v1-32k` | verified |
| OpenRouter | `https://openrouter.ai/api/v1` | (user-chosen) | unverified end-to-end |
| Custom | user-supplied | user-supplied | unverified end-to-end |

## Manual env-var examples

```bash
# DeepSeek
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_AUTH_TOKEN=sk-... \
npx @sleep2agi/agent-node --alias deep --hub http://127.0.0.1:9200 --tools all

# MiniMax
ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic \
ANTHROPIC_AUTH_TOKEN=your-key \
npx @sleep2agi/agent-node --alias mini --model <minimax-model-id> --hub http://127.0.0.1:9200 --tools all
```

## Configuration file

Typical output of `anet node create` at `.anet/nodes/<name>/config.json`:

```json
{
  "node_id": "n_a1b2c3d4",
  "node_name": "my-bot",
  "hub": "http://127.0.0.1:9200",
  "token": "ntok_...",
  "runtime": "claude-agent-sdk",
  "model": "<minimax-model-id>",
  "channels": ["server:commhub"],
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimax.io/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-..."
  },
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process",
    "maxTurns": 50
  }
}
```

Per-node config wins over `~/.anet/config.json`; missing fields fall back to global, then defaults.

## Main loop

Same shape across runtimes:

```
start
  → report_status: idle
  → SSE long-poll /events/:alias
  → on new_task: get_inbox → ack_inbox
  → report_status: working
  → run the LLM (with commhub MCP tools injected)
  → send_reply
  → report_status: idle
```

## Peer coordination (verified)

When the agent runs, the commhub MCP tools are auto-injected. The model can call:

- `commhub_get_all_status()` — see who else is online
- `commhub_send_task(alias, task)` — dispatch a sub-task to a peer
- `commhub_get_task(task_id)` — poll for the peer's reply
- `commhub_send_message(alias, message)` — chat without a task lifecycle
- `commhub_report_status(status, task)` — push status update

This is what powers the multi-agent flow demonstrated in `anet hub dashboard` (e.g. ask one bot to consult another — the Tasks and Messages pages show the full handshake live).

## Isolation

When the runtime is `claude-code-cli`, the spawned subprocess gets `settingSources: []` so it doesn't read the host's `~/.claude.json` and accidentally cross networks.

## Companion packages

| Package | Version |
|---|---|
| [@sleep2agi/agent-network](https://www.npmjs.com/package/@sleep2agi/agent-network) | 2.2.10 |
| [@sleep2agi/commhub-server](https://www.npmjs.com/package/@sleep2agi/commhub-server) | 0.8.4 |
| [@sleep2agi/agent-network-dashboard](https://www.npmjs.com/package/@sleep2agi/agent-network-dashboard) | 0.5.6 |

## License

Apache-2.0
