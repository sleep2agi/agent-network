# @sleep2agi/agent-node

[![npm version](https://img.shields.io/npm/v/@sleep2agi/agent-node.svg)](https://www.npmjs.com/package/@sleep2agi/agent-node)
[![npm downloads](https://img.shields.io/npm/dm/@sleep2agi/agent-node.svg)](https://www.npmjs.com/package/@sleep2agi/agent-node)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/sleep2agi/agent-network/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-anet.sh-009e7e.svg)](https://anet.sh)

Agent runtime for Agent Network. Connects to a CommHub server, registers under an alias, and processes incoming tasks with Claude, Codex, Grok Build, or compatible HTTP runtimes.

The supported entry point is the `anet` CLI from `@sleep2agi/agent-network`, which writes the right `config.json`, network token, and environment variables for you.

## Install

You usually don't install this package directly — `anet node create` and `anet node start` launch it for you. For the experimental `grok-build-cli` co-presence runtime, `anet` capability-checks any global `agent-node` and otherwise runs `npx -y @sleep2agi/agent-node@preview`; no global `agent-node` install is required. To pin the stable package for other runtimes:

```bash
npm install -g @sleep2agi/agent-node
```

## Verified flow

```bash
npm install -g @sleep2agi/agent-network
anet hub start                      # local hub (terminal 1)
anet hub dashboard                  # web UI (terminal 2)
anet login --username admin --password anethub
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
| `--runtime` | `claude-agent-sdk` | `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` / `grok-build-acp` / `grok-build-cli` / `http-api` |
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
| `grok-build-acp` | local `grok agent stdio` | stable runtime, native MCP injection boundary remains preview | requires Grok Build CLI login; stable for receive/reply, session persistence, and explicit CommHub delegation handled by agent-node |
| `grok-build-cli` | local Grok TUI or process-per-turn Grok CLI | dangerous experimental preview | shared TUI is text-only with fixed `[todo_write]`; Linux and exact Grok `0.2.93 (f00f96316d)` required; trusted tasks only |
| `http-api` | OpenAI/Anthropic-compatible HTTP | experimental | reads `ANTHROPIC_*`, `OPENAI_*`, or `MINIMAX_CODING_API_KEY` environment variables |

Runtimes are loaded lazily — picking one doesn't pull the others' dependencies. `claude-code-cli` adds zero extra SDK weight.

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

## Grok shared TUI — experimental preview

> **Not production-ready:** network tasks drive the same TUI and share its conversation context. Approval ownership is not fully hardened. Use only with trusted tasks on a trusted network. This path belongs to the npm `preview` channel and is not a capability claim for `latest`.

The preview is currently supported only on Linux with procfs mounted at `/proc` (including `/proc/self/fd`) and is pinned to build `grok 0.2.93 (f00f96316d)`; the known stable installer prints the same build with an optional trailing ` [stable]`. Install and authenticate that Grok CLI build as the same operating-system user that runs the node:

```bash
grok login
grok --version
```

Use the supported `anet` entry point. In terminal 1:

```bash
anet node create grok-shared --runtime grok-build-cli
anet node start grok-shared
```

In terminal 2 on the same machine and user account:

```bash
anet grok attach grok-shared
```

`anet node start` owns the Grok PTY and the local attach socket. `anet grok attach` relays that same terminal and detaches on `Ctrl-]`. A task delivered by CommHub is submitted into the visible shared session, and the completed answer is routed back to the originating task.

For credential isolation, this preview selects a runtime-owned TUI agent
profile with the exact model-tool inventory `[todo_write]`. Filesystem, shell,
network, media, MCP, scheduler, and subagent tools are unavailable. Generic
`tools` and `maxTurns` settings are rejected in co-presence because pinned
Grok ignores those CLI flags in interactive mode. This is a text-only shared
conversation preview, not a coding runtime.

If no compatible global `agent-node` is installed, `anet` uses `npx -y @sleep2agi/agent-node@preview` to fetch and resolve the package, verifies preview metadata plus the machine-readable `ANET_CAPABILITY_GROK_COPRESENCE_V2` marker, and then launches the resolved entrypoint directly so stop signals reach the real runtime. An older headless-only or V1 co-presence package does not pass this check. First start therefore needs npm registry access or an already populated npm cache. An incompatible global package is not silently allowed to select another runtime.

This preview supports the CommHub inbox lane used by `anet node start`.
Feishu configuration is rejected for `grok-build-cli`: its forked worker log
path is not yet inside this runtime's credential-isolated boundary. The npm
resolver, agent-node parent, Grok probes, PTY, and helper processes each use
an exact from-empty environment; durable pending replies and goal state are
redacted and owner-only. Same-UID host processes remain trusted.

The legacy process-per-turn Grok CLI path uses the same runtime name with an explicit creation flag:

```bash
anet node create grok-turn --runtime grok-build-cli --grok-headless
anet node start grok-turn
```

This headless node cannot be used with `anet grok attach`. It is also distinct from ACP headless mode:

```bash
anet node create grok-acp --runtime grok-build-acp
anet node start grok-acp
```

`grok-build-acp` launches `grok agent stdio`; `grok-build-cli --grok-headless` launches one streaming-JSON Grok CLI turn per task.

The formal native Leader/Policy Gateway design is not shipped by this experimental path. Its Phase 0 protocol freeze, Phase 1A gate, production-grade approval ownership, and `latest` release gate remain locked. See the [Grok co-presence preview guide](../docs/grok-build-cli-preview.md).

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
