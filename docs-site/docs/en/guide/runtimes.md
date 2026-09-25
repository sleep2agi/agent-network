# Node Runtime

> This page covers install and auth. For "does feature F work on runtime R / OS O", see the [Support Matrix](/en/guide/support-matrix): that table is tri-state (✅ verified / ❌ verified broken / ❓ not verified); cells that have not been verified are never shown as working.

Every Agent Node has a **Runtime** (engine kernel) that decides how the node calls models and runs tools. Agent Network ships 7 Runtimes: 4 stable (`claude-code-cli` / `claude-agent-sdk` / `codex-sdk` / `grok-build-acp`) and 3 preview (`codex-app-server`, `grok-build-cli`, `opencode-cli`). `anet node create` lists all 7. You can mix them on a single Hub: a Claude Code CLI agent dispatches a translation task to a MiniMax agent, then asks a Codex agent to write code, and merges the results back.

## Runtimes — canonical table {#runtimes-—-canonical-table}

> This table is the **single source of truth** for runtimes across the site. Other pages (`cli` / `agent-node` / `getting-started` / `clean-server`) reference it and do not duplicate the full table.

::: tip Which runtimes are available in which channel
On agent-network `≥ 2.3.0-preview.47`, the `anet node create` runtime picker **lists all seven** on both the `latest` and `preview` channels:

`claude-agent-sdk` / `claude-code-cli` / `codex-sdk` / `codex-app-server` / `grok-build-acp` / `grok-build-cli` / `opencode-cli`

Those versions also ship `anet daemon` and `anet grok attach`.

The older `2.2.x` picker does not include `codex-app-server`, `opencode-cli` or `grok-build-cli`. Check your version with `anet -v`, and read any behavioural claim together with its version.
:::

::: warning "Selectable in the picker" is neither "production-ready" nor "creatable by a daemon"
- **Maturity**: `grok-build-cli` still describes itself in the picker as an experimental preview that only accepts trusted tasks. Listed is not stable.
- **The daemon path**: in newer versions the three co-presence runtimes are in the daemon-side runtime set, so `create_node` no longer refuses them; older versions refuse them. If your daemon refuses to create one of these nodes, upgrade first, or run `anet node create` directly on the machine that will host the node.
- **You still have to supply a `model`**: `node_spec.model` is required by `create_node`, yet a runtime that reuses a subscription login, such as `claude-code-cli`, has no model picker and uses whatever the subscription gives it. Keys and URLs are not required (they travel through the optional `env_refs`), but the model still is.

For the current state of Grok TUI co-presence see the [Grok nodes](/en/guide/grok); `grok-build-acp` does not support attach.
:::

| Runtime | npm package / engine | When to pick | Default models | Prereq auth | Wizard behavior (`anet node create`) |
|---|---|---|---|---|---|
| `claude-code-cli` **⭐ recommended start** | spawn local `claude` CLI | "Just use Claude in the terminal", zero config if you already have the Claude subscription (the first choice if you have one; most stable) | Claude Sonnet / Opus (subscription) | `claude auth login` done | Wizard ends right after pick, skips vendor / model / API-key |
| `claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` (bundled with agent-node) | Programmatic access to any Anthropic-compatible API | Anthropic direct / MiniMax / InternLM / Xiaomi MiMo / DeepSeek / GLM / Kimi / OpenRouter / vLLM / SiliconFlow / Qwen / ... ([full table](/en/guide/multi-model)) | API key | **The only runtime that pops the vendor submenu**: pick vendor → pick model → enter API key |
| `codex-sdk` | `@openai/codex-sdk` (bundled with agent-node) | Writing code / running shell commands | OpenAI Codex (gpt-5 etc) | `codex login` done ([@openai/codex](https://www.npmjs.com/package/@openai/codex) CLI) | Wizard prints a `codex login` hint, skips vendor |
| `grok-build-acp` | spawn local `grok` ACP server | Run tasks / collaborate via xAI Grok Build | xAI Grok (grok-build series) | `grok login` done + `GROK_CODE_XAI_API_KEY` env (this runtime also needs the env; it's a runtime prereq, not a wizard output) | Wizard prints a `grok login` hint, skips vendor |
| `codex-cli` (stored internally as `codex-app-server`, preview) | node-owned codex app-server + bridge | Codex TUI co-presence (human and agent share one thread) | OpenAI Codex (default gpt-5.6-sol) | `codex login` done | Selecting it in the wizard enables co-presence; there is no second mode question |
| `opencode-cli` (preview) | spawn local `opencode` CLI (public sst/opencode, fixed `opencode-ai` version pin) | Use the public opencode CLI as a multi-vendor front-end (unified session / auth abstraction) | Multi-vendor: Anthropic native / OpenAI preset | Install `opencode` CLI (`npm i -g opencode-ai@<pin>`) + pick a vendor preset (Anthropic reads `ANTHROPIC_API_KEY` / OpenAI reads `OPENAI_API_KEY` env) | Wizard prompts to install opencode CLI → pick vendor preset (anthropic / openai); API key read from env, not prompted |

> ⚠️ **`opencode-cli` is still preview**: it is in the `anet node create` menu on both the `latest` and `preview` channels, but treat its maturity as preview.

> 🖥️ **Platforms and model**: `opencode-cli` co-presence runs on Linux and macOS; Windows is not supported. macOS needs
> agent-network ≥ `2.3.0-preview.87` and agent-node ≥ `2.5.0-preview.67`.
> It requires an explicit model (`--model <provider/model>`, e.g. OpenCode's built-in free `opencode/mimo-v2.6-flash-free`, no key needed);
> without one it fails at start with `OpenCode copresence requires an explicit provider/model`. The desktop wizard ≥ 0.2.61 supplies one by default.

> **By default it cannot run `bash`: that is the design, not a fault.** `opencode-cli`'s safe
> default disables every local tool: `bash` / `read` / `glob` / `grep` / `edit` / `write` /
> `list` / `task` / `skill`, plus `question` (unattended, it would wait forever for an interactive
> answer). So a task that says "run this command" is one this node has no capability to execute.
>
> The policy lives in [`child-env.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/runtime/opencode-acp/child-env.ts) — 搜 `buildOpencodePermissionPolicy` (search for that symbol); the ACP and copresence paths read the same switch
> (`agent-node/src/cli.ts`).
>
> ```text
> flags.opencodeUnsafeTools = true    ← enables local tools; trusted tasks only
> ```
>
> `anet node create` prints the policy on the spot (verbatim):
>
> ```text
> [anet]    Built-in disabled: bash / read / glob / grep / edit / write / list / task / skill / question
> [anet]    Cwd:      external disposable workspace (removed after child exit)
> [anet]    Intended for communication and text-only tasks.
> ```
>
> ⚠️ **Enabling it is not a sandbox.** The product's own wording is `This is not a security
> sandbox; use Docker/VM for process and filesystem isolation.`
>
> Note that a missing capability does not look like a failure in the result: a task needing `bash`
> can come back as raw, unexecuted tool-call text, recorded by the hub as completed normally
> (`failed=false`). **The dispatcher only finds out by reading the content.**

> 🌐 **Pointing it at a third-party OpenAI-compatible gateway**: in the default safe mode agent-node
> re-renders the node's `opencode.json` on every start: `provider` keeps only the `anthropic` / `openai` ids with `options`
> emptied (base URLs, custom provider packages and headers are dropped), and the child environment is an allowlist
> (`PATH` / `LANG` / `TZ` / proxy / CA), so `OPENAI_BASE_URL` and friends do not pass through. Hand-editing the node's
> `opencode.json` to add a `baseURL` therefore does nothing in safe mode; the model falls back to the official endpoint.
>
> The way in is `flags.opencodeUnsafeTools = true`: it also stops setting `OPENCODE_DISABLE_PROJECT_CONFIG`, so the
> **workspace root** `opencode.json` is loaded (opencode's log shows `loading path=<workspace>/opencode.json`). Put this there:
>
> ```json
> { "provider": { "anthropic": { "options": { "baseURL": "http://127.0.0.1:<port>/v1" }, "models": { "<model>": {} } } } }
> ```
>
> and start with `--model anthropic/<model>`. **Use the `anthropic` preset, not `openai`**: OpenCode's `openai` preset speaks
> the Responses API (`/v1/responses`), which most compatible gateways do not implement (they answer 500); a custom provider id
> is stripped by the credential allowlist, and the `npm` package of a built-in id cannot be overridden. Credentials still go
> through the `anthropic` preset (`ANTHROPIC_API_KEY` read at create time, or `anet opencode auth-login <node> --provider anthropic`).
>
> Three deployment prerequisites: ① install `opencode-ai@<pin>` into a dedicated npm prefix under
> umask 0022 (a group-writable prefix fails the package identity check with `unsafe directory ownership or mode`);
> ② on hosts without `/run/user/<uid>` the default safe root is unavailable, so point `ANET_OPENCODE_SAFE_BASE` at a 0700
> directory outside `$HOME` (which contains `.claude`) whose parents are not group-writable; ③ agent-node must be the
> **paired version of the anet you run** (each version pairs exactly; a mismatch fails with
> `Refusing to start: an unsupported agent-node could silently select another runtime`).

> OpenCode's built-in Anthropic client sends `x-api-key`. Anthropic-compatible gateways that accept only Bearer authentication, such as Kimi coding, return 401 on that preset; use an OpenCode plugin or custom path that supports the gateway's authentication instead.

> Agent Node does not read environment variables literally named `TOOLS` or `SYSTEM_PROMPT`. Set tools with `--tools` or config `tools`, and the system prompt with `--prompt` or config `systemPrompt`.

::: tip Not sure which one?
- **Reuse a Claude subscription / smoothest first-time path** → `claude-code-cli` (zero config after `claude auth login`)
- **Writing copy / translation / analysis (programmatic) / using a domestic Chinese model** → `claude-agent-sdk` + pick the matching vendor in the wizard
- **Writing code / running commands** → `codex-sdk`
- **Human and Agent sharing one Codex TUI/thread** → choose preview `codex-cli` in the wizard; then `anet node start <alias> --copresence` starts or resumes it ([full guide](/en/guide/codex-copresence))
- **Using xAI Grok Build** → `grok-build-acp` ([detailed runtime guide ↗](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md))
- **Use the public sst/opencode CLI as a multi-vendor front-end (unified session/auth)** → `opencode-cli` (needs the local `opencode` CLI + an Anthropic/OpenAI env key)
- **Reach a vendor that's not in the built-in list** (GLM / Kimi / OpenRouter / vLLM / SiliconFlow / Qwen ...) → `claude-agent-sdk` + pick `custom` in the vendor submenu + `ANTHROPIC_BASE_URL`
- **Mix and match (recommended)** → combine the available runtimes by role on one Hub
:::

::: tip Wizard order at a glance
The wizard order: `node-name → runtime → (only if claude-agent-sdk) vendor → model → API key / auth`. The runtime menu **defaults the highlight to `claude-agent-sdk`** (the most complex path: vendor + key required); first-time users should manually pick `claude-code-cli`. Full step-by-step at [Getting Started §5](/en/guide/getting-started#create-node).
:::

---

## claude-code-cli

Reuses your **already-logged-in Claude CLI session**: no API key, no token, just works.

### Prerequisites

`@sleep2agi/agent-network` **does not** install the Claude CLI for you; it spawns the `claude` binary that's already on your machine. You have to install and authenticate the CLI yourself first.

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

```text
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
- The claude binary follows `.mcp.json` and starts a local bun MCP server (`.anet/node-server.js`, [source](https://github.com/sleep2agi/agent-network/blob/main/agent-network/src/node-server.ts), uses `StdioServerTransport`)
- That local MCP server forwards commhub tool calls to CommHub `/mcp` over HTTP internally
- Per-runtime MCP path comparison + tool-name namespace differences: see [Architecture → MCP integration paths](/en/guide/architecture#mcp-integration-paths-per-runtime-v0-9-0)

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

Programmatic access to **any Anthropic-compatible API**: Anthropic by default, but redirectable to MiniMax / DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo, etc. via `ANTHROPIC_BASE_URL` (see [Multi-model](/en/guide/multi-model) for the full provider table).

### Prerequisites

This runtime **requires no extra binary**: `@anthropic-ai/claude-agent-sdk` lives in [`@sleep2agi/agent-node`'s `dependencies`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/package.json), so `npm install -g @sleep2agi/agent-node` pulls it in automatically (it's not baked into the dist, since the build marks it `--external`, but it gets resolved as a sub-dependency at install time). All you need is anet itself plus an API key.

**1. Install anet** (if you haven't):

```bash
npm install -g @sleep2agi/agent-network
# Current version per channel: https://www.npmjs.com/package/@sleep2agi/agent-network
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
# Expected: the anet version you installed

# Start a node and check the logs
anet node start planner
# Expected: the log shows "spawned @anthropic-ai/claude-agent-sdk" without an SDK-not-found crash
```

**Common failure**: the node starts but immediately hits `401 Unauthorized` or `invalid x-api-key`. Cause: confusion between `ANTHROPIC_AUTH_TOKEN` (third-party endpoints) and `ANTHROPIC_API_KEY` (Anthropic direct). Fix:

- Talking to **api.anthropic.com** → use `ANTHROPIC_API_KEY`
- Talking to **any third-party Anthropic-compatible endpoint** → use `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`

### How it works

```text
anet node start  →  spawn agent-node subprocess
                 ↓
         @anthropic-ai/claude-agent-sdk → POST ANTHROPIC_BASE_URL
                 ↓
         commhub tools live in an in-process SDK MCP server:
           createSdkMcpServer({ name: "commhub" }) registers 7 tools
           handlers forward to CommHub POST /mcp (JSON-RPC initialize + tools/call)
```

- The agent-node process drives the SDK to call any Anthropic-compatible API
- Defaults to `api.anthropic.com`; override the base URL with `ANTHROPIC_BASE_URL` to redirect to any compatible provider
- `settingSources: []` fully isolates the agent from your local `~/.claude/` config
- The LLM sees the SDK-namespaced commhub tool name **`mcp__commhub__send_task`** etc. (single `commhub` prefix; not the binary HTTP MCP path); per-runtime MCP comparison: [Architecture → MCP integration paths](/en/guide/architecture#mcp-integration-paths-per-runtime-v0-9-0)
- The vendor adapter (e.g. the InternLM system-prompt bias) is injected at this layer; see [Vendor adapters](/en/guide/multi-model#vendor-adapters)

### When to pick

- Direct Anthropic API (no subscription required)
- Domestic Chinese models (MiniMax / DeepSeek / GLM / Kimi / InternLM / Xiaomi MiMo, etc.: cheap / high-throughput / fast; [full provider table](/en/guide/multi-model))
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

`config.json`:
```json
{
  "runtime": "claude-agent-sdk",
  "model": "<minimax-model-id>",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-cp-xxx"
  }
}
```

### Verified models

The table below is the `claude-agent-sdk` runtime's built-in providers from `anet node create`'s vendor picker (cli.ts `VENDORS` list). **The vendor picker only appears after you pick the `claude-agent-sdk` runtime**: the wizard asks for the runtime first, and `claude-code-cli` / `codex-sdk` skip the vendor picker and just print an `auth login` hint. Every entry's `baseUrl` + model ids are verified with a real API call before landing:

| Provider | Model | `ANTHROPIC_BASE_URL` |
|---|---|---|
| Anthropic | Latest Sonnet / Opus / Haiku (see [Anthropic Models](https://docs.anthropic.com/claude/docs/models-overview)) | (Anthropic-native, no base URL needed) |
| MiniMax | Latest M-series (see [MiniMax platform](https://platform.minimaxi.com)) | `https://api.minimaxi.com/anthropic` |
| InternLM | Intern-S2-Preview (default) / Intern-S1-Pro (see [InternLM](https://chat.intern-ai.org.cn)) | `https://chat.intern-ai.org.cn` (**bare hostname, no `/anthropic` suffix**, unlike MiniMax et al.) |
| Xiaomi MiMo | mimo-v2.5-pro (default) / v2.5 / v2-pro / v2-omni (see [Xiaomi platform](https://platform.xiaomimimo.com)) | `https://token-plan-cn.xiaomimimo.com/anthropic` |

> Source: [`cli.ts VENDORS`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts). **Providers that haven't passed verification (GLM / Kimi) are intentionally not in the VENDORS list**; reach them via the `custom` vendor (any Anthropic-compatible API accepts a base URL + model there).

::: tip Model IDs change frequently
Providers ship new model versions every few weeks. **Pull the latest model ID from the provider's console** and pass it to `--model`.
:::

::: details Full domestic-provider endpoint list
See [Multi-model config](/en/guide/multi-model): each provider's Anthropic-compatible URL + sample setup.
:::

---

## codex-sdk

OpenAI **Codex CLI** runtime, best for writing code and running shell commands.

### Prerequisites

`@openai/codex-sdk` lives in [`@sleep2agi/agent-node`'s `optionalDependencies`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/package.json) (not regular `dependencies`). npm 7+ pulls it in alongside agent-node by default, **but the SDK spawns a `codex` binary under the hood**, so you still have to install the codex CLI globally. If `anet node start` throws `Cannot find module '@openai/codex-sdk'`, install it manually: `npm install -g @openai/codex-sdk`.

**1. Install codex CLI** (npm global):

```bash
npm install -g @openai/codex
```

**2. Authenticate to OpenAI** (pick one):

```bash
# Option A: OAuth flow (recommended, reuses your ChatGPT Plus / Pro)
codex login

# Option B: raw API key
export OPENAI_API_KEY=sk-xxx
```

**3. Verify**:

```bash
codex --version
# Expected: codex 0.x.x (exact version may differ)

codex login status
# Expected: shows the logged-in OpenAI account or API key state
```

**Common failure**: node startup errors with `Error: spawn codex ENOENT`. Cause: `codex` isn't on your PATH. `@openai/codex-sdk` is just the Node wrapper; the actual `codex` global binary still has to be findable. Fix:

```bash
which codex
# If empty, codex isn't installed or npm's global bin isn't on PATH.
npm install -g @openai/codex
# If still missing, see the PATH fix in the claude-code-cli section.
```

### How it works

```text
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
- Auth via `codex login` (OAuth) or `OPENAI_API_KEY`
- **The codex thread does not call commhub MCP tools directly** (`codexOpts` does not pass `mcpServers`, [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts)); multi-agent dispatch happens externally in agent-node's parent process. See [Architecture → MCP integration paths](/en/guide/architecture#mcp-integration-paths-per-runtime-v0-9-0).

### When to pick

- OpenAI's official Codex / latest gpt-5
- Code generation / shell command execution
- Heavy tool calling / function calling

### Config

```bash
codex login  # one-time

anet node create coder \
  --runtime codex-sdk \
  --model <codex-model-id>
```

`config.json`:
```json
{
  "runtime": "codex-sdk",
  "model": "<codex-model-id>"
}
```

::: warning codex-sdk ignores `tools`
The `codex-sdk` runtime **silently ignores** the `--tools` flag and the `config.json` `tools` field (see `codexOpts` in [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts), which has no `tools` field). The tool set is baked into the `codex` CLI binary, not configured via anet. `--tools` only takes effect for the `claude-agent-sdk` runtime.
:::

::: warning Verification status
codex-sdk passes unit tests but **lacks full end-to-end coverage** (real codex auth regressions are missing). For production runs, start the node with `anet node start` and smoke-test it with a trivial task ("list the files in the current directory") first.
:::

::: tip Optional: the `codex-direct-stdio` path
agent-node ships a direct stdio JSON-RPC client path that bypasses the `@openai/codex-sdk` wrapper (requires agent-network ≥ v0.10.0). Opt in via:

```bash
ANET_CODEX_STDIO_DIRECT=1 anet node start <codex-node>
```

When enabled, agent-node runs `spawn('codex', ['app-server'])` and talks the full v2 protocol surface (thread / turn / item / realtime), **sidestepping** the wrapper's `--mcp-config` HTTP-transport class of problems (such as hung tasks), and no longer being held hostage by codex-sdk breaking changes.

Without this variable the default is still the `@openai/codex-sdk` wrapper. Background in the [v0.10.0 GitHub release notes](https://github.com/sleep2agi/agent-network/releases/tag/v0.10.0).
:::

---

## codex-app-server (Codex TUI bridge) {#codex-app-server-codex-tui-bridge-rfc-030}

> Want a **human and an agent to share one Codex session** (co-presence)? See the full step-by-step [Codex TUI Co-presence (preview)](/en/guide/codex-copresence).

Attach a codex CLI TUI session to the network as a node. The node spawns its own standalone `codex app-server` and a bridge subscribes to the same codex thread as a client. Key difference vs `codex-sdk`: `codex-sdk` embeds the SDK and exclusively owns the codex thread, whereas `codex-app-server` speaks the standard `codex app-server` protocol, where one thread can be subscribed by multiple clients. So **a codex session you're typing into in the TUI can simultaneously become a network node**.

### Prerequisites

Install the `codex` CLI and log in (same as codex-sdk):

```bash
npm install -g @openai/codex
codex login       # or export OPENAI_API_KEY=sk-xxx
codex --version        # expect codex 0.144.0+ (app-server protocol baseline)
```

### How it works

```text
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

- **Receive** (inbound): network `send_task` → node inbox → through the bridge → codex runs a turn
- **Send** (outbound): codex answer → plain CommHub `send_task` back to the sender (the bridge only wraps "run one codex turn")
- One active turn per thread; a second task **queues FIFO** in the bridge and drains when the in-flight turn (yours or the human TUI's) completes
- **Approvals are human-only**: the bridge never answers an approval; a turn needing approval parks as `waiting_human` for the human TUI

### Two topologies

The recommended co-presence entry point is the CLI command, not hand-editing config:

```bash
cd /path/to/project
for v in $(env | sed -n 's/^\(COMMHUB_[A-Za-z0-9_]*\)=.*/\1/p'); do unset "$v"; done
anet node create codexbridge --runtime codex-app-server --copresence
anet node start codexbridge --copresence
tmux attach -t =codexbridge
```

`anet node start <alias> --copresence` orchestrates a dedicated app-server, bridge, and TUI together (including recovery after interruption) and defaults to read-only. See [Codex TUI Co-presence](/en/guide/codex-copresence) for permissions, recovery, stop behavior, and the native-Windows manual WebSocket path.

**① Owned (default)**: the node spawns its own app-server and creates a fresh thread. Multiple codex-app-server nodes are fully independent:

```bash
codex login
anet node create codexbridge --runtime codex-app-server
anet node start codexbridge
```

```jsonc
// config.json
{ "runtime": "codex-app-server", "model": "gpt-5.6-sol" }
```

**② Adopt an existing codex session**: make a running codex session a node too. `--copresence` generates and persists the URL/thread binding automatically. Advanced or native-Windows manual setups may pass it during node creation:

```bash
anet node create codexbridge --runtime codex-app-server \
  --codex-app-server-url ws://127.0.0.1:<free-port> \
  --codex-thread-id <thread-id>
```

The bridge attaches as a second client and `thread/resume`s that thread. The TUI must attach with `codex resume --remote <ws-url> <thread-id>`; do not omit the thread id. Each node must use a dedicated app-server; never share the process-scoped CommHub token across nodes.

### Reply via send_task (not send_reply)

The hub's `send_reply` enqueues the reply into the originator's inbox but **does not SSE-wake the immediate originator**, so an agent peer only sees it on its next poll. `send_task` fires an immediate `new_task` wake. So codex-app-server nodes reply to dispatched tasks via `send_task` (this runtime only; other runtimes are unchanged). Both directions are `send_task`.

### When to use

- You want a **human codex TUI session to also be on the network** (human + agent share one thread)
- You want **multiple independent codex nodes**
- You want the standard `codex app-server` protocol rather than the SDK wrapper

::: warning Maturity (preview)
In the current design the human TUI and the bridge connect directly to the same app-server as two clients, which suits a **single trusted machine preview**. It is not yet production-hardened: the human TUI and the bridge can race on an active turn, "approvals are human-only" is an implementation convention rather than a permission boundary, and the bridge holds the full app-server control plane. Only connect to a trusted Hub and only accept trusted tasks.
:::

---

## grok-build-acp

Run agents via [xAI Grok Build](https://x.ai/grok)'s local CLI: the node spawns a local `grok agent stdio` process and talks the Agent Client Protocol (ACP), reusing your host's Grok login. Each node uses its own working directory, so several grok nodes do not pollute each other's identity.

### Prerequisites

- `grok` CLI installed and `grok login` completed on the host
- `GROK_CODE_XAI_API_KEY` environment variable set
- A recent `agent-network` + `agent-node` (including the grok `session/prompt` timeout fix; upgrade with `anet upgrade`; see [troubleshooting → grok-build-acp node task hangs](/en/troubleshooting#grok-build-acp-node-task-hangs-session-prompt-timed-out-after-300000ms-json-rpc-error-32603))

### Start a node

```bash
anet node create my-grok --runtime grok-build-acp
anet node start my-grok
```

### Long-task timeout tuning (`flags.grokAcpTimeoutMs`)

agent-node applies a hard, overall timeout to every `session/prompt` call, default **300000 ms (5 minutes)**. Long-running workloads (video generation, large X searches, multi-turn batch tool calls) that exceed 5 min will be rejected client-side and the task gets marked `failed`.

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

::: warning The startup log may not show timeoutMs
Older agent-node versions **do not print a `timeoutMs=...` log line at startup**: the value is read from [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts), but `anet node start` output may not reflect it. If a task known to take more than 5 min still times out at 300 s, your `flags.grokAcpTimeoutMs` likely isn't being read (config in the wrong file / env-var name typo). Run `anet upgrade` first, then open an [issue](https://github.com/sleep2agi/agent-network/issues/new).
:::

### See also

- [`grok-build-runtime.md` full runtime guide](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md): Known Limits + debug
- [troubleshooting → grok-build-acp node task hangs](/en/troubleshooting#grok-build-acp-node-task-hangs-session-prompt-timed-out-after-300000ms-json-rpc-error-32603): `session/prompt` timeout troubleshooting
- [architecture § Debug tip](/en/guide/architecture): runtime debug entry point

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
1. `get_all_status`: sees translator + coder online
2. `send_task(alias="translator", task="translate ...")`: dispatches the translation task
3. `get_task`: polls for the translation
4. `send_task(alias="coder", task="write a script ...")`: dispatches the coding task
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

::: info Verified
- The `claude-agent-sdk` runtime itself: passes E2E
- At the vendor level: every provider in the `anet node create` [`VENDORS` list (cli.ts)](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts) (**Anthropic / MiniMax / InternLM / Xiaomi MiMo**) has its `baseUrl` + model ids verified with a real call before landing
- Multi-runtime mesh (peer agents auto-coordinate via `get_all_status` + `send_task` + `get_task`)
:::

::: warning Not verified
- `claude-code-cli`: runs locally; no E2E regression yet
- `codex-sdk`: unit-tested only, real codex auth E2E pending
- **GLM / Kimi and other unverified providers**: intentionally not in the `VENDORS` list (the list only holds verified entries); reach them via the `custom` vendor. Usable, but verify the endpoint + model id on your own first
:::

---

## Next

- [Agent Node configuration](/en/guide/agent-node): full config file / CLI flags / tool control
- [Multi-model setup](/en/guide/multi-model): each provider's endpoint / key / example
- [CLI reference](/en/guide/cli): every flag of `anet node create` and friends
- Design docs: [RFC-029 opencode runtime](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-029-opencode-runtime-integration.md), [RFC-030 Codex TUI bridge](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-030-codex-tui-bridge.md)

::: tip Going deeper on the SDK layer?
This page is the user how-to. If you want the concrete differences between the two SDK adapters (`claude-agent-sdk` / `codex-sdk`) (session / tools / streaming / cost / error handling) and how the anet wrapper converges them, see the repository's [SDK Deep-dive](https://github.com/sleep2agi/agent-network/blob/main/docs/sdk/sdk-deep-dive.en.md) (contributor doc).
:::
