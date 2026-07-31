# @sleep2agi/agent-node

[![npm version](https://img.shields.io/npm/v/@sleep2agi/agent-node.svg)](https://www.npmjs.com/package/@sleep2agi/agent-node)
[![npm downloads](https://img.shields.io/npm/dm/@sleep2agi/agent-node.svg)](https://www.npmjs.com/package/@sleep2agi/agent-node)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/sleep2agi/agent-network/blob/main/LICENSE)
[![Docs](https://img.shields.io/badge/docs-anet.sh-009e7e.svg)](https://anet.sh)

Agent runtime for Agent Network. Connects to a CommHub server, registers under an alias, and processes incoming tasks with Claude, Codex, Grok Build, or compatible HTTP runtimes.

The supported entry point is the `anet` CLI from `@sleep2agi/agent-network`, which writes the right `config.json`, network token, and environment variables for you.

## Install

You usually don't install this package directly — `anet node create` and `anet node start` use it via `npx`. To pin it:

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
| `--runtime` | `claude-agent-sdk` | `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` / `grok-build-cli` / `grok-build-acp` / `http-api` |
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
| `grok-build-cli` | one local Grok TUI owned through `node-pty` (new profiles), or legacy per-task CLI worker | opt-in, source-only co-presence runtime | `agent-node` arbitrates human/network input; attach with `anet grok attach` |
| `grok-build-acp` | local `grok agent stdio` | stable runtime, native MCP injection boundary remains preview | requires Grok Build CLI login; stable for receive/reply, session persistence, and explicit CommHub delegation handled by agent-node |
| `http-api` | OpenAI/Anthropic-compatible HTTP | experimental | reads `ANTHROPIC_*`, `OPENAI_*`, or `MINIMAX_CODING_API_KEY` environment variables |

Runtimes are loaded lazily — picking one doesn't pull the others' dependencies. `claude-code-cli` adds zero extra SDK weight.

## Grok Build CLI (source-only co-presence runtime)

`grok-build-cli` is still an explicit opt-in source-tree runtime and has not been published to an npm dist-tag. It neither replaces nor deprecates `grok-build-acp`. Newly created profiles default to Option A2 co-presence: `agent-node` owns exactly one real Grok TUI through `node-pty`, while humans attach through a separate owner-only terminal-proxy socket.

```bash
curl -fsSL https://x.ai/cli/install.sh | bash
grok

# Build this source-only agent-node
cd agent-node
bun install
npm run build
cd ..

# From the repository root, anet auto-discovers ./agent-node/dist/cli.js
anet node create grok-demo --runtime grok-build-cli
anet node start grok-demo

# Run in a second terminal; Ctrl-] detaches without stopping the node/TUI
anet grok attach grok-demo
```

For a different project, export `ANET_AGENT_NODE_BIN=/absolute/path/to/agent-node/dist/cli.js`. `anet setup` deliberately does not install an npm stable agent-node that lacks this source-only implementation. Startup requires the probed `grok 0.2.93 (f00f96316d)` build exactly and checks its interactive, leader-socket, session, sandbox, and permission capabilities before opening the TUI.

New configs record `grokCopresence: true` plus absolute `grokLeaderSocket` and `grokAttachSocket` paths. The paths live in an owner-only runtime directory, must be local Unix sockets owned by the current uid, and may not be symlinks. A lifetime lock over `(leader socket, grokCliSession)` prevents a second bridge from adopting the same session. The CLI session field remains deliberately separate from ACP's `grokSession`.

The input arbiter has `idle`, `human_editing`, `human_turn`, `network_turn`, and `recovering` states. Human input has priority and cannot be pre-empted; CommHub tasks wait FIFO and enter the PTY as:

```text
[Agent Network/from=<sender>/task=<task-id>] <message>
```

Only a task registered from SSE can own that correlation; a forged prefix in ordinary terminal input is not trusted. The bridge keeps independent append-only byte cursors for the cwd/session `chat_history.jsonl` and `events.jsonl`, pairing `turn_started.turn_number` with its later top-level `turn_ended`. Only `outcome:"completed"` succeeds. Grok may write many assistant/tool-result records in one turn, so the reply is the last assistant whose `tool_calls` is absent or empty; standalone system-reminder user rows are ignored. Human turns never become CommHub replies.

Option A2 keeps the network identity outside Grok. The TUI receives no real `ntok_`, CommHub environment, or CommHub MCP server, and the wrapper does not write project `.mcp.json` identity. Unprefixed human prompts pass through the explicit-delegation parser; only an unambiguous instruction such as `给 <alias> 发任务: ...` or `send_task <alias> ...` is sent by `agent-node`. Ordinary human/TUI conversation stays local.

Approval ownership also stays with the human TUI. Permission events are correlated by request ID when present, otherwise by tool identity, to one proxied human action; an automatic resolve is fatal. The approval UI accepts only Enter (pinned to allow-once) or Ctrl-C. Persistent-grant digits/navigation, Ctrl+O, Shift+Tab, and slash commands are blocked, and an observed YOLO/auto transition shuts the runtime down. Every spawn rebuilds and reinspects the isolated policy, while project `.grok`, `.claude`, and `.mcp.json` stay sandbox-denied even if absent. A normal PTY failure resumes the same cwd/session without headless fallback or active-turn replay; a failure while approval is pending is terminal.

Profiles created before co-presence, which lack `grokCopresence: true`, remain in the old per-task headless mode. They are never silently migrated and cannot use `anet grok attach`. Use `--grok-headless` during creation to request that compatibility mode explicitly; it retains the prior prompt-file, streaming JSON, custom-sandbox, and test215/test216 contracts.

The co-presence Docker suite is `tests/test219-grok-copresence/`; its saved report is `docs/tests/report-test219.txt`. The existing `grok-build-acp` runtime remains available and is not deprecated for nodes that need the ACP protocol path.

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

- Remote `grok-build-acp` turns never auto-approve ACP permission escalation. The client selects a protocol-declared reject option and fails closed if the server offers only allow choices; `dangerouslySkipPermissions` does not override this network boundary.
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
  → run the selected LLM/runtime (with runtime-specific tool integration)
  → send_reply
  → report_status: idle
```

## Peer coordination (verified)

When supported by the selected runtime, the commhub MCP tools are auto-injected. The model can call:

- `commhub_get_all_status()` — see who else is online
- `commhub_send_task(alias, task)` — dispatch a sub-task to a peer
- `commhub_get_task(task_id)` — poll for the peer's reply
- `commhub_send_message(alias, message)` — chat without a task lifecycle
- `commhub_report_status(status, task)` — push status update

This is what powers the multi-agent flow demonstrated in `anet hub dashboard` (e.g. ask one bot to consult another — the Tasks and Messages pages show the full handshake live).

For co-presence `grok-build-cli`, `agent-node` owns SSE receive/reply and the only PTY. The TUI receives no CommHub MCP or token; deterministic cross-agent delegation stays in the wrapper and requires explicit human wording. Legacy headless profiles keep their earlier custom-sandbox behavior.

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
