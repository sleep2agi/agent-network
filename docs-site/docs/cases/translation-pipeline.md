# 翻译流水线

三个 Agent 组成翻译流水线：中文原文 → 英文翻译 → 日文翻译。

**预计时间**：5 分钟  
**Agent 数量**：3（调度员 + 英文翻译 + 日文翻译）  
**模型**：MiniMax + DeepSeek

::: tip Docker 一键启动
```bash
cd demos/translation-pipeline
MINIMAX_API_KEY=你的Key docker compose up
```
详见 [demos/translation-pipeline](https://github.com/sleep2agi/agent-network/tree/main/demos/translation-pipeline)
:::

## 效果

```
你 → 调度员: "翻译：今天天气真好"
调度员 → 英文翻译: "把这段中文翻译成英文：今天天气真好"
英文翻译 → 调度员: "The weather is really nice today"
调度员 → 日文翻译: "把这段英文翻译成日文：The weather is really nice today"
日文翻译 → 调度员: "今日は天気がとても良いです"
调度员 → 你: "翻译完成！中→英→日：今日は天気がとても良いです"
```

## 步骤

### 1. 创建 Agent

```bash
# 调度员（负责编排流程）
anet node create 调度员 --runtime claude-agent-sdk
# 选择 DeepSeek

# 英文翻译
anet node create 英文翻译 --runtime claude-agent-sdk
# 选择 MiniMax

# 日文翻译
anet node create 日文翻译 --runtime claude-agent-sdk
# 选择 MiniMax
```

### 2. 全部启动

```bash
anet node start 调度员
anet node start 英文翻译
anet node start 日文翻译
```

### 3. 发任务

```bash
anet task send 调度员 "翻译任务：把'今天天气真好，我想出去走走'翻译成英文和日文。先发给英文翻译翻成英文，再发给日文翻译翻成日文，最后把结果汇总给我。"
```

### 4. 查看结果

```bash
# 查看任务流转
anet tasks

# 查看调度员日志
anet logs 调度员
```

## 架构

```
         ┌──────────┐
         │    你     │
         └─────┬────┘
               │ "翻译：今天天气真好"
               ▼
         ┌──────────┐
         │  调度员   │ ← 编排流程
         └─────┬────┘
               │
       ┌───────┴───────┐
       ▼               ▼
 ┌──────────┐    ┌──────────┐
 │ 英文翻译  │    │ 日文翻译  │
 │ (MiniMax) │    │ (MiniMax) │
 └──────────┘    └──────────┘
```

## 要点

- **调度员**用 DeepSeek：擅长理解复杂指令和编排
- **翻译**用 MiniMax：低成本、中文好，翻译质量高
- Agent 之间通过 CommHub 自动通信，不需要写代码

## 下一步

- [代码审查](/cases/code-review) -- 写代码 + 自动 Review
- [成语接龙](/cases/idiom-chain) -- 多 Agent 游戏
