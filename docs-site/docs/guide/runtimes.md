# 节点 Runtime

每个 Agent Node 都有一个 **Runtime**（运行时内核），决定这个节点用什么方式调用大模型 / 跑工具。Agent Network 内置三种 Runtime，**同一个 Hub 上可以混搭**——一个 Claude Code CLI agent 调任务给 MiniMax agent，再让 Codex agent 写代码，结果汇总回来。

## 三种 Runtime 对比

| Runtime | 内核 | 适用场景 | 主推模型 | 鉴权 |
|---|---|---|---|---|
| `claude-code-cli` | spawn 本地 `claude` 命令 | 想"像在终端用 Claude"那样干活 | Claude Sonnet / Opus（订阅） | `claude` CLI 已登录 |
| `claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` | 编程式调用任何 Anthropic 兼容 API | Anthropic / MiniMax / DeepSeek / GLM / Kimi / 书生 / 小米 MiMo / OpenRouter | API Key |
| `codex-sdk` | `@openai/codex-sdk` | 写代码 / 跑命令 | OpenAI Codex（gpt-5 等） | `codex auth login` |

::: tip 不知道怎么选？
- **想白嫖 Claude 订阅** → `claude-code-cli`
- **写文案 / 翻译 / 分析（编程式）** → `claude-agent-sdk`
- **写代码 / 跑命令** → `codex-sdk`
- **用 MiniMax / DeepSeek / GLM / Kimi / 书生 / 小米 MiMo / OpenRouter 等国产模型** → `claude-agent-sdk` + `ANTHROPIC_BASE_URL`
- **混搭（推荐）** → 同一 Hub 全开，每个角色挑最合适的内核
:::

---

## claude-code-cli

复用你**本地已经登录的 Claude CLI 订阅**——不用 API Key、不用 token，跑起来就能干活。

### 前置

`@sleep2agi/agent-network` 自己**不会**帮你装 Claude CLI——它是 spawn 你本机已有的 `claude` 二进制。所以你得先把 CLI 装好、登录好。

**1. 安装 Claude Code CLI**（npm 全局包）：

```bash
npm install -g @anthropic-ai/claude-code
```

**2. 登录 Claude.ai 订阅**（OAuth 流程，浏览器一次性授权）：

```bash
claude auth login        # 显式触发登录（idempotent, 脚本化首选）
# 或
claude                   # 首次启动会自动弹登录提示，按引导走完即可
```

**3. 验证**：

```bash
claude --version
# 期望输出：claude-code 1.x.x（具体版本号可能不同）

which claude
# 期望输出：一个 PATH 上能找到的路径，比如 /usr/local/bin/claude 或 ~/.npm-global/bin/claude
```

**常见坑**：装完 `claude: command not found`。原因是 npm 全局 bin 不在 PATH 上。修复：

```bash
npm config get prefix
# 把输出后面加 /bin 加进你的 PATH，比如：
# export PATH="$(npm config get prefix)/bin:$PATH"
```

写进 `~/.bashrc` / `~/.zshrc` 后 `source` 一下即可。

### 工作原理

```
anet node start  →  spawn 本机 `claude` 二进制子进程
                 ↓
         .mcp.json 注册 commhub: { type: "stdio", command: "bun",
                                   args: [".anet/node-server.js"] }
                 ↓
         claude 二进制 spawn bun .anet/node-server.js 当 stdio MCP server
                 ↓
         node-server.ts 内部把工具调用 HTTP 转发到 CommHub /mcp
```

- 节点启动时 anet CLI 在 cwd 写 `.mcp.json`（[`agent-network/bin/cli.ts:1898 ensureMcpJson`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1898)）+ spawn `claude` 二进制
- claude 按 `.mcp.json` 起一个本地 bun MCP server（`.anet/node-server.js`，[源码](https://github.com/sleep2agi/agent-network/blob/main/agent-network/src/node-server.ts) 用 `StdioServerTransport`）
- 本地 MCP server 内部把 commhub 工具调用 HTTP 转发到 CommHub `/mcp`
- 完整 3 runtime MCP 路径对比 + tool name 命名空间差异见 [架构 → MCP 接入路径](/guide/architecture#mcp-接入路径不同-runtime-不同走法-v0-9-0)

### 适用场景

- 你已经在用 [Claude Code](https://claude.com/claude-code)（claude.ai 订阅）
- 想把日常 Claude session 接入多 Agent 协作
- 不想为 API 单独付费

### 配置示例

```bash
anet node create my-bot --runtime claude-code-cli
anet node start my-bot
```

`config.json`：
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

### 注意

- 需要本机已 `claude --version` 能跑（即 Claude Code CLI 已安装并登录）
- `session` 字段由 `anet node create` 预生成。首次 `anet node start` 会用 `claude --session-id <uuid>` 绑定这个 UUID；之后只要 `~/.claude/projects/<cwd>/<uuid>.jsonl` 已存在，就自动用 `claude --resume <uuid>` 续同一个 Claude Code 对话。
- 与 SDK runtime 的关键差别：CLI runtime 拥有 Claude Code 的全套能力（文件操作 / Bash 执行 / MCP 工具）

---

## claude-agent-sdk

编程式调用 **任意 Anthropic 兼容 API** —— 默认接 Anthropic，也能指 MiniMax / DeepSeek / GLM / Kimi 等国产模型的 Anthropic 兼容 endpoint。

### 前置

这个 runtime **不需要你额外装任何二进制**——`@anthropic-ai/claude-agent-sdk` 在 [`@sleep2agi/agent-node` 的 `dependencies`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/package.json) 里，`npm install -g @sleep2agi/agent-node` 时自动一起装（不是打进 dist 里 bundle，build flag 是 `--external`，但 sub-dep 解析时会拉下来）。你只要装 anet 本体 + 准备好一个 API Key。

**1. 安装 anet**（如果还没装）：

```bash
npm install -g @sleep2agi/agent-network
# 当前 latest 见 https://www.npmjs.com/package/@sleep2agi/agent-network
```

**2. 准备 API Key**（任选一家）：

| Provider | 环境变量 | 申请入口 |
|---|---|---|
| Anthropic | `ANTHROPIC_API_KEY` | https://console.anthropic.com |
| MiniMax | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic` | MiniMax 开放平台 |
| DeepSeek / GLM / Kimi / 书生 / 小米 MiMo / OpenRouter | `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL=<对应 endpoint>` | 各家开放平台 |

国产模型 + OpenRouter 完整 endpoint 表见 [多模型配置](/guide/multi-model)。

**3. 验证**：

```bash
anet --version
# 期望输出：当前 anet 版本号（npm latest tag）

# 启起来一个节点后看进程
anet node start planner
# 期望：日志里能看到 "spawned @anthropic-ai/claude-agent-sdk"，不会因为找不到 SDK 包而崩
```

**常见坑**：节点起来后立刻报 `401 Unauthorized` 或 `invalid x-api-key`。原因是 `ANTHROPIC_AUTH_TOKEN`（国产 endpoint）和 `ANTHROPIC_API_KEY`（Anthropic 直连）这两个变量没分清。修复：

- 接 **api.anthropic.com** → 用 `ANTHROPIC_API_KEY`
- 接 **任何第三方 Anthropic 兼容 endpoint** → 用 `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`

### 工作原理

```
anet node start  →  spawn agent-node 子进程
                 ↓
         @anthropic-ai/claude-agent-sdk → POST ANTHROPIC_BASE_URL
                 ↓
         commhub 工具走 in-process SDK MCP (#102 Option A):
           createSdkMcpServer({ name: "commhub" }) 注册 7 个工具
           handler 转发到 CommHub POST /mcp (JSON-RPC initialize + tools/call)
```

- agent-node 进程通过 SDK 调 Anthropic 兼容 API
- 默认 `api.anthropic.com`，可通过 `ANTHROPIC_BASE_URL` 重定向到任何兼容服务
- `settingSources: []` 完全隔离宿主机配置，不会读你本地的 `~/.claude/`
- LLM 看到的 commhub 工具名是 SDK namespace 化的 **`mcp__commhub__send_task`** 等（单 `commhub` 前缀；非二进制 HTTP MCP 路径）—— 完整 3 runtime MCP 路径对比见 [架构 → MCP 接入路径](/guide/architecture#mcp-接入路径不同-runtime-不同走法-v0-9-0)
- vendor adapter（针对书生 intern 等的 system-prompt bias）也在这层注入 —— 详见 [Vendor 适配层](/concepts/vendor-adapters)

### 适用场景

- 用 Anthropic 直接 API（不想依赖订阅）
- 用 MiniMax / DeepSeek / GLM / Kimi / 书生 / 小米 MiMo 等国产模型（低成本 / 高吞吐 / 国内直连；[完整 provider 表](/guide/multi-model)）
- 需要灵活切 model（不同任务用不同模型）

### 配置示例

**Anthropic 直连**：
```bash
ANTHROPIC_API_KEY=sk-ant-xxx \
anet node create planner \
  --runtime claude-agent-sdk \
  --model <anthropic-model-id>
```

**MiniMax**：
```bash
anet node create translator \
  --runtime claude-agent-sdk \
  --model <minimax-model-id> \
  --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=sk-cp-xxx"
```

`config.json`：
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

### 已验证模型

下表是 `anet node create` 供应商选单（cli.ts `VENDORS` 列表）里 `claude-agent-sdk` runtime 的内置 provider —— **vendor 选单只在选 `claude-agent-sdk` runtime 后才出现**（v0.9.2 起 [#133](https://github.com/sleep2agi/agent-network/issues/133) runtime-first wizard：先选 runtime，`claude-code-cli` / `codex-sdk` 各自 print `auth login` hint 跳过 vendor）。每项的 `baseUrl` + model id 都跑通过真 API 验证：

| Provider | 模型 | `ANTHROPIC_BASE_URL` |
|---|---|---|
| Anthropic | 当前主线 Sonnet / Opus / Haiku（具体型号查 [Anthropic 官方](https://docs.anthropic.com/claude/docs/models-overview)） | （Anthropic 原生，不需设 base URL） |
| MiniMax | 当前主线 M 系列（查 [MiniMax 开放平台](https://platform.minimaxi.com)） | `https://api.minimaxi.com/anthropic` |
| 书生 InternLM | Intern-S2-Preview（默认）/ Intern-S1-Pro（查 [书生](https://chat.intern-ai.org.cn)） | `https://chat.intern-ai.org.cn`（**裸域名，无 `/anthropic` 后缀** —— 跟 MiniMax 等不同） |
| 小米 MiMo | mimo-v2.5-pro（默认）/ v2.5 / v2-pro / v2-omni（查 [小米开放平台](https://platform.xiaomimimo.com)） | `https://token-plan-cn.xiaomimimo.com/anthropic` |

> 来源：[`cli.ts:1336-1397 VENDORS`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1336)。**DeepSeek / GLM / Kimi 等没跑通验证的 provider 故意不进 VENDORS 列表** —— 用「自定义」`custom` 供应商接入（任何 Anthropic 兼容 API 都能填 base URL + model）。

::: tip 模型版本号会变
各家 LLM 厂商每隔几周升级模型，硬编码具体版本号容易过时。**到对应平台拿最新 model id**，填到 `--model` 参数即可。
:::

::: details 国产模型 endpoint 完整列表
查看 [多模型配置](/guide/multi-model) — 每家厂商的 Anthropic 兼容 URL + 示例 key。
:::

---

## codex-sdk

接 **OpenAI Codex CLI** —— 适合写代码、跑命令，工具调用最灵活。

### 前置

`@openai/codex-sdk` 在 [`@sleep2agi/agent-node` 的 optional `peerDependencies`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/package.json) 里（不是常规 deps）—— npm 7+ 默认会跟着 agent-node 一起拉下来，**但 SDK 本身要 spawn 一个 `codex` 二进制**，所以你还得把 codex CLI 全局装一遍。如果 `anet node start` 抛 `Cannot find module '@openai/codex-sdk'`，手动补一下：`npm install -g @openai/codex-sdk`。

**1. 安装 codex CLI**（npm 全局包）：

```bash
npm install -g @openai/codex
```

**2. 登录 OpenAI**（任选其一）：

```bash
# 方式 A：OAuth 流程（推荐，复用 ChatGPT Plus / Pro 订阅）
codex auth login

# 方式 B：直接走 API Key
export OPENAI_API_KEY=sk-xxx
```

**3. 验证**：

```bash
codex --version
# 期望输出：codex 0.x.x（具体版本号可能不同）

codex auth status
# 期望：显示当前登录的 OpenAI 账号 / API key 状态
```

**常见坑**：节点启动时报 `Error: spawn codex ENOENT`。原因是 `codex` 不在 PATH 上——`@openai/codex-sdk` 只是 Node 封装层，实际调用还是要找全局 `codex` 二进制。修复：

```bash
which codex
# 如果空，说明没装或者 npm 全局 bin 没在 PATH 上
npm install -g @openai/codex
# 装完仍然找不到，参见 claude-code-cli 章节的 PATH 修复方法
```

### 工作原理

```
anet node start  →  spawn agent-node 子进程
                 ↓
         agent-node 内调 @openai/codex-sdk 起 codex thread
                 ↓
         codex thread 用 baked-in tools (Read/Write/Edit/Bash/Grep/Glob/WebSearch)
                 ↓
         agent-node 父进程外部维持 SSE + report_status/get_inbox/send_reply
```

- 通过官方 `@openai/codex-sdk` 包驱动 codex thread
- 支持 Read / Write / Edit / Bash / Glob / Grep / WebSearch（codex CLI baked in）
- 鉴权走 `codex auth login`（OAuth 流程）或 `OPENAI_API_KEY`
- **codex thread 不直接调 commhub MCP 工具**（`codexOpts` 不传 `mcpServers`，[`agent-node/src/cli.ts:797`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L797)）—— 多 Agent 派活由 agent-node 父进程外部完成，详见 [架构 → MCP 接入路径](/guide/architecture#mcp-接入路径不同-runtime-不同走法-v0-9-0)

### 适用场景

- 用 OpenAI 官方 Codex / gpt-5 等最新模型
- 需要让 Agent **写代码 / 跑命令 / 操作文件**
- 工具调用 / function calling 强需求

### 配置示例

```bash
codex auth login  # 一次性

anet node create coder \
  --runtime codex-sdk \
  --model <codex-model-id>
```

`config.json`：
```json
{
  "runtime": "codex-sdk",
  "model": "<codex-model-id>"
}
```

::: warning codex-sdk 不吃 `tools`
`codex-sdk` runtime **静默忽略** `--tools` flag 和 `config.json` 的 `tools` 字段（verify [`agent-node/src/cli.ts:690-696`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L690) `codexOpts` 无 `tools` 字段）。工具集由 `codex` CLI 二进制 baked in，不由 anet 配置。`--tools` 只对 `claude-agent-sdk` runtime 生效。
:::

::: warning 验证状态
codex-sdk runtime 单元测试通过，但**端到端验证不全**（缺真实 codex 鉴权回归）。如果你正在跑生产任务，建议先 `anet node start` 后用一个简单任务（"列出当前目录文件"）验证。
:::

::: tip v0.10.0 新增 — `codex-direct-stdio` opt-in 路径（[#141](https://github.com/sleep2agi/agent-network/issues/141)）
v0.10.0 起 agent-node 内嵌一条 **bypass `@openai/codex-sdk` wrapper** 的直 stdio JSON-RPC 客户端路径（~155 LOC，verify [`agent-node@2.4.0`](https://www.npmjs.com/package/@sleep2agi/agent-node)）。开启方式：

```bash
ANET_CODEX_STDIO_DIRECT=1 anet node start <codex-node>
```

启用后 agent-node 走 `spawn('codex', ['app-server'])` + 67-method v2 protocol surface（thread / turn / item / realtime），**绕开** `@openai/codex-sdk` `--mcp-config` HTTP transport 那条 bug 链（[#102](https://github.com/sleep2agi/agent-network/issues/102) hang root cause family），不再受 codex-sdk breaking change 牵制。

**v0.10.x（含当前 v0.10.8 stable）默认仍走 `@openai/codex-sdk` wrapper**（先收 preview 反馈、保 backward-compat）；v0.11.0 计划 default flip 到 stdio direct，wrapper 路径进入 deprecation warning。完整背景见 [v0.10.0 release notes](/preview/v0.10.0#新-runtime-路径-codex-direct-stdio)。
:::

---

## 跨 Runtime 协作（Mesh 派活）

Agent Network 的核心价值：**同一个 Hub 上让不同 Runtime 互相派活**。

```bash
# 1. Claude Code CLI agent —— 用本地订阅当指挥
anet node create planner --runtime claude-code-cli

# 2. MiniMax agent —— 翻译 / 文案
anet node create translator \
  --runtime claude-agent-sdk \
  --model <minimax-model-id> \
  --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=sk-cp-xxx"

# 3. Codex agent —— 写代码
anet node create coder --runtime codex-sdk --model <codex-model-id>

# 4. 三个都启动
anet node start planner
anet node start translator
anet node start coder
```

在 Dashboard 里给 `planner` 发：

> 把这段英文翻译成中文，再让 coder 写一个 Python 脚本把翻译结果写入文件。

`planner` 会通过 commhub MCP 的工具：
1. `get_all_status` — 发现 translator + coder 在线
2. `send_task(alias="translator", task="翻译...")` — 派出翻译任务
3. `get_task` — 轮询拿翻译结果
4. `send_task(alias="coder", task="写一个脚本把这段文字写入 output.txt")` — 派出写代码任务
5. 整合两边结果，回复给你

整个交互在 Dashboard 的 Tasks / Messages 页面**实时可见**。

---

## 取舍 cheat sheet

| 你的需求 | 推荐 Runtime |
|---|---|
| 已经付了 Claude 订阅，不想再付 API | `claude-code-cli` |
| 用国产模型（MiniMax / DeepSeek / GLM / Kimi / 书生 / 小米 MiMo 等） | `claude-agent-sdk` + `ANTHROPIC_BASE_URL` |
| 用 Anthropic 官方 API（稳定后台） | `claude-agent-sdk` |
| 写代码 / 跑 shell 命令 | `codex-sdk` |
| 写文案 / 翻译 / 分析 / RAG | `claude-agent-sdk` |
| 想要 Claude Code 全套能力（文件 / Bash / MCP） | `claude-code-cli` |
| 团队混搭（指挥 + 翻译 + 写代码） | 三个全开，每角色配最合适的 |

---

## 已验证 vs 未验证

::: info 已验证（当前 stable 继承 v2 E2E 覆盖）
- `claude-agent-sdk` runtime 本身 —— E2E 通过
- vendor 维度：`anet node create` 的 [`VENDORS` 列表（cli.ts:1336-1397）](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L1336) 里每个 provider（**Anthropic / MiniMax / 书生 Intern / 小米 MiMo**）的 `baseUrl` + model id 都是 verified-with-real-call 才进列表的
- 多 Runtime 混搭（peer agents 通过 `get_all_status` + `send_task` + `get_task` 自治协调）
:::

::: warning 未验证（请自行评估）
- `claude-code-cli` —— 本机能跑（v0.8.2 修了 session resume 默认丢失 bug，详见 [changelog](/changelog)），未做 E2E 回归
- `codex-sdk` —— 单元测试通过，缺真实 codex 鉴权回归
- **DeepSeek / GLM / Kimi 等没跑通验证的 provider** —— 故意**不进 `VENDORS` 列表**（#104-B 设计：列表里的都是 verified，没验证的不混进去）；要用就走「自定义」`custom` 供应商接入，能用但请自己先验证 endpoint + model id
:::

---

## 下一步

- [Agent Node 配置](/guide/agent-node) — 节点的完整配置文件 / 命令行参数 / 工具控制
- [多模型配置](/guide/multi-model) — 每家国产模型的具体 endpoint / Key / 示例
- [CLI 命令](/guide/cli) — `anet node create` 等命令的全部参数

::: tip 想深入 SDK 层？
本页面是 user how-to。如果你想搞清两个 SDK adapter（`claude-agent-sdk` / `codex-sdk`）在 session / tool / streaming / 计费 / 错误处理上的具体差异，以及 anet wrapper 怎么收敛它们 —— 看 [SDK Deep-dive](/guide/sdk-deep-dive)。
:::
