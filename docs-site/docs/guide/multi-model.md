# 多模型配置

Agent Network 支持在同一个网络中运行不同 AI 模型的 Agent。所有模型共用同一套通信协议，互相发消息无障碍。

## 支持的模型

### 国产模型（推荐，国内直连）

| 模型 | 服务商 | Runtime | API 地址 | 特点 | 成本 |
|------|--------|---------|---------|------|------|
| **MiniMax M2.7** | MiniMax | `claude-agent-sdk` | api.minimaxi.com/anthropic | 低成本文案、翻译 | 极低 |
| **DeepSeek V3** | DeepSeek | `claude-agent-sdk` | api.deepseek.com/anthropic | 代码+推理、性价比极高 | 极低 |
| **GLM 5.1** | 智谱 | `claude-agent-sdk` | open.bigmodel.cn/anthropic | 中文理解强 | 低 |
| **书生 Intern-S1** | 书生 | `claude-agent-sdk` | chat.intern-ai.org.cn/anthropic | 科学推理 | 低 |
| **Kimi** | Moonshot | `claude-agent-sdk` | api.moonshot.cn/anthropic | 长文本处理 | 低 |

### 海外模型

| 模型 | 服务商 | Runtime | 认证方式 | 特点 | 成本 |
|------|--------|---------|---------|------|------|
| **Claude Sonnet 4** | Anthropic | `claude-agent-sdk` | Anthropic API Key | 最强推理 | 高 |
| **Claude Opus 4** | Anthropic | `claude-agent-sdk` | Anthropic API Key | 复杂任务 | 极高 |
| **Claude Code** | Anthropic | `claude-code-cli` | Claude Max 订阅 | 终端交互 | 订阅制 |
| **GPT-5.5** | OpenAI | `codex-sdk` | codex auth login | 代码生成 | 中 |

## 配置方式

### 国产模型（MiniMax 为例）

所有国产模型通过 `claude-agent-sdk` + `ANTHROPIC_BASE_URL` 接入，配置方式一样：

```bash
# MiniMax
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的MiniMax-API-Key \
anet node create 文案1号 --runtime claude-agent-sdk

anet node start 文案1号
```

::: tip 切换模型只需改两个环境变量
```bash
# DeepSeek
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的DeepSeek-API-Key \
anet node create 代码助手 --runtime claude-agent-sdk

# GLM
ANTHROPIC_BASE_URL=https://open.bigmodel.cn/anthropic \
ANTHROPIC_AUTH_TOKEN=你的智谱-API-Key \
anet node create 分析师 --runtime claude-agent-sdk

# 书生
ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn/anthropic \
ANTHROPIC_AUTH_TOKEN=你的书生-API-Key \
anet node create 研究员 --runtime claude-agent-sdk

# Kimi
ANTHROPIC_BASE_URL=https://api.moonshot.cn/anthropic \
ANTHROPIC_AUTH_TOKEN=你的Kimi-API-Key \
anet node create 长文助手 --runtime claude-agent-sdk
```
:::

### Claude（海外）

```bash
# 方式 1：用 Anthropic API Key
ANTHROPIC_API_KEY=sk-ant-xxx \
anet node create 推理大师 --runtime claude-agent-sdk --model claude-sonnet-4-6

# 方式 2：用 Claude Code CLI（需要 Claude Max 订阅）
anet node create 全能助手 --runtime claude-code-cli

anet node start 推理大师
```

### GPT-5.5（海外）

```bash
# 先登录 OpenAI
codex auth login

# 创建 Codex Agent
anet node create 代码机器 --runtime codex-sdk --model gpt-5.5 --tools Read,Write,Edit,Bash,Glob,Grep

anet node start 代码机器
```

## 混合编队示例

一个网络里同时跑多个不同模型的 Agent：

```bash
# 1. 启动服务器
anet hub start

# 2. 国产文案组（低成本）
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的Key \
anet node create 文案1号 --runtime claude-agent-sdk

ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的Key \
anet node create 代码审查 --runtime claude-agent-sdk

# 3. 海外代码组（高能力）
codex auth login
anet node create 架构师 --runtime codex-sdk --model gpt-5.5

# 4. 全部启动
anet node start 文案1号
anet node start 代码审查
anet node start 架构师
```

::: info 混合编队的好处
- 文案/翻译用国产模型 → 成本低、速度快、无需科学上网
- 代码/架构用 GPT-5.5 或 Claude → 能力强
- 所有 Agent 在同一个网络里协作，通过 Dashboard 统一指挥
:::

## ANTHROPIC_BASE_URL 原理

`claude-agent-sdk` 默认连 Anthropic 官方 API。通过设置 `ANTHROPIC_BASE_URL`，可以将请求路由到任何兼容 Anthropic API 格式的服务商：

```
请求流程：
Agent Node → ANTHROPIC_BASE_URL → 服务商 API → AI 模型

示例：
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic
  → Agent Node 发请求到 MiniMax
  → MiniMax 返回 MiniMax-M2.7 的结果
  → Agent 以为自己在跟 "Claude" 聊天，实际用的是 MiniMax
```

::: tip 为什么用 Anthropic 兼容格式？
因为 `claude-agent-sdk` 内部用 Anthropic 的 Messages API 格式。国产服务商提供兼容接口后，不需要改任何代码就能切换模型。这是"一套协议接所有模型"的核心设计。
:::

## 模型选择建议

| 场景 | 推荐模型 | 理由 |
|------|---------|------|
| 日常文案/翻译 | MiniMax M2.7 | 极低成本，中文好 |
| 代码生成/审查 | DeepSeek V3 或 GPT-5.5 | 代码能力强 |
| 复杂推理/分析 | Claude Sonnet 4 | 推理最强 |
| 长文档处理 | Kimi | 128K 上下文 |
| 科学研究 | 书生 Intern-S1 | 科研专长 |
| 预算有限 | MiniMax + DeepSeek 混搭 | 两个都极便宜 |
| 全能（不差钱） | Claude Opus 4 | 什么都行 |
