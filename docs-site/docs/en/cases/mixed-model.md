# Mixed Model Collaboration

Four Agents powered by different models collaborate on a complex task, demonstrating the design philosophy of "different models for different roles."

**Estimated time**: 5 minutes  
**Number of Agents**: 4 (project manager + analyst + developer + copywriter)  
**Models**: Claude + DeepSeek + MiniMax

## Design rationale

Different models excel in different areas. A mixed squad can optimize for both capability and cost:

| Agent | Model | Why this model | Cost |
|-------|-------|---------------|------|
| 项目经理 | DeepSeek | Strong reasoning + orchestration | Low |
| 分析师 | Claude | Best at complex analysis | High |
| 开发 | DeepSeek | Strong coding ability | Low |
| 文案 | MiniMax | Good Chinese, extremely low cost | Very low |

## Steps

### 1. Create Agents

```bash
# Project manager — DeepSeek (orchestration)
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的DeepSeek-Key \
anet node create 项目经理 --runtime claude-agent-sdk

# Analyst — Claude (deep analysis)
ANTHROPIC_API_KEY=sk-ant-xxx \
anet node create 分析师 --runtime claude-agent-sdk --model claude-sonnet-4-6

# Developer — DeepSeek (coding)
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的DeepSeek-Key \
anet node create 开发 --runtime claude-agent-sdk

# Copywriter — MiniMax (documentation)
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的MiniMax-Key \
anet node create 文案 --runtime claude-agent-sdk
```

### 2. Start

```bash
anet node start 项目经理
anet node start 分析师
anet node start 开发
anet node start 文案
```

### 3. Send a task

```bash
anet task send 项目经理 "任务：设计并实现一个简单的待办事项 API。请分工：1）让分析师分析需求和技术方案；2）让开发写代码；3）让文案写 API 文档。最后汇总给我。网络中的 Agent：分析师、开发、文案。"
```

## Architecture

```
              ┌──────────┐
              │ 项目经理  │ ← DeepSeek (orchestration)
              └─────┬────┘
                    │
       ┌────────────┼────────────┐
       ▼            ▼            ▼
 ┌──────────┐ ┌──────────┐ ┌──────────┐
 │  分析师   │ │   开发    │ │   文案    │
 │ (Claude)  │ │(DeepSeek)│ │(MiniMax) │
 │Deep analysis│ │  Coding  │ │  Docs    │
 └──────────┘ └──────────┘ └──────────┘
    High cost     Low cost    Very low cost
```

## Cost comparison

Assuming an average of 10K tokens per task:

| Approach | Approximate total cost |
|----------|----------------------|
| All Claude | ~$0.12 |
| Mixed squad | ~$0.03 |
| All MiniMax | ~$0.005 |

The mixed squad uses a strong model for critical work (analysis) and cheaper models for routine work (development, copywriting) -- **75% cost reduction while maintaining quality**.

## Next steps

- [Multi-Model Configuration](/en/guide/multi-model) -- Learn about all supported models
- [Telegram Squad](/en/cases/telegram-squad) -- Large-scale Docker orchestration
