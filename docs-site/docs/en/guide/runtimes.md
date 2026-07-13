# Node Runtime

Every Agent Node has a **Runtime** (engine kernel) that decides how the node calls models and runs tools. Agent Network ships four Runtimes — **and you can mix them on a single Hub**: a Claude Code CLI agent dispatches a translation task to a MiniMax agent, then asks a Codex agent to write code, and merges the results back.

## Four runtimes — canonical table

> This table is the **single source of truth** for the 4 runtimes across the entire site. Other pages (`cli` / `agent-node` / `getting-started` / `clean-server`) reference it — they do not duplicate the full table.

| Runtime | npm package / engine | When to pick | Default models | Prereq auth | Wizard behavior (`anet node create`) |
|---|---|---|---|---|---|
| `claude-code-cli` | spawn local `claude` CLI | "Just use Claude in the terminal" — **zero config if you already have the Claude subscription** | Claude Sonnet / Opus (subscription) | `claude auth login` done | Wizard ends right after pick, **skips vendor / model / API-key** |
| `claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` (bundled with agent-node) | Programmatic access to any Anthropic-compatible API | Anthropic direct / MiniMax / InternLM / Xiaomi MiMo / DeepSeek / GLM / Kimi / OpenRouter / vLLM / SiliconFlow / Qwen / ... ([full table](/en/guide/multi-model)) | API key | **The only runtime that pops the vendor submenu → pick vendor → pick model → enter API key** |
| `codex-sdk` | `@openai/codex-sdk` (bundled with agent-node) | Writing code / running shell commands | OpenAI Codex (gpt-5 etc) | `codex auth login` done ([@openai/codex](https://www.npmjs.com/package/@openai/codex) CLI) | Wizard prints `codex auth login` hint, **skips vendor** |
| `grok-build-acp` | spawn local `grok` ACP server | Run tasks / collaborate via xAI Grok Build | xAI Grok (grok-build series) | `grok login` done + `XAI_API_KEY` env (this runtime **also needs** the env — it's a runtime prereq, not a wizard output) | Wizard prints `grok login` hint, **skips vendor** |

::: tip Not sure which one?
- **Reuse a Claude subscription / smoothest first-time path** → `claude-code-cli` (zero config after `claude auth login`)
- **Writing copy / translation / analysis (programmatic) / using a domestic Chinese model** → `claude-agent-sdk` + pick the matching vendor in the wizard
- **Writing code / running commands** → `codex-sdk`
- **Using xAI Grok Build** → `grok-build-acp` ([detailed runtime guide ↗](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md))
- **Reach a vendor that's NOT in the built-in list** (DeepSeek / GLM / Kimi / OpenRouter / vLLM / SiliconFlow / Qwen ...) → `claude-agent-sdk` + pick `custom` in the vendor submenu + `ANTHROPIC_BASE_URL`
- **Mix and match (recommended)** → run all four on one Hub, pick the best engine per role
:::

::: tip Wizard order at a glance
The real wizard order: `node-name → runtime → (only if claude-agent-sdk) vendor → model → API key / auth`. The 4-way runtime menu **defaults the highlight to `claude-agent-sdk`** (the most complex path: vendor + key required); first-time users should manually pick `claude-code-cli`. Full step-by-step at [Getting Started §5](/en/guide/getting-started#_5-create-an-agent).
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
claude auth login        # Explicit login (idempotent, preferred for scripts)
# or
claude                   # First launch auto-prompts the OAuth flow
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
anet node start  →  spawn the local `claude` binary subprocess
                 ↓
         .mcp.json registers commhub as { type: "stdio", command: "bun",
                                          args: [".anet/node-server.js"] }
                 ↓
         the claude binary spawns bun .anet/node-server.js as a stdio MCP server
                 ↓
         node-server.ts internally forwards tool calls to CommHub /mcp over HTTP
```

- On `anet node start` the anet CLI writes a `.mcp.json` into cwd ([`agent-network/bin/cli.ts ensureMcpJson`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts)) and then spawns the `claude` binary
- The claude binary follows `.mcp.json` and starts a local bun MCP server (`.anet/node-server.js`, [source](https://github.com/sleep2agi/agent-network/blob/main/agent-network/src/node-server.ts) — uses `StdioServerTransport`)
- That local MCP server forwards commhub tool calls to CommHub `/mcp` over HTTP internally
- Full 4-runtime MCP path comparison + tool-name namespace differences: see [Architecture → MCP integration paths](/en/guide/architecture#mcp-integration-paths-per-runtime-v0-9-0)

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
  "session": "550e8400-e29b-41d4-a716-446655440000",
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process"
  }
}
```

### Notes

- Requires a working `claude --version` (Claude Code CLI installed and authenticated)
- `session` is pre-generated by `anet node create`. The first `anet node start` binds that UUID with `claude --session-id <uuid>`; after `~/.claude/projects/<cwd>/<uuid>.jsonl` exists, starts automatically use `claude --resume <uuid>` to continue the same Claude Code conversation.
- Key difference vs the SDK runtime: CLI gives you the full Claude Code toolset (file ops / Bash / MCP)

---

## claude-agent-sdk

Programmatic access to **any Anthropic-compatible API** — Anthropic by default, but redirectable to MiniMax / DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo, etc. via `ANTHROPIC_BASE_URL` (see [Multi-model](/en/guide/multi-model) for the full provider table).

### Prerequisites

This runtime **requires no extra binary** — `@anthropic-ai/claude-agent-sdk` lives in [`@sleep2agi/agent-node`'s `dependencies`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/package.json), so `npm install -g @sleep2agi/agent-node` pulls it in automatically (it's not baked into the dist — the build is marked `--external` — but it gets resolved as a sub-dependency at install time). All you need is anet itself plus an API key.

**1. Install anet** (if you haven't):

```bash
npm install -g @sleep2agi/agent-network
# Current latest tag: https://www.npmjs.com/package/@sleep2agi/agent-network
```

**2. Get an API key** (pick one provider):

| Provider | Env var | Where to get one |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| MiniMax | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic` | MiniMax platform |
| DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo / OpenRouter | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=<provider endpoint>` | Each provider's platform |

Full provider endpoint table: [Multi-model setup](/en/guide/multi-model).

**3. Verify**:

```bash
anet --version
# Expected: the current anet version (npm latest tag)

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
         @anthropic-ai/claude-agent-sdk → POST ANTHROPIC_BASE_URL
                 ↓
         commhub tools live in an in-process SDK MCP server (#102 Option A):
           createSdkMcpServer({ name: "commhub" }) registers 7 tools
           handlers forward to CommHub POST /mcp (JSON-RPC initialize + tools/call)
```

- The agent-node process drives the SDK to call any Anthropic-compatible API
- Override the base URL with `ANTHROPIC_BASE_URL` to redirect to any compatible provider
- `settingSources: []` fully isolates the agent from your local `~/.claude/` config
- The LLM sees the SDK-namespaced commhub tool name **`mcp__commhub__send_task`** etc. (single `commhub` prefix; not the binary HTTP MCP path) — full 4-runtime MCP comparison: [Architecture → MCP integration paths](/en/guide/architecture#mcp-integration-paths-per-runtime-v0-9-0)
- The vendor adapter (e.g. the InternLM system-prompt bias) is injected at this layer — see [Vendor Adapters](/en/concepts/vendor-adapters)

### When to pick

- Direct Anthropic API (no subscription required)
- Domestic Chinese models (MiniMax / DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo, etc. — cheap / high-throughput / fast; [full provider table](/en/guide/multi-model))
- Per-task model switching

### Config

**Anthropic direct**:
```bash
ANTHROPIC_API_KEY=sk-ant-xxx \
anet node create planner \
  --runtime claude-agent-sdk \
  --model <anthropic-model-id>
```

**MiniMax**:
```bash
anet node create translator \
  --runtime claude-agent-sdk \
  --model <minimax-model-id> \
  --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=sk-cp-xxx"
```

### Verified models

The table below is the `claude-agent-sdk` runtime's built-in providers from `anet node create`'s vendor picker (cli.ts `VENDORS` list) — **the vendor picker only fires inside the `claude-agent-sdk` branch** of the runtime-first wizard (since v0.9.2 [#133](https://github.com/sleep2agi/agent-network/issues/133); the wizard first asks you to pick a runtime — `claude-code-cli` / `codex-sdk` skip the vendor picker entirely and just print an `auth login` hint). Every entry's `baseUrl` + model ids are verified-with-real-call before landing:

| Provider | Model | `ANTHROPIC_BASE_URL` |
|---|---|---|
| Anthropic | Latest Sonnet / Opus / Haiku (see [Anthropic Models](https://docs.anthropic.com/claude/docs/models-overview)) | (Anthropic-native, no base URL needed) |
| MiniMax | Latest M-series (see [MiniMax platform](https://platform.minimaxi.com)) | `https://api.minimaxi.com/anthropic` |
| InternLM | Intern-S2-Preview (default) / Intern-S1-Pro (see [InternLM](https://chat.intern-ai.org.cn)) | `https://chat.intern-ai.org.cn` (**bare hostname, no `/anthropic` suffix** — unlike MiniMax et al.) |
| Xiaomi MiMo | mimo-v2.5-pro (default) / v2.5 / v2-pro / v2-omni (see [Xiaomi platform](https://platform.xiaomimimo.com)) | `https://token-plan-cn.xiaomimimo.com/anthropic` |

> Source: [`cli.ts VENDORS`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts). **Providers that haven't passed verification (DeepSeek / GLM / Kimi) are intentionally NOT in the VENDORS list** — reach them via the `custom` vendor (any Anthropic-compatible API accepts a base URL + model there).

::: tip Model IDs change frequently
Providers ship new model versions every few weeks. **Pull the latest model ID from the provider's console** and pass it to `--model`.
:::

::: details Full domestic-provider endpoint list
See [Multi-model config](/en/guide/multi-model) — each provider's Anthropic-compatible URL + sample setup.
:::

---

## codex-sdk

OpenAI **Codex CLI** runtime — best for writing code and running shell commands.

### Prerequisites

`@openai/codex-sdk` lives in [`@sleep2agi/agent-node`'s optional `peerDependencies`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/package.json) (not regular `dependencies`) — npm 7+ pulls it in alongside agent-node by default, **but the SDK spawns a `codex` binary under the hood**, so you still have to install the codex CLI globally. If `anet node start` throws `Cannot find module '@openai/codex-sdk'`, install it manually: `npm install -g @openai/codex-sdk`.

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
anet node start  →  spawn agent-node subprocess
                 ↓
         agent-node imports @openai/codex-sdk and starts a codex thread
                 ↓
         the codex thread uses baked-in tools only (Read/Write/Edit/Bash/Grep/Glob/WebSearch)
                 ↓
         agent-node's parent process handles SSE + report_status / get_inbox / send_reply
```

- Driven by the official `@openai/codex-sdk` package, run as a codex thread
- Supports Read / Write / Edit / Bash / Glob / Grep / WebSearch (baked into the codex CLI)
- Auth via `codex auth login` (OAuth) or `OPENAI_API_KEY`
- **The codex thread does not call commhub MCP tools directly** (`codexOpts` does not pass `mcpServers`, [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts)) — multi-agent dispatch happens externally in agent-node's parent process. See [Architecture → MCP integration paths](/en/guide/architecture#mcp-integration-paths-per-runtime-v0-9-0).

### When to pick

- OpenAI's official Codex / latest gpt-5
- Code generation / shell command execution
- Heavy tool calling / function calling

### Config

```bash
codex auth login  # one-time

anet node create coder \
  --runtime codex-sdk \
  --model <codex-model-id>
```

::: warning codex-sdk ignores `tools`
The `codex-sdk` runtime **silently ignores** the `--tools` flag and the `config.json` `tools` field (verify [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) — `codexOpts` has no `tools` field). The tool set is baked into the `codex` CLI binary, not configured via anet. `--tools` only takes effect for the `claude-agent-sdk` runtime.
:::

::: warning Verification status
codex-sdk passes unit tests but **lacks full end-to-end coverage** (real codex auth regressions are missing). For production runs, smoke-test with a trivial task first.
:::

::: tip v0.10.0 new — `codex-direct-stdio` opt-in path ([#141](https://github.com/sleep2agi/agent-network/issues/141))
As of v0.10.0, agent-node ships an in-tree direct stdio JSON-RPC client (~155 LOC, see [`agent-node@2.4.0`](https://www.npmjs.com/package/@sleep2agi/agent-node)) that **bypasses the `@openai/codex-sdk` wrapper entirely**. Opt in via:

```bash
ANET_CODEX_STDIO_DIRECT=1 anet node start <codex-node>
```

When enabled, agent-node runs `spawn('codex', ['app-server'])` and talks the full 67-method v2 protocol (thread / turn / item / realtime), **sidestepping** the `@openai/codex-sdk` `--mcp-config` HTTP-transport bug family ([#102](https://github.com/sleep2agi/agent-network/issues/102) hang root cause), and no longer being held hostage by codex-sdk breaking changes.

**v0.10.x (including the current stable) still defaults to the `@openai/codex-sdk` wrapper path** (collecting preview feedback first, preserving backward compatibility); v0.11.0 plans to flip the default to the direct stdio path, with the wrapper path moving into a deprecation warning. Full background in the [v0.10.0 GitHub release notes](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.0).
:::

---

## codex-app-server (Codex TUI bridge, RFC-030)

Attach a **codex CLI TUI session** to the network as a node. The node spawns its own standalone `codex app-server` and a bridge subscribes to the same codex thread as a client. Key difference vs `codex-sdk`: `codex-sdk` embeds the SDK and exclusively owns the codex thread, whereas **`codex-app-server` speaks the standard `codex app-server` protocol, where one thread can be subscribed by multiple clients** — so **a codex session you're typing into in the TUI can simultaneously become a network node**.

### Prerequisites

Install the `codex` CLI and log in (same as codex-sdk):

```bash
npm install -g @openai/codex
codex auth login       # or export OPENAI_API_KEY=sk-xxx
codex --version        # expect codex 0.144.0+ (app-server protocol baseline)
```

### How it works

```
anet node start  →  spawn agent-node child (runtime=codex-app-server)
                 ↓
   on a dispatched task: spawn `codex app-server --listen ws://127.0.0.1:<ephemeral>`
                 ↓
   bridge connects → thread/start creates and owns a thread
                 ↓
   inbound send_task → bridge.submitTask → one codex turn → final answer
                 ↓
   reply goes back via a plain CommHub send_task (see "Reply via send_task")
```

- **Receive** (inbound): network `send_task` → node inbox → **through the bridge** → codex runs a turn
- **Send** (outbound): codex answer → **plain CommHub `send_task`** back to the sender (the bridge only wraps "run one codex turn")
- One active turn per thread; a second task **queues FIFO** in the bridge and drains when the in-flight turn (yours or the human TUI's) completes
- **Approvals are human-only**: the bridge never answers an approval; a turn needing approval parks as `waiting_human` for the human TUI

### Two topologies

**① Owned (default)** — the node spawns its own app-server and creates a fresh thread. Multiple codex-app-server nodes are fully independent:

```bash
codex auth login
anet node create codexbridge --runtime codex-app-server
anet node start codexbridge
```

```jsonc
// config.json
{ "runtime": "codex-app-server", "model": "gpt-5.5" }
```

**② Adopt an existing codex session** — make a running codex session a node too. Run a shared app-server + a human `codex --remote` TUI, then point the node config at it:

```jsonc
// config.json
{
  "runtime": "codex-app-server",
  "codexAppServerUrl": "ws://127.0.0.1:24777",  // a running codex app-server
  "codexThreadId": "019f…"                       // the existing thread to adopt
}
```

The bridge attaches as a **second client** and `thread/resume`s that thread. You keep typing in the TUI while the network dispatches tasks into the same thread. `codexThreadId` is written back after first bind, so a restart resumes the same session.

### Reply via send_task (not send_reply)

Measured: the hub's `send_reply` enqueues the reply into the originator's inbox but does **not** SSE-wake the immediate originator — an agent peer only sees it on its next poll. `send_task` fires an immediate `new_task` wake. So **codex-app-server nodes reply to dispatched tasks via `send_task`** (this runtime only; other runtimes are unchanged). Both directions are `send_task`.

### When to use

- You want a **human codex TUI session to also be on the network** (human + agent share one thread)
- You want **multiple independent codex nodes**
- You want the standard `codex app-server` protocol rather than the SDK wrapper

::: warning Verification status (Phase 0A / preview only)
This is the **direct dual-client** design — self-verified against a live codex (bridge 17 + client 12 unit tests, 741 full-suite zero regression, isolated-hub **real-node e2e** `send_task`→codex→`send_task` closed loop PASS), suitable for a **single trusted machine preview**. It is **not yet production-hardened**: the human TUI and the bridge connect directly to codex and can race on an active turn, "approvals are human-only" is code discipline rather than a permission boundary, and the bridge holds the raw app-server control plane. The production shape is a **single upstream Policy Gateway** (serialized arbitration + approvals routed only to the human + a minimal typed enqueue surface). See [RFC-030 §18 + §8 gates](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md).
:::

---

## grok-build-acp

Run agents via [xAI Grok Build](https://x.ai/grok)'s local CLI — the node spawns a local `grok agent stdio` process and talks the Agent Client Protocol (ACP), reusing your host's Grok login. **Formally onboarded in v0.10.8**; v0.10.11 [#204](https://github.com/sleep2agi/agent-network/issues/204) adds per-node isolated cwd to eliminate multi-node identity pollution (already in npm `latest`).

### Prerequisites

- `grok` CLI installed and `grok login` completed on the host
- `XAI_API_KEY` environment variable set
- npm `latest` `agent-network` + `agent-node` (includes the grok `session/prompt` timeout fix; see [troubleshooting → grok-build-acp node task hangs](/en/troubleshooting#grok-build-acp-node-task-hangs-session-prompt-timed-out-after-300000ms-json-rpc-error-32603))

### Start a node

```bash
anet node create my-grok --runtime grok-build-acp
anet node start my-grok
```

### Long-task timeout tuning (`flags.grokAcpTimeoutMs`)

Current behavior: agent-node applies a **hard, overall timeout** to every `session/prompt` call — default **300000 ms (5 minutes)**. Long-running workloads (video generation, large X searches, multi-turn batch tool calls) that exceed 5 min will be rejected client-side and the task gets marked `failed`.

Two ways to raise the cap (env wins over config):

```bash
# 1) Per-shell (export before starting the grok node)
GROK_ACP_TIMEOUT_MS=900000 anet node start my-grok
```

```json
// 2) Persistent (in .anet/nodes/<alias>/config.json)
{
  "runtime": "grok-build-acp",
  "flags": {
    "grokAcpTimeoutMs": 900000
  }
}
```

> Trade-off: raising the cap lets genuinely long jobs finish, but real hangs (the agent is actually stuck, not slow) get caught later. Bump only when a specific job is hitting the wall; don't blindly raise.

::: warning Startup log follows the current latest
Older agent-node versions **do not print a `timeoutMs=...` log line at startup** — the value is read from [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts), but `anet node start` output may not reflect it. If you set this and a task **known to take > 5 min** still times out at 300 s, your `flags.grokAcpTimeoutMs` likely isn't being read (config in the wrong file / env-var name typo). Upgrade to npm `latest` first, then open an [issue](https://github.com/sleep2agi/agent-network/issues/new).
:::

### See also

- [`grok-build-runtime.md` full runtime guide](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md) — Known Limits + debug + preview chain
- [agent-node § grok-build-acp tip](/en/guide/agent-node) — v0.10.11 [#204](https://github.com/sleep2agi/agent-network/issues/204) per-node isolated cwd details
- [troubleshooting → grok-build-acp node task hangs](/en/troubleshooting#grok-build-acp-node-task-hangs-session-prompt-timed-out-after-300000ms-json-rpc-error-32603) — `session/prompt` timeout troubleshooting
- [architecture § Debug tip](/en/guide/architecture) — runtime debug entry point

---

## Cross-runtime mesh

The core value: **dispatch tasks across runtimes on the same Hub**.

```bash
# 1. Claude Code CLI agent — planner using your subscription
anet node create planner --runtime claude-code-cli

# 2. MiniMax agent — translation
anet node create translator \
  --runtime claude-agent-sdk \
  --model <minimax-model-id> \
  --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=sk-cp-xxx"

# 3. Codex agent — code writing
anet node create coder --runtime codex-sdk --model <codex-model-id>

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
| Domestic Chinese model (MiniMax / DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo, etc.) | `claude-agent-sdk` + `ANTHROPIC_BASE_URL` |
| Anthropic official API (stable backend) | `claude-agent-sdk` |
| Code writing / shell | `codex-sdk` |
| Copy / translation / analysis / RAG | `claude-agent-sdk` |
| Full Claude Code toolset (file / Bash / MCP) | `claude-code-cli` |
| Team mesh (planner + translator + coder) | All three, pick per role |

---

## Verified vs not

::: info Verified (current stable line inherits v2 E2E coverage)
- The `claude-agent-sdk` runtime itself — passes E2E
- At the vendor level: every provider in the `anet node create` [`VENDORS` list (cli.ts)](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) (**Anthropic / MiniMax / InternLM / Xiaomi MiMo**) has its `baseUrl` + model ids verified-with-real-call before landing
- Multi-runtime mesh (peer agents auto-coordinate via `get_all_status` + `send_task` + `get_task`)
:::

::: warning Not verified
- `claude-code-cli` — runs locally (v0.8.2 fixed the session-resume default-loss bug, see [changelog](/en/changelog)); no E2E regression yet
- `codex-sdk` — unit-tested only, real codex auth E2E pending
- **DeepSeek / GLM / Kimi and other unverified providers** — intentionally **not in the `VENDORS` list** (#104-B design: the list only holds verified entries, unverified ones don't get mixed in); reach them via the `custom` vendor — usable, but verify the endpoint + model id on your own first
:::

---

## Next

- [Agent Node configuration](/en/guide/agent-node)
- [Multi-model setup](/en/guide/multi-model)
- [CLI reference](/en/guide/cli)

::: tip Going deeper on the SDK layer?
This page is the user how-to. If you want the concrete differences between the two SDK adapters (`claude-agent-sdk` / `codex-sdk`) — session / tools / streaming / cost / error handling — and how the anet wrapper converges them, see [SDK Deep-dive](/en/guide/sdk-deep-dive).
:::
