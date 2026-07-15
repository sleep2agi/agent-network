# 多模型配置

Agent Network 支持在同一个网络中运行不同 AI 模型的 Agent。所有模型共用同一套通信协议，互相发消息无障碍。

## 支持的模型

### 国产模型（推荐，国内直连）

下表是 `anet node create` 供应商选单（cli.ts `VENDORS` 列表）里**内置的国内 provider** —— 每一项的 `baseUrl` + model id 都是**跑通真 API 验证过**才进列表的：

| 模型 | 服务商 | Runtime | API 地址 | 成本 |
|------|--------|---------|---------|------|
| **MiniMax**（`MiniMax-M2.7`） | MiniMax | `claude-agent-sdk` | api.minimaxi.com/anthropic | 极低 |
| **书生 Intern-S2-Preview**（`anet node create` vendor 选单默认项，**仅在选 `claude-agent-sdk` runtime 后才出现** —— [#133](https://github.com/sleep2agi/agent-network/issues/133) runtime-first wizard 起 v0.9.2+） | 书生 | `claude-agent-sdk` | chat.intern-ai.org.cn（**裸域名，无 `/anthropic`**） | 低 |
| **书生 Intern-S1-Pro** | 书生 | `claude-agent-sdk` | chat.intern-ai.org.cn（**裸域名，无 `/anthropic`**） | 低 |
| **小米 MiMo**（`mimo-v2.5-pro` 默认 + v2.5 / v2-pro / v2-omni / v2.5-tts-voicedesign[^mimo-tts]） | 小米 | `claude-agent-sdk` | token-plan-cn.xiaomimimo.com/anthropic | 低 |

[^mimo-tts]: `mimo-v2.5-tts-voicedesign` 是 **TTS 语音设计模型**，Anthropic Messages 文本请求大概率 vendor 不支持；文本对话请用前 4 个 model（`mimo-v2.5-pro` / `mimo-v2.5` / `mimo-v2-pro` / `mimo-v2-omni`）。v0.10.10 起 wizard 凑齐官方 5 model preset。

> 验证机制（#104-B 设计调整后）：cli.ts 不再用「`MODEL_PRESETS` + `[UNVERIFIED]` 标记」那套 —— 现在统一是 [`VENDORS` 列表（在 cli.ts 里 grep `const VENDORS`）](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts)，**进列表 = 已 verified-with-real-call**。**DeepSeek / GLM / Kimi 等未跑通验证的 provider 故意不进列表** —— 它们走下方「自定义」`custom` 供应商接入（任何 Anthropic 兼容 API 都能用 `custom`）。各家 model id 到对应平台官网查（[MiniMax](https://platform.minimaxi.com) / [小米 MiMo](https://platform.xiaomimimo.com) / [DeepSeek](https://api-docs.deepseek.com) / [智谱](https://open.bigmodel.cn)）。

::: tip 任何 Anthropic-compatible 提供商都能接
上表是常用 provider，但 `claude-agent-sdk` 通过 `ANTHROPIC_BASE_URL` 接入**任何**支持 Anthropic Messages API 的服务商。没列出的服务商（自部署 vLLM / SiliconFlow / 通义千问 Anthropic 兼容端点等）也能用，只需把 `ANTHROPIC_BASE_URL` 指向对应平台的 Anthropic 兼容 endpoint，把 API Key 设到 `ANTHROPIC_AUTH_TOKEN` 即可。详见下方"配置方式"。
:::

### 海外模型

| 模型 | 服务商 | Runtime | 认证方式 | 特点 | 成本 |
|------|--------|---------|---------|------|------|
| **Claude Sonnet（当前主线）** | Anthropic | `claude-agent-sdk` | Anthropic API Key | 主力推理（具体 ID 查 [Anthropic Models](https://docs.anthropic.com/claude/docs/models-overview)） | 中-高 |
| **Claude Opus（当前主线）** | Anthropic | `claude-agent-sdk` | Anthropic API Key | 复杂任务 / 长上下文（同上） | 极高 |
| **Claude Code** | Anthropic | `claude-code-cli` | Claude Max 订阅 | 终端交互 | 订阅制 |
| **Codex (codex-sdk)** | OpenAI | `codex-sdk` | codex auth login | 代码生成 | 中 |
| **OpenRouter（多模型聚合）** | OpenRouter | `claude-agent-sdk` | `ANTHROPIC_AUTH_TOKEN` | 一个 API Key 用所有模型（GPT-4 / Claude / Gemini / Llama 等），统一计费；**不在内置 `VENDORS` 列表**，走 `custom` 供应商接入（`openrouter.ai/api/v1`）| 跟随上游 |
| **xAI Grok Build** | xAI | `grok-build-acp` | `grok login` + `GROK_CODE_XAI_API_KEY`（runtime 前置） | xAI Grok Build ACP 协议跨 agent 协作；`anet node create` 4-way runtime picker 可选（v0.10.8 / v0.10.11 起），[详细 runtime 指南 ↗](https://github.com/sleep2agi/agent-network/blob/main/docs/grok-build-runtime.md)| 中 |

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

# 书生（注意：裸域名，无 /anthropic 后缀，跟 MiniMax 等不同）
ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn \
ANTHROPIC_AUTH_TOKEN=你的书生-API-Key \
anet node create 研究员 --runtime claude-agent-sdk

# Kimi
ANTHROPIC_BASE_URL=https://api.moonshot.cn/anthropic \
ANTHROPIC_AUTH_TOKEN=你的Kimi-API-Key \
anet node create 长文助手 --runtime claude-agent-sdk

# 小米 MiMo（5 个 model：mimo-v2.5-pro 默认 / v2.5 / v2-pro / v2-omni / v2.5-tts-voicedesign[TTS]）
ANTHROPIC_BASE_URL=https://token-plan-cn.xiaomimimo.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的MiMo-API-Key \
anet node create 推理助手 --runtime claude-agent-sdk --model mimo-v2.5-pro
# 文本对话用前 4 个 model；mimo-v2.5-tts-voicedesign 是 TTS 语音设计模型，Anthropic Messages 文本请求大概率不支持

# OpenRouter（一个 Key 接 GPT-4 / Claude / Gemini / Llama 等所有上游）
ANTHROPIC_BASE_URL=https://openrouter.ai/api/v1 \
ANTHROPIC_AUTH_TOKEN=你的OpenRouter-API-Key \
anet node create 多模型助手 --runtime claude-agent-sdk --model anthropic/claude-sonnet-4
# OpenRouter model id 用 'provider/model' 格式, 完整列表见 https://openrouter.ai/models
```
:::

### Claude（海外）

```bash
# 方式 1：用 Anthropic API Key
# --model 填 [Anthropic Models](https://docs.anthropic.com/claude/docs/models-overview) 上的最新 model id
ANTHROPIC_API_KEY=sk-ant-xxx \
anet node create 推理大师 --runtime claude-agent-sdk --model <anthropic-model-id>

# 方式 2：用 Claude Code CLI（需要 Claude Max 订阅）
anet node create 全能助手 --runtime claude-code-cli

anet node start 推理大师
```

### Codex (codex-sdk)（海外）

```bash
# 先登录 OpenAI
codex auth login

# 创建 Codex Agent
# --model 填 OpenAI Codex 文档里的最新 model id
anet node create 代码机器 --runtime codex-sdk --model <codex-model-id> --tools Read,Write,Edit,Bash,Glob,Grep

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
anet node create 架构师 --runtime codex-sdk --model <codex-model-id>

# 4. 全部启动
anet node start 文案1号
anet node start 代码审查
anet node start 架构师
```

::: info 混合编队的好处
- 文案/翻译用国产模型 → 成本低、速度快、无需科学上网
- 代码/架构用 Codex (codex-sdk) 或 Claude → 能力强
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

## Vendor adapter（行为修正层，v0.9.1+）

Anthropic 兼容协议**只解决数据格式**，**不保证行为一致**。各家厂商 RLHF 微调路径不同，同样的 `tools` + `tool_choice:"auto"` payload 在不同厂商端会产生**行为分歧**：

- ✅ MiniMax / Anthropic 官方：tool_use content blocks 干净 emit，OOTB 工作
- ❌ 书生 intern-s2-preview：默认走 verbose "Thinking Process" 文本，**不发** `tool_use` blocks（强制 `tool_choice` 还被 `-20077` 拒）

从 [v0.9.1](/changelog#v0-9-1-patch-130-intern-tool-calling-hotfix-promote-2026-05-15-stable)（[#130 hotfix](https://github.com/sleep2agi/agent-network/issues/130)）起 agent-node 引入 **vendor adapter** 检测 `ANTHROPIC_BASE_URL` 后 prepend 一段 system-prompt bias 把厂商行为掰回 Anthropic 标准。

**当前 adapter（intern）触发条件**：URL 命中 `/intern-ai\.org\.cn|chat\.intern-ai/i` 正则（[`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/commit/4cd0024)）—— 上面 "书生" 配置示例的 `ANTHROPIC_BASE_URL=https://chat.intern-ai.org.cn` 会自动触发。

**5 个用户可见副作用**（必读 + opt-out 路径）：
1. 失去 intern Thinking Process 透明度（model skip thinking）
2. Detection fragility（自部署 lmdeploy / proxy / aggregator 不命中 regex）
3. Silent injection（隐式 prepend，debug 困惑）
4. Tool calling 风格强制（多 Agent 协作净正面 / 单 agent 报告任务偏移）
5. Tokens 减输出 = 减 explainability

详见 [Vendor 适配层](/concepts/vendor-adapters)（完整机制 + per-副作用 Migration hint + future polish gap）。

**opt-out**：`anet node start <alias> --prompt "你的 system prompt"` —— `--prompt` 是**替换**而非追加，vendor bias 不会再被 prepend，model 退回原始 RLHF。

## 模型选择建议

| 场景 | 推荐模型 | 理由 |
|------|---------|------|
| 日常文案/翻译 | MiniMax M2.7 | 极低成本，中文好 |
| 代码生成/审查 | DeepSeek V3 或 Codex (codex-sdk) | 代码能力强 |
| 复杂推理/分析 | Claude Sonnet（主线） | 推理最强 |
| 长文档处理 | Kimi | 128K 上下文 |
| 科学研究 | 书生 Intern-S1-Pro | 科研专长 |
| 预算有限 | MiniMax + DeepSeek 混搭 | 两个都极便宜 |
| 全能（不差钱） | Claude Opus（主线） | 什么都行 |

## 成本优化策略

### 策略 1：分级路由

把任务按复杂度分发到不同模型，最大化成本效益：

```
复杂任务 (10%) → Claude Opus     (~$15/M tokens 量级)
中等任务 (30%) → Codex (codex-sdk) (~$5/M tokens)
简单任务 (60%) → MiniMax M2.7    (~$0.3/M tokens)
```

> 上面数字是 2026-05 时点的量级估算；各家定价会调整，做预算前请查 provider 官方价格表。

### 策略 2：预算控制

agent-node 支持 `--max-budget <usd>` 每任务预算上限。`anet node create` 没把它当 flag 透出来 —— 写在 `config.json` 的 `flags.maxBudgetUsd`：

```jsonc
// ~/.anet/nodes/architect/config.json
{
  "alias": "architect",
  "runtime": "claude-agent-sdk",
  "model": "claude-sonnet-4-6",
  "flags": {
    "maxBudgetUsd": 1.0          // 每任务最多花 $1
  }
}
```

或者手动启动 agent-node 时直接传：

```bash
agent-node --max-budget 1.0 --alias architect --runtime claude-agent-sdk --hub http://127.0.0.1:9200
```

### 策略 3：批量低成本

重复性任务一次起多个低成本 agent 并行处理：

```bash
# 起 5 个 MiniMax agent 批量翻译
for i in 1 2 3 4 5; do
  ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
  ANTHROPIC_AUTH_TOKEN=$MINIMAX_KEY \
  anet node create "translator-${i}" --runtime claude-agent-sdk --model <minimax-model-id>
  anet node start "translator-${i}" &
done
```

## 下一步

**直接用**：

**配置和调优**：
- 钱花在哪儿？看 [一键安装与起步](/guide/one-shot-install) 一节的成本对比
- 想把多个 API Key 持久化？看 [Agent Node 配置](/guide/agent-node) 的 env 字段
- API 限流报错？多数厂商有并发上限，[FAQ](/faq) 里有应对策略

**深入原理**：
- 为什么 `ANTHROPIC_BASE_URL` 能切所有国产模型？看上方 [ANTHROPIC_BASE_URL 原理](#anthropic-base-url-原理) 一节
- 不同 runtime 的区别？看 [Runtimes](/guide/runtimes) — `claude-agent-sdk` / `codex-sdk` / `claude-code-cli` 三选一
