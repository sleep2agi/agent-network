# Agent Node

Agent Node is the working unit in Agent Network -- it receives tasks, invokes an AI model to process them, and reports results.

::: tip Not sure which Runtime to pick?
- Not sure? Start with `claude-agent-sdk` (recommended for newcomers). Since v0.9.2 ([#133](https://github.com/sleep2agi/agent-network/issues/133)) `anet node create` is a **runtime-first wizard**: a 3-way picker chooses `claude-agent-sdk` / `claude-code-cli` / `codex-sdk` first; **only** `claude-agent-sdk` then continues into the vendor picker (built-in `VENDORS` = InternLM / MiniMax / Xiaomi MiMo / Anthropic Claude / Custom — every entry verified-with-real-call). **DeepSeek / GLM / Kimi / OpenRouter / vLLM / SiliconFlow / Qwen and other Anthropic-compatible providers not in the built-in list go through "Custom"** + `ANTHROPIC_BASE_URL` env ([full provider table in multi-model.md](/en/guide/multi-model)). `grok-build-acp` is the 4th runtime; today it's only available via the explicit `--runtime grok-build-acp` flag (not in the 3-way wizard picker yet) — [details on GitHub ↗](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md).
- Want AI to **write code / run commands** --> `codex-sdk`
- Want AI to **write copy / translate / analyze** (programmatic API) --> `claude-agent-sdk`
- Want AI to **work like Claude in your terminal** --> `claude-code-cli`
- Want to use **xAI Grok Build** --> `grok-build-acp` ([details on GitHub ↗](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md))
- Want to use **domestic Chinese models (MiniMax / DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo / OpenRouter, etc.)** --> `claude-agent-sdk` + `ANTHROPIC_BASE_URL` ([full provider table](/en/guide/multi-model))
:::

## Installation

```bash
# Global install
npm install -g @sleep2agi/agent-node

# Or run directly with npx (recommended, no install needed)
npx @sleep2agi/agent-node --help
```

## Runtimes

Agent Node supports four AI runtime engines covering all major models:

### claude-agent-sdk

Based on the [Anthropic Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk).

| Property | Description |
|------|------|
| **Models** | Latest Claude Sonnet / Opus / Haiku (specific IDs at [Anthropic Models](https://docs.anthropic.com/claude/docs/models-overview)) |
| **Prerequisites** | Anthropic API Key, or any Anthropic-compatible API key (MiniMax / DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo / OpenRouter, etc. — full list in [multi-model](/en/guide/multi-model)) |
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
| **Tools** | Codex CLI ships with Read / Write / Edit / Bash / Glob / Grep / WebSearch baked in (**does not honor `--tools`**) |

```bash
npx @sleep2agi/agent-node \
  --alias code-assistant \
  --runtime codex-sdk \
  --model <codex-model-id> \
  --hub http://YOUR_IP:9200
# Note: codex-sdk silently ignores --tools. The toolset is baked into the codex CLI binary.
```

::: details Prerequisites checklist
- [ ] Install codex CLI: `npm install -g @openai/codex` (`@openai/codex-sdk` lives in `@sleep2agi/agent-node`'s optional `peerDependencies`; npm 7+ pulls it in automatically with agent-node, but the SDK shells out to the `codex` binary — see [runtimes / codex-sdk prereqs](/en/guide/runtimes#codex-sdk))
- [ ] Run `codex auth login` to authenticate with OpenAI (or `export OPENAI_API_KEY=sk-xxx`)
- [ ] CommHub Server is running
:::

::: info Verify
After starting, you should see `SSE connected, waiting for tasks...`.
- If you get `Error: spawn codex ENOENT`, the `codex` binary isn't on PATH — run `npm install -g @openai/codex` + check `which codex`
- If you get a `codex auth` error, run `codex auth login` (or check the `OPENAI_API_KEY` env)
:::

### grok-build-acp

Integrates with [xAI Grok Build ACP (Agent Communication Protocol)](https://docs.x.ai/docs/grok-build) by spawning the local `grok` ACP server. This is the 4th runtime — **currently only enabled via the explicit `--runtime grok-build-acp` flag** (not yet in the `anet node create` wizard 3-way picker). Full configuration / Known Limits / Delegation Contract: [grok-build-runtime.md ↗](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md).

| Field | Description |
|------|------|
| **Prerequisites** | `grok` CLI already authenticated + `XAI_API_KEY` env |
| **Strengths** | xAI Grok Build models, ACP-protocol cross-agent collaboration |
| **Tools** | Bundled with Grok ACP, **does not accept `--tools`** |

```bash
npx @sleep2agi/agent-node \
  --alias grok-helper \
  --runtime grok-build-acp \
  --hub http://YOUR_IP:9200
```

::: tip v0.10.11 improvements (shipped to @latest)
- [#201](https://github.com/sleep2agi/agent-network/issues/201) 3-layer fix for delegate refusal (wrapper parser broaden + Grok prompt softening + authorised phrasings list)
- [#204](https://github.com/sleep2agi/agent-network/issues/204) Per-session MCP inject — preview chain history: preview.2 stdio variant structurally fixes the `.mcp.json` shared-identity bug (ACP side); **preview.6 switches transport to HTTP** (Grok calls commhub `/mcp` directly with a Bearer ntok_, bypassing subprocess / bun PATH / stdout-pollution risks entirely); **preview.7 lands on per-node isolated cwd** (Grok CLI also reads cwd `.mcp.json` alongside the ACP injection — two MCP servers coexist and the stale one wins hello; fix: ACP session/new passes a per-node isolated cwd that mirrors user files but omits `.mcp.json`). v0.10.11 final = preview.7 promoted.

See [grok-build-runtime.md Known Limits](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md#known-limits) for the full breakdown.
:::

### claude-agent-sdk + Domestic Models

Routes claude-agent-sdk requests to domestic model APIs via `ANTHROPIC_BASE_URL`, ideal for low-cost scenarios.

| Property | Description |
|------|------|
| **Models** | MiniMax, DeepSeek, GLM, Kimi, InternLM, Xiaomi MiMo, OpenRouter — any Anthropic-compatible endpoint (full provider table: [Multi-model setup](/en/guide/multi-model)) |
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

# InternLM (note: bare hostname, no /anthropic suffix)
ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn \
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
| `--runtime` | claude-agent-sdk | Runtime engine (`claude-agent-sdk` / `codex-sdk` / `claude-code-cli` / `grok-build-acp`) |
| `--model` | (per runtime default) | AI model name |
| `--tools` | (none) | Available tools, comma-separated |
| `--max-budget` | 0 | Per-task budget cap (USD; 0 means disabled) |
| `--session` | (new) | Resume a specific session |
| `--config` | (auto-detect) | Config file path |

::: info Where token / network come from
The auth token is supplied via the `token` field in `.anet/nodes/<name>/config.json` or the `COMMHUB_TOKEN` env var — **the CLI does not accept a `--token` flag**. The network ID is inferred from the `ntok_` token claim; no manual flag is needed. The agent-node CLI also **does not parse** single-letter short flags (`-a / -h / -r / -m / -t / -s / -c`) — only the long-form flags in the table above are accepted.
:::

## Configuration Files

Agent Node supports multiple configuration methods, from highest to lowest priority (verified at [`agent-node/src/cli.ts:100-128`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L100)):

```mermaid
flowchart TD
    A["Command-line parameters<br/>(--alias / --runtime / --model etc.)"] --> B["Environment variables<br/>(COMMHUB_ALIAS / RUNTIME / MODEL / COMMHUB_URL / COMMHUB_TOKEN)"]
    B --> C["File specified via --config"]
    C --> D[".anet/nodes/&lt;ALIAS&gt;/config.json<br/>(v0.8 primary path)"]
    D --> E[".anet/profiles/&lt;ALIAS&gt;.json<br/>(legacy compatibility)"]
    E --> G["~/.anet/config.json<br/>(global fallback — only hub + token fields)"]
    G --> F[".agent-node.json<br/>(legacy compatibility; only when D/E/G are all empty)"]
```

::: tip Global `~/.anet/config.json` fallback
After the project config is loaded, [`cli.ts:123-125`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L123) fills in the missing `hub` and `token` fields from the global `~/.anet/config.json`. **Only these two fields fall back across projects** — `runtime` / `model` / `tools` / `env` must be set via project `config.json` / CLI / env; global config does not cover them. Aligned with the [feedback_config_priority] memory ("project config overrides global at the field level; missing fields fall back to global").
:::

### Full config.json Fields

```json
{
  "anet_version": "0.1.0",
  "node_id": "n_a1b2c3d4",
  "node_name": "code-assistant",
  "token": "ntok_...",
  "runtime": "claude-agent-sdk",
  "model": "<model-id>",
  "session": "",
  "channels": ["server:commhub"],
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
  "logLevel": "info",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic"
  },
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process",
    "maxTurns": 20
  }
}
```

| Field | Type | Description |
|------|------|------|
| `anet_version` | string | Config version |
| `node_id` | string | Stable unique identifier (n_ prefix + 8-char hex) |
| `node_name` | string | Display name, can be renamed |
| `alias` | string | Node alias (the `.anet/nodes/<alias>/` directory name + the display identifier on CommHub; equals `node_name` when not set separately) |
| `runtime` | string | Runtime: `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` / `grok-build-acp` |
| `model` | string | AI model name |
| `session` | string | session/thread ID. For the `claude-code-cli` runtime, `anet node create` pre-generates a UUID (first `start` binds it via `--session-id <uuid>`, restarts auto-`--resume <uuid>` to continue the conversation; v0.8.2 fixed a prior default session-loss bug). For other runtimes, this is the previous session ID for resume |
| `channels` | string[] | Connected channels list |
| `tools` | string[] | Allowed tools list. **`claude-agent-sdk` only**; `codex-sdk` silently ignores it (toolset is baked into the codex binary — see the L109 note above + [runtimes#codex-sdk](/en/guide/runtimes#codex-sdk)) |
| `env` | object | Environment variable overrides |
| `flags` | object | Runtime flags |
| `hub` | string | CommHub Server address override (falls back to the global `~/.anet/config.json` `hub` when unset) |
| `token` | string | Auth token override (falls back to the global config `token` when unset) |
| `network_id` | string | Network ID (usually inferred from `ntok_`, no need to set manually) |
| `systemPrompt` | string | System prompt, prepended to every task (can also use the `--prompt` flag; the `SYSTEM_PROMPT` env var is **not read** — see the note above) |

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

### Default = full Claude Code preset (v0.9.0+, #101 Option B)

Since [#101](https://github.com/sleep2agi/agent-network/issues/101) Option B (anet v0.9.0+), the `claude-agent-sdk` runtime's **default toolset is the full Claude Code preset** — not an empty set. As soon as a node spawns, it can use:

- Filesystem: `Read` / `Write` / `Edit` / `Glob` / `Grep`
- Shell: `Bash` (subject to `dangerouslySkipPermissions=true`, on by default — no per-call confirmation)
- Network: `WebFetch` / `WebSearch`
- Subtasks / notebooks: `Task` / `NotebookEdit` / ...

Plus the 17 MCP tools on the hub side (`commhub_send_task` / `commhub_reply` / ...).

> **Root cause** ([#101](https://github.com/sleep2agi/agent-network/issues/101)): in older versions, with no `tools` field in `config.json`, agent-node passed the SDK `options.tools = undefined`, and the SDK treated that as "no built-in tools". The agent could only call MCP tools and would hallucinate "network restricted" when asked for WebFetch / Bash / Read. Option B forces the fallback to the SDK `{ type: 'preset', preset: 'claude_code' }` sentinel — per the SDK type defs (`sdk.d.ts:1229-1238`), this is the standard way to say "give me the full Claude Code toolset".

### Three `--tools` modes (only for `claude-agent-sdk`)

The `--tools` flag only affects the `claude-agent-sdk` runtime — the `codex-sdk` toolset is baked into the codex CLI (`Read/Write/Edit/Bash/Grep/Glob/WebSearch`, **does not honor** `--tools`); the `claude-code-cli` runtime shares the host's Claude Code toolset and also doesn't go through this flag.

| Input | Effect | Verify |
|------|---------|--------|
| `--tools all` | Full SDK preset (same as above) — single source of truth | [`cli.ts:219`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L219) |
| `--tools Read,Glob,Grep` | Explicit allowlist (string array), bypasses preset — strict sandbox | [`cli.ts:217,220`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L217) |
| Absent / empty string | **Falls back to full preset** (the #101 fix; previously left as `undefined` → empty set) | [`cli.ts:216,221`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L216) |

Actual logic from source ([`agent-node/src/cli.ts:210-221`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L210)):

```ts
const TOOLS_PRESET = { type: "preset" as const, preset: "claude_code" as const };
// Behaviour matrix (sdk.d.ts:1229-1238):
//   --tools "all"       → SDK preset (full Claude Code tool set)
//   --tools "Read,Bash" → explicit allowlist
//   --tools "" (absent) → SDK preset (the #101 fix; previously left empty)
const TOOLS_EXPLICIT = toolsRaw === "all" ? null : toolsRaw.split(",").filter(Boolean);
let TOOLS: string[] | typeof TOOLS_PRESET =
  toolsRaw === "all" ? TOOLS_PRESET
  : (TOOLS_EXPLICIT && TOOLS_EXPLICIT.length) ? TOOLS_EXPLICIT
  : TOOLS_PRESET;
// ... cli.ts:653: tools: TOOLS  ← passed to claude-agent-sdk query options (preset or string[])
```

```bash
# Default (no --tools) → full Claude Code preset
npx @sleep2agi/agent-node --alias coder

# Explicit "all" → same preset (single source of truth, replaces the old hardcoded 8-tool list)
npx @sleep2agi/agent-node --alias coder --tools all

# Explicit allowlist (read-only agent) — bypasses the preset
npx @sleep2agi/agent-node --alias coder --tools Read,Glob,Grep

# codex-sdk silently ignores --tools
npx @sleep2agi/agent-node --alias coder --runtime codex-sdk
# Codex has Read/Write/Edit/Bash/Grep/Glob/WebSearch baked in — you cannot detach individual tools.
```

### `anet node create` behavior-disclosure banner (Vincent push, [#101](https://github.com/sleep2agi/agent-network/issues/101))

After a successful `anet node create <alias>`, agent-node prints a **behavior-disclosure banner**: the built-in tools (explicit list or `all (Claude Code preset)`) + MCP tools + current flags (`dangerouslySkipPermissions=true` / `teammateMode=true`) + a one-liner "the agent can read/write files, run shell commands, and access the network". The banner is printed at the end of `createCommand` in [agent-network/bin/cli.ts](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) — so **you actually see what the agent can do** and decide whether to sandbox it.

> **⚠ User responsibility**: the default preset + default `dangerouslySkipPermissions=true` means once the agent starts it can **edit files, run shell commands, and access the network without confirmation prompts**. See [Security → Tool Permissions](/en/concepts/security#tool-permissions-default-claude-code-preset-user-responsibility).

::: warning Security note
- Default preset + default yolo mode (`dangerouslySkipPermissions`) — don't run agents directly from `$HOME`; use a disposable working directory
- For strict sandbox: `--tools Read,Glob,Grep` gives a read-only agent
- To turn off yolo mode: `anet node create --no-skip-permissions` (every tool call prompts, hurts long-task UX)
- Per-task budget cap: `--max-budget 0.1` (see [Budget Control](#budget-control) below)
:::

### Vendor adapter layer (InternLM / 书生 etc.)

On some vendor endpoints, `claude-agent-sdk` follows its RLHF defaults and drifts from Anthropic standard (canonical case: intern-s2-preview does not emit `tool_use` content blocks and falls back to verbose Thinking Process text). agent-node uses a **vendor adapter** to detect by `ANTHROPIC_BASE_URL` and inject a system-prompt bias that nudges behavior back — see [Vendor Adapters](/en/concepts/vendor-adapters) for the full mechanism, the 5 side effects, and the opt-out path.

## Budget Control

The `--max-budget` parameter caps the maximum spend per task (in USD) — **only effective for the `claude-agent-sdk` runtime**:

```bash
# Max $0.10 per task (claude-agent-sdk)
npx @sleep2agi/agent-node --alias coder --max-budget 0.1

# Max $1.00 per task (complex tasks)
npx @sleep2agi/agent-node --alias reasoner --max-budget 1.0
```

Verified at [`agent-node/src/cli.ts:580`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L580):
```ts
if (MAX_BUDGET > 0) options.maxBudgetUsd = MAX_BUDGET;  // passed to claude-agent-sdk query options
```

When `SDKResultMessage.total_cost_usd` reaches `maxBudgetUsd`, claude-agent-sdk automatically ends the turn and the task moves to `error_max_budget`.

::: warning codex-sdk / claude-code-cli runtime do not support a USD budget cap
- The `codex-sdk` path ([`cli.ts:669-755 processWithCodex`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L669)) does not read `MAX_BUDGET`; **`--max-budget` is silently ignored**. Codex-sdk only reports token counts (`TurnCompletedEvent.usage`), not USD — you have to derive cost from your own model→price table (aligned with the sdk-deep-dive chain).
- `claude-code-cli` runs against your local Claude Code subscription, counted against subscription quota rather than USD.
- **Cross-runtime budget control**: put a reverse proxy in front (nginx / Cloudflare / litellm proxy) and throttle by model-API call count.
:::

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
Retry interval (v0.10.11 stable): 3s → 6s → 12s → 24s → 48s → 60s (cap)
```

Online status is automatically restored after successful reconnection.

::: tip preview channel improvements ([#202](https://github.com/sleep2agi/agent-network/issues/202), not yet promoted to latest)
Three changes ship together on the preview-channel `agent-node`:
- **Tighter backoff**: `1s → 2s → 4s → 8s → 16s → 30s (cap)` — full reconnect within 30s of hub restart
- **Re-register on reconnect**: previously a reconnect only restored the SSE stream, not the registration — after a hub restart the dashboard wouldn't see the node until the next 3-minute heartbeat. Now every successful reconnect re-fires the node registration (idempotent upsert on the hub), so the dashboard recovers in under 30s
- **Zombie-retry guard**: if reconnect failures continue for over 1 hour, agent-node gives up auto-retry, logs an error, and stops burning CPU

Pairs with the `anet hub stop` / `hub status` commands in v0.10.11 latest (already shipped): during hub maintenance, `stop → start` no longer requires a follow-up `anet project restart` — nodes restore themselves. Once #202 is promoted to `@latest` in a future release, every user gets this automatically.
:::

### Graceful Shutdown

On SIGINT (Ctrl+C) or SIGTERM:

1. Report `report_status(offline)`
2. Close SSE connection
3. Exit process

If the process crashes (no time to report), CommHub detects via heartbeat timeout and marks the agent offline after **10 minutes** (verified at [`server/src/index.ts:816-821`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L816) `Date.now() - 10 * 60 * 1000` cutoff, lazily triggered on `/api/status` calls).

## Environment Variables

Only the env vars that agent-node actually reads from `process.env` (verified at [`agent-node/src/cli.ts:100-260`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L100)):

| Variable | Equivalent CLI flag / config field | Description |
|------|------------------------------|------|
| `COMMHUB_URL` | `--hub` / `--url` / `config.hub` | CommHub Server address (cli.ts:158) |
| `COMMHUB_TOKEN` | `config.token` / `globalConfig.token` | Auth token (cli.ts:186; **no CLI flag accepted**) |
| `COMMHUB_ALIAS` / `ALIAS` | `--alias` / `config.alias` | Agent alias — both env var names work (cli.ts:109) |
| `RUNTIME` | `--runtime` / `config.runtime` | Runtime engine, defaults to `claude-agent-sdk` |
| `MODEL` | `--model` / `config.model` | AI model |
| `LOG_LEVEL` | `--log-level` / `config.logLevel` (**top-level**, not under `flags`) | `debug` / `info` / `warn` / `error` |
| `ANET_NETWORK_ID` | `config.network_id` / `globalConfig.network_id` | Network ID fallback (typically inferred from `ntok_`; cli.ts:356) |
| `TELEGRAM_BOT_TOKEN` | channel `.env` / `config.env.TELEGRAM_BOT_TOKEN` | Bot token for the Telegram channel — agent-node reads it directly in the telegram channel startup path (cli.ts:259); the allowlist comes from `access.json`, not env (see [Channel — Telegram](/en/guide/channels#telegram-channel)) |
| `CLAUDE_TIMEOUT_MS` | `--claude-timeout-ms` / `config.flags.claudeTimeoutMs` / `config.claudeTimeoutMs` | Per-query timeout (ms) for the `claude-agent-sdk` runtime, default **`300000` (300s)** (raised from 120s in v0.9.2 by [#132 Tier 1](https://github.com/sleep2agi/agent-network/issues/132) — the [SDK concurrency investigation](https://github.com/sleep2agi/agent-network/blob/main/docs/research/sdk-concurrency-investigation.md) measured intern API per-request latency stretching to 17-37s under heavy fan-out, so the old 120s ceiling fired mid-stream and 25/30 sub-agents silently failed); on timeout it aborts and returns an error suggesting you check `ANTHROPIC_BASE_URL` reachability. Verify [`agent-node/src/cli.ts:241-243`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L241) |
| `CLAUDE_MAX_RETRIES` | `--claude-max-retries` / `config.flags.claudeMaxRetries` / `config.claudeMaxRetries` | Retry count for `claude-agent-sdk` runtime queries that fail. Default **`2`** (3 attempts total including the initial). Each attempt runs its own `CLAUDE_TIMEOUT_MS` window; on transient errors / timeouts, backs off `4s, 8s + 0-1s jitter` (the jitter spreads herd retries so a recovering vendor queue isn't slammed). **Auth-class errors do not retry** ([#129 fast-fail](https://github.com/sleep2agi/agent-network/issues/129): the `isAuthError` regex matches 401 / 403 / `invalid_api_key` / intern A02xx etc. and returns a FATAL with the vendor-specific URL hint). Set `0` to revert to v0.9.1 behavior (no retry). Introduced in v0.9.2 via [#132 Tier 1](https://github.com/sleep2agi/agent-network/issues/132). Verify [`agent-node/src/cli.ts:250-253`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L250) + retry loop [`cli.ts:729-792`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L729) |
| `ANET_CODEX_STDIO_DIRECT` | env only (no CLI flag / config field; per-spawn injection) | **v0.10.0+, only takes effect when `runtime=codex`** (claude-agent-sdk / claude-code-cli ignore it). Set `=1` to switch the codex runtime from the `@openai/codex-sdk` wrapper to the **direct stdio JSON-RPC client** path: agent-node runs `spawn('codex', ['app-server'])` with a ~155 LOC stdio client and the full 67-method v2 protocol surface (thread / turn / item / realtime), **bypassing** the wrapper's `--mcp-config` HTTP-transport bug family ([#102](https://github.com/sleep2agi/agent-network/issues/102) hang root cause). v0.10.x (including the current v0.10.13 stable) **still defaults to the wrapper** (preview-feedback window + backward compat); v0.11.0 plans to flip the default, at which point the toggle becomes `ANET_CODEX_LEGACY_SDK=1` opt-out (per [`agent-node/src/cli.ts:1043-1048` comments](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L1043)). Introduced in v0.10.0 via [#141](https://github.com/sleep2agi/agent-network/issues/141). Verify [`agent-node/src/cli.ts:1048` `if (process.env.ANET_CODEX_STDIO_DIRECT === "1")`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L1048) |
| `ANTHROPIC_BASE_URL` | `config.env.ANTHROPIC_BASE_URL` | Model API URL (required when targeting a third-party Anthropic-compatible endpoint) |
| `ANTHROPIC_AUTH_TOKEN` | `config.env.ANTHROPIC_AUTH_TOKEN` | Model API key — **for third-party Anthropic-compatible endpoints** (MiniMax / DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo / OpenRouter / vLLM, etc.) |
| `ANTHROPIC_API_KEY` | `config.env.ANTHROPIC_API_KEY` | Model API key — **only for direct api.anthropic.com**; don't reuse it for third-party endpoint keys (see [runtimes — claude-agent-sdk pitfalls](/en/guide/runtimes#claude-agent-sdk)) |

::: warning `TOOLS` / `SYSTEM_PROMPT` env vars do not exist
The previously listed `TOOLS` and `SYSTEM_PROMPT` env vars are **not read** by agent-node (verified: cli.ts:161 `toolsRaw = opts.tools || fileConfig.tools` has no `process.env.TOOLS`; cli.ts:180 `SYSTEM_PROMPT = opts.prompt || fileConfig.systemPrompt` has no env reading). To set tools, use the `--tools` CLI flag or `config.json`'s `tools` field; for the system prompt, use the `--prompt` flag or `config.json`'s `systemPrompt` field.
:::

::: tip Docker Usage
When running in Docker, environment variables are the most convenient configuration method. See [Docker Deployment](/en/deploy/docker).
:::

## Next steps

**Get started**:
- [One-shot install](/en/guide/one-shot-install) — first agent in 5 minutes after install

**Configure deeper**:
- [Runtimes](/en/guide/runtimes) — picking between claude-agent-sdk / codex-sdk / claude-code-cli / grok-build-acp
- [Multi-model](/en/guide/multi-model) — use DeepSeek / MiniMax / Kimi / Claude
- [Channel plugins](/en/guide/channels) — wire agents to Telegram / WeChat / Feishu

**Production**:
- [Docker deployment](/en/deploy/docker) — containerized agents
- [Production deployment](/en/deploy/production) — multi-machine, TLS, backups
- [Dashboard](/en/guide/dashboard) — monitor agent status, tasks, message flow

**Troubleshooting**:
- [Troubleshooting](/en/troubleshooting) — common issues
- `anet doctor --fix` — auto-detects expired ntok_ and other issues
