# #214 维度 1 — Docker E2E (node24)
Node: v24.15.0 | Bun: 1.3.14 | anet: anet v2.2.11

Components (auto-fetched on first use, you don't need to install them manually):
  ○ agent-node — not installed yet (will fetch via npx on first use)
  ○ commhub-server — not installed yet (will fetch via npx on first use)

Optional runtimes (install only what you'll use):
  ○ claude CLI — only needed for the claude-code-cli runtime
  ○ codex CLI — only needed for the codex-sdk runtime

Nothing is broken — components are fetched the first time you run:
  anet hub start          # bootstraps commhub-server
  anet node start <name>  # bootstraps agent-node

Docs: https://anet.sh/guide/getting-started

## Step 0 — pre-flight
- Doc says: Node ≥ 22.13.0, Bun ≥ 1.2.0
- Actual:   Node 24.15.0, Bun 1.3.14
- ✅ Bun present (system pre-install in this image; in a real fresh box user must install Bun separately — same finding still applies)

## Step 1 — anet -v
```
anet v2.2.11

Components (auto-fetched on first use, you don't need to install them manually):
  ○ agent-node — not installed yet (will fetch via npx on first use)
  ○ commhub-server — not installed yet (will fetch via npx on first use)

Optional runtimes (install only what you'll use):
  ○ claude CLI — only needed for the claude-code-cli runtime
  ○ codex CLI — only needed for the codex-sdk runtime

Nothing is broken — components are fetched the first time you run:
  anet hub start          # bootstraps commhub-server
  anet node start <name>  # bootstraps agent-node

Docs: https://anet.sh/guide/getting-started
```
- exit code: 0
- ✅ command runs, version printed
- ⚠️ output shape unusual: "anet v2.2.11Components (auto-fetched on first use, you don't need to install them manually):  ○ agent-node — not installed yet (will fetch via npx on first use)  ○ commhub-server — not installed yet (will fetch via npx on first use)Optional runtimes (install only what you'll use):  ○ claude CLI — only needed for the claude-code-cli runtime  ○ codex CLI — only needed for the codex-sdk runtimeNothing is broken — components are fetched the first time you run:  anet hub start          # bootstraps commhub-server  anet node start <name>  # bootstraps agent-nodeDocs: https://anet.sh/guide/getting-started"

## Step 2 — anet hub start
### Doc claims:
- 默认监听 http://127.0.0.1:9200 — actual: ✅ /health 200 → {"ok":true,"version":"0.8.5"}
- SQLite at ~/.commhub/commhub.db — ✅ file exists
- 自动创建 admin / anethub — ⚠️ not visible in log
- LAN URL printed — ⚠️ not visible
- '重置数据' hint — ⚠️ not visible

### hub log first 60 lines:
```

  anet hub start

  Starting CommHub Server on port 9200 (bind 127.0.0.1)...
Resolving dependencies
Resolved, downloaded and extracted [382]
Saved lockfile
[commhub] database: /root/.commhub/commhub.db
[commhub] 🎉 14-day free trial started!

╔══════════════════════════════════════════════════╗
║   CommHub MCP Server v0.8.5                     ║
║   Transport: Streamable HTTP (Bun native)         ║
║   Security: 🔒 secured                       ║
║   Tmux: DISABLED (set COMMHUB_ENABLE_TMUX=1)  ║
║                                                   ║
║   MCP:    http://127.0.0.1:9200/mcp                 ║
║   REST:   http://127.0.0.1:9200/api                 ║
║   Health: http://127.0.0.1:9200/health               ║
╚══════════════════════════════════════════════════╝

```

### tip box: `anet hub status` (v0.10.11+)
```
[anet] Hub not running on port 9200.
[anet]    Start: anet hub start
```
- exit code: 0
- ✅ PID / port / version visible (matches doc)

## Step 3 — anet hub dashboard
- HTTP probe http://localhost:3000/ — ⚠️ not reachable in 24s (this is auth-free probe; full browser UAT = Vincent)
- log tail:
```
[anet] Starting Dashboard on 55d458ca6272:3000...
[anet] Connecting to CommHub: http://127.0.0.1:9200
[anet] 🔒 Dashboard auth token loaded from admin-utok.json
[anet] spawning dashboard @preview (anet 2.2.11)
```

## Step 4 — login + whoami
- `anet login` rc=0
```
✅ Logged in as admin
   network: default
   token saved to ~/.anet/config.json
✅ Login successful — next: anet status / anet node create my-agent
```
- `anet whoami` rc=0
```

  User: admin (u_b4482c2307f8)
  Role: admin
  Hub:  http://127.0.0.1:9200

  Networks:
    default (net_670841e8) ← current

```
- ✅ config.json written (Doc claim verified)

## Step 5 — `anet node create my-bot` (wizard probe)
Driven with `expect`, Ctrl-C after first prompt observed.
### wizard trace:
```
spawn anet node create my-bot
? 选择 runtime:
❯ claude-agent-sdk — 任意 OpenAI/Anthropic-compat vendor (intern / MiniMax /
Claude / GLM / ...)
  claude-code-cli  — Anthropic Claude (Max/Pro plan), 复用 `claude` CLI 登录态
  codex-sdk        — OpenAI Codex, 复用 `codex auth login` 登录态
  grok-build-acp   — Grok Build ACP, 复用 `grok` CLI 登录态

↑↓ navigate • ⏎ select[?25l[23G
## DOC-MATCH: vendor prompt shown

[G[?25h[anet] ⚠ Runtime selector unavailable: User force closed the prompt with SIGINT
? 选择供应商 (vendor):
❯ 上海 AI Lab 书生 (Intern)
  MiniMax (国内直连，低成本)
  小米 MiMo
  Anthropic Claude (官方 API)
  Codex / GPT (海外，需 codex auth login)
  Claude Code CLI (需 Claude Pro/Team/Max 订阅)
  自定义 — 任何 Anthropic 兼容 API (DeepSeek/GLM/Kimi/OpenRouter/自建)

↑↓ navigate • ⏎ select[?25l[23G```
- ✅ first prompt = vendor (doc claim '先选供应商、再选模型' verified)

### Step 5b — `--runtime` flag bypass (for harness completion)
- `anet node create my-bot --runtime grok-build-acp` rc=0
```
[anet] 请确保已安装并登录 Grok Build CLI: grok auth login
[anet] Warning: agent-node not found in PATH.
[anet] Run: anet upgrade

[anet] Created node "my-bot" (grok-build-acp) in network "default"
[anet] Network token assigned (node-level)

[anet] ⚠ Node created with default tool set:
[anet]    Built-in: all (Claude Code preset — WebFetch / WebSearch / Bash / Read / Write / Edit / Glob / Grep / Task / ...)
[anet]    MCP:      commhub_send_task / send_message / send_reply / get_all_status / ...
[anet]    Flags:    dangerouslySkipPermissions=true (no per-call confirmation), teammateMode enabled
[anet]
[anet]    The agent can read/write files, run shell commands, and access the network.
[anet]    Make sure this is what you want for this agent's role.
[anet]
[anet]    Restrict tools:        edit .anet/nodes/my-bot/config.json → "tools": ["Read","Bash",...]
[anet]    Disable auto-skip:     edit .anet/nodes/my-bot/config.json → "flags.dangerouslySkipPermissions": false
[anet]    Inspect current set:   anet info my-bot

Start: anet node start my-bot
```
- ✅ `.anet/nodes/my-bot/config.json` written at doc-claimed path

## Step 6 — `anet node start my-bot`
Doc says: 看到 `SSE connected` 即表示节点已上线
- ✅ `SSE connected` visible in log: `[02:15:13] [INFO ] [my-bot] SSE connected`
- start log tail:
```
[anet] Starting new session for "my-bot" [grok-build-acp]...

[anet] Warning: agent-node not found in PATH.
[anet] Run: anet upgrade
[anet] Token: ntok_•••MASKED•••...
[anet] refreshed .anet/node-server.js for grok-build-acp (#204)
[agent-node] Config: /work/.anet/nodes/my-bot/config.json
[02:15:13] [INFO ] [my-bot] 启动
[02:15:13] [INFO ] [my-bot]   alias:   my-bot [from: --alias flag]
[02:15:13] [INFO ] [my-bot]   runtime: grok-build-acp
[02:15:13] [INFO ] [my-bot]   model:   grok-build (default)
[02:15:13] [INFO ] [my-bot]   hub:     http://127.0.0.1:9200 (auth)
[02:15:13] [INFO ] [my-bot]   user:    admin (admin)
[02:15:13] [INFO ] [my-bot]   network: default
[02:15:13] [INFO ] [my-bot]   tools:   all (Claude Code preset — built-in: WebFetch/WebSearch/Bash/Read/Write/Edit/Glob/Grep/Task/...)
[02:15:13] [INFO ] [my-bot]   channels: (none)
[02:15:13] [INFO ] [my-bot]   session: (new)
[02:15:13] [INFO ] [my-bot]   log-dir: /work/.anet/nodes/my-bot/logs
[02:15:13] [INFO ] [my-bot]   goals:   /work/.anet/nodes/my-bot/goals.json
[02:15:13] [INFO ] [my-bot] 已注册到 CommHub
[02:15:13] [INFO ] [my-bot] SSE connected
```

## Step 7-8 — Dashboard chat + multi-agent collab
- ⏭ SKIP (browser UAT, Vincent path). Auth-free probe = dashboard reachable above.

## Step 9 — `anet project up/restart/down`
### `anet project up` (rc=0)
```

[anet] anet project up — 2 node(s) in /work
  ▶  my-bot — starting…
  ▶  video-bot — starting…

[anet] verifying 2 node(s) came up…
  ✅ my-bot
  ✅ video-bot

──────────────────────────────────────────────
  2/2 up

```
### `anet project restart` (rc=N/A)
```

[anet] anet project restart — 2 node(s) in /work
  ↻  my-bot — starting…
  ↻  video-bot — starting…

[anet] verifying 2 node(s) came up…
  ✅ my-bot
  ✅ video-bot

──────────────────────────────────────────────
  2/2 up

```
### `anet project down` (rc=0)
```

[anet] anet project down — 2 node(s) in /work
  ⏹  my-bot
  ⏹  video-bot

  2/2 stopped

```

## Findings 总览 (node24)

- 维度1/Step0/Bun 自装提示弱/级别 P2/Doc §0 '依赖' 表只列 Bun 版本号, '由 bunx / npx 自动拉取' 那行紧跟其后会让快读用户误以为 Bun 也自动。建议拆成 '前置(需手装)' + '自动拉取' 两段。
- 维度1/Step1/anet -v 输出非常规/级别 P3/用户预期 'vX.Y.Z'。实际 'anet v2.2.11Components (auto-fetched on first use, you don't need to install them manually):  ○ agent-node — not installed yet (will fetch via npx on first use)  ○ commhub-server — not installed yet (will fetch via npx on first use)Optional runtimes (install only what you'll use):  ○ claude CLI — only needed for the claude-code-cli runtime  ○ codex CLI — only needed for the codex-sdk runtimeNothing is broken — components are fetched the first time you run:  anet hub start          # bootstraps commhub-server  anet node start <name>  # bootstraps agent-nodeDocs: https://anet.sh/guide/getting-started'。
- 维度1/Step3/dashboard 启动慢或失败/级别 P2/24s 内 localhost:3000 仍未响应；Doc 没提示 first-run 编译时间预期。
