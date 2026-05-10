# 节点 Runtime

每个 Agent Node 都有一个 **Runtime**（运行时内核），决定这个节点用什么方式调用大模型 / 跑工具。Agent Network 内置三种 Runtime，**同一个 Hub 上可以混搭**——一个 Claude Code CLI agent 调任务给 MiniMax agent，再让 Codex agent 写代码，结果汇总回来。

## 三种 Runtime 对比

| Runtime | 内核 | 适用场景 | 主推模型 | 鉴权 |
|---|---|---|---|---|
| `claude-code-cli` | spawn 本地 `claude` 命令 | 想"像在终端用 Claude"那样干活 | Claude Sonnet / Opus（订阅） | `claude` CLI 已登录 |
| `claude-agent-sdk` | `@anthropic-ai/claude-agent-sdk` | 编程式调用 Anthropic 兼容 API | Anthropic / MiniMax / DeepSeek / GLM / Kimi | API Key |
| `codex-sdk` | `@openai/codex-sdk` | 写代码 / 跑命令 | OpenAI Codex（gpt-5 等） | `codex auth login` |

::: tip 不知道怎么选？
- **想白嫖 Claude 订阅** → `claude-code-cli`
- **写文案 / 翻译 / 分析（编程式）** → `claude-agent-sdk`
- **写代码 / 跑命令** → `codex-sdk`
- **用 MiniMax / DeepSeek / GLM / Kimi 等国产模型** → `claude-agent-sdk` + `ANTHROPIC_BASE_URL`
- **混搭（推荐）** → 同一 Hub 全开，每个角色挑最合适的内核
:::

---

## claude-code-cli

复用你**本地已经登录的 Claude CLI 订阅**——不用 API Key、不用 token，跑起来就能干活。

### 工作原理

```
anet node start  →  spawn `claude` 子进程
                 ↓
         commhub MCP（stdio）注入
                 ↓
         接收 send_task → 转给 Claude session → 回复 reply
```

- 节点启动时 spawn 一个 `claude` CLI 子进程
- 通过 commhub MCP（stdio server）把"收任务 / 派任务 / 回复"等工具注入到 Claude session
- 任务到达 → Hub 通过 SSE 推送 → MCP 转发给 Claude → Claude 处理并 reply

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
  "session": "",
  "flags": {
    "dangerouslySkipPermissions": true,
    "teammateMode": "in-process"
  }
}
```

### 注意

- 需要本机已 `claude --version` 能跑（即 Claude Code CLI 已安装并登录）
- `session` 字段会自动保存，下次 `anet node resume` 可以恢复对话历史
- 与 SDK runtime 的关键差别：CLI runtime 拥有 Claude Code 的全套能力（文件操作 / Bash 执行 / MCP 工具）

---

## claude-agent-sdk

编程式调用 **任意 Anthropic 兼容 API** —— 默认接 Anthropic，也能指 MiniMax / DeepSeek / GLM / Kimi 等国产模型的 Anthropic 兼容 endpoint。

### 工作原理

```
anet node start  →  spawn agent-node 子进程
                 ↓
         @anthropic-ai/claude-agent-sdk
                 ↓
         POST → ANTHROPIC_BASE_URL (默认 api.anthropic.com)
                 ↓
         commhub MCP（stdio）接 SSE 收派任务
```

- agent-node 进程通过 SDK 调 Anthropic 兼容 API
- 默认 `api.anthropic.com`，可通过 `ANTHROPIC_BASE_URL` 重定向到任何兼容服务
- `settingSources: []` 完全隔离宿主机配置，不会读你本地的 `~/.claude/`

### 适用场景

- 用 Anthropic 直接 API（不想依赖订阅）
- 用 MiniMax / DeepSeek / GLM / Kimi 等国产模型（低成本 / 高吞吐 / 国内直连）
- 需要灵活切 model（不同任务用不同模型）

### 配置示例

**Anthropic 直连**：
```bash
ANTHROPIC_API_KEY=sk-ant-xxx \
anet node create planner \
  --runtime claude-agent-sdk \
  --model claude-sonnet-4-6
```

**MiniMax**：
```bash
anet node create translator \
  --runtime claude-agent-sdk \
  --model MiniMax-M2.7 \
  --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=sk-cp-xxx"
```

`config.json`：
```json
{
  "runtime": "claude-agent-sdk",
  "model": "MiniMax-M2.7",
  "env": {
    "ANTHROPIC_BASE_URL": "https://api.minimaxi.com/anthropic",
    "ANTHROPIC_AUTH_TOKEN": "sk-cp-xxx"
  }
}
```

### 已验证模型

| Provider | 模型 | `ANTHROPIC_BASE_URL` |
|---|---|---|
| Anthropic | claude-sonnet-4-6 / claude-opus-4-7 / claude-haiku-4-5 | `https://api.anthropic.com` |
| MiniMax | MiniMax-M2.7 | `https://api.minimaxi.com/anthropic` |
| DeepSeek | deepseek-v3-0324 | （根据官方 Anthropic 兼容 endpoint） |
| 智谱 GLM | glm-4-plus | （智谱开放平台 Anthropic 适配） |
| Moonshot Kimi | kimi-k1.5 | （Moonshot Anthropic 兼容） |
| 书生 InternLM | intern-s1-pro | `https://chat.intern-ai.org.cn/anthropic` |

::: details 国产模型 endpoint 完整列表
查看 [多模型配置](/guide/multi-model) — 每家厂商的 Anthropic 兼容 URL + 示例 key。
:::

---

## codex-sdk

接 **OpenAI Codex CLI** —— 适合写代码、跑命令，工具调用最灵活。

### 工作原理

```
anet node start  →  spawn @openai/codex-sdk
                 ↓
         OpenAI API（OPENAI_API_KEY）
                 ↓
         commhub MCP（stdio）接 SSE
```

- 通过官方 `@openai/codex-sdk` 包驱动
- 支持 Read / Write / Edit / Bash / Glob / Grep 等工具
- 鉴权走 `codex auth login`（OAuth 流程）或 `OPENAI_API_KEY`

### 适用场景

- 用 OpenAI 官方 Codex / gpt-5 等最新模型
- 需要让 Agent **写代码 / 跑命令 / 操作文件**
- 工具调用 / function calling 强需求

### 配置示例

```bash
codex auth login  # 一次性

anet node create coder \
  --runtime codex-sdk \
  --model gpt-5 \
  --tools Read,Write,Edit,Bash,Glob,Grep
```

`config.json`：
```json
{
  "runtime": "codex-sdk",
  "model": "gpt-5",
  "tools": ["Read", "Write", "Edit", "Bash", "Glob", "Grep"]
}
```

::: warning 验证状态
codex-sdk runtime 单元测试通过，但**端到端验证不全**（缺真实 codex 鉴权回归）。如果你正在跑生产任务，建议先 `anet node start` 后用一个简单任务（"列出当前目录文件"）验证。
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
  --model MiniMax-M2.7 \
  --env "ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic" \
  --env "ANTHROPIC_AUTH_TOKEN=sk-cp-xxx"

# 3. Codex agent —— 写代码
anet node create coder --runtime codex-sdk --model gpt-5

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
| 用国产模型（MiniMax / DeepSeek / GLM / Kimi） | `claude-agent-sdk` + `ANTHROPIC_BASE_URL` |
| 用 Anthropic 官方 API（稳定后台） | `claude-agent-sdk` |
| 写代码 / 跑 shell 命令 | `codex-sdk` |
| 写文案 / 翻译 / 分析 / RAG | `claude-agent-sdk` |
| 想要 Claude Code 全套能力（文件 / Bash / MCP） | `claude-code-cli` |
| 团队混搭（指挥 + 翻译 + 写代码） | 三个全开，每角色配最合适的 |

---

## 已验证 vs 未验证

::: info 已验证（v2.1 E2E 覆盖）
- `claude-agent-sdk` —— Anthropic / MiniMax / DeepSeek / GLM / Kimi / 书生 全部 E2E 通过
- 多 Runtime 混搭（peer agents 通过 `get_all_status` + `send_task` + `get_task` 自治协调）
:::

::: warning 未验证（请自行评估）
- `claude-code-cli` —— 本机能跑，未做 E2E 回归
- `codex-sdk` —— 单元测试通过，缺真实 codex 鉴权回归
:::

---

## 下一步

- [Agent Node 配置](/guide/agent-node) — 节点的完整配置文件 / 命令行参数 / 工具控制
- [多模型配置](/guide/multi-model) — 每家国产模型的具体 endpoint / Key / 示例
- [CLI 命令](/guide/cli) — `anet node create` 等命令的全部参数
