# 混合模型协作

四个不同模型的 Agent 协作完成一个复杂任务，展示"不同模型各司其职"的设计理念。

**预计时间**：5 分钟  
**Agent 数量**：4（项目经理 + 分析师 + 开发 + 文案）  
**模型**：Claude + DeepSeek + MiniMax

## 设计思路

不同模型有不同擅长领域，混合编队可以同时追求能力和成本：

| Agent | 模型 | 为什么选它 | 成本 |
|-------|------|-----------|------|
| 项目经理 | DeepSeek | 推理+编排能力强 | 低 |
| 分析师 | Claude | 复杂分析最强 | 高 |
| 开发 | DeepSeek | 代码能力强 | 低 |
| 文案 | MiniMax | 中文好、成本极低 | 极低 |

## 步骤

### 1. 创建 Agent

```bash
# 项目经理 — DeepSeek（编排）
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的DeepSeek-Key \
anet node create 项目经理 --runtime claude-agent-sdk

# 分析师 — Claude（深度分析）
ANTHROPIC_API_KEY=sk-ant-xxx \
anet node create 分析师 --runtime claude-agent-sdk --model claude-sonnet-4-6

# 开发 — DeepSeek（写代码）
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的DeepSeek-Key \
anet node create 开发 --runtime claude-agent-sdk

# 文案 — MiniMax（文档）
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的MiniMax-Key \
anet node create 文案 --runtime claude-agent-sdk
```

### 2. 启动

```bash
anet node start 项目经理
anet node start 分析师
anet node start 开发
anet node start 文案
```

### 3. 发任务

```bash
anet task send 项目经理 "任务：设计并实现一个简单的待办事项 API。请分工：1）让分析师分析需求和技术方案；2）让开发写代码；3）让文案写 API 文档。最后汇总给我。网络中的 Agent：分析师、开发、文案。"
```

## 架构

```
              ┌──────────┐
              │ 项目经理  │ ← DeepSeek（编排）
              └─────┬────┘
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
 ┌──────────┐ ┌──────────┐ ┌──────────┐
 │  分析师   │ │   开发    │ │   文案    │
 │ (Claude)  │ │(DeepSeek)│ │(MiniMax) │
 │  深度分析  │ │  写代码   │ │  写文档   │
 └──────────┘ └──────────┘ └──────────┘
      高成本       低成本      极低成本
```

## 成本对比

假设一个任务平均消耗 10K tokens：

| 方案 | 总成本（约） |
|------|-----------|
| 全用 Claude | ~$0.12 |
| 混合编队 | ~$0.03 |
| 全用 MiniMax | ~$0.005 |

混合编队在关键环节（分析）用强模型，常规环节（开发、文案）用便宜模型，**成本降低 75% 同时保持质量**。

## 下一步

- [多模型配置](/guide/multi-model) -- 了解所有支持的模型
- [军团编队](/cases/telegram-squad) -- Docker 大规模编排
