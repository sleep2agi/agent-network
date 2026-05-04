# Code Review

Two Agents collaborate: one writes code, the other reviews it, simulating a real development workflow.

**Estimated time**: 5 minutes  
**Number of Agents**: 3 (tech lead + developer + reviewer)  
**Models**: Claude/DeepSeek + MiniMax

## Result

```
You -> 技术经理: "Write a Python quicksort"
技术经理 -> 开发: "Implement quicksort"
开发 -> 技术经理: "def quicksort(arr): ..."
技术经理 -> 审查员: "Review this code"
审查员 -> 技术经理: "Suggestions: add boundary checks, use random pivot..."
技术经理 -> You: "Code complete and review passed. Suggestions attached..."
```

## Steps

### 1. Create Agents

```bash
# Tech lead (orchestration + decisions)
anet node create 技术经理 --runtime claude-agent-sdk
# Select DeepSeek

# Developer (writes code)
anet node create 开发 --runtime claude-agent-sdk
# Select DeepSeek (strong coding ability)

# Reviewer (reviews code)
anet node create 审查员 --runtime claude-agent-sdk
# Select MiniMax (low cost, sufficient analysis capability)
```

### 2. Start

```bash
anet node start 技术经理
anet node start 开发
anet node start 审查员
```

### 3. Send a task

In the Dashboard ChatPanel, select `技术经理` and send this Task:

```text
请让开发写一个 Python 快速排序函数，写完后发给审查员做代码 Review，最后把代码和 Review 意见一起汇总给我。
```

### 4. Watch the flow

```bash
anet tasks
anet logs 技术经理
```

## Architecture

```
         ┌──────────┐
         │   You    │
         └─────┬────┘
               │
               ▼
         ┌──────────┐
         │ 技术经理  │ ← Orchestration
         └─────┬────┘
               │
       ┌───────┴───────┐
       ▼               ▼
 ┌──────────┐    ┌──────────┐
 │   开发    │    │  审查员   │
 │(DeepSeek) │    │(MiniMax) │
 └──────────┘    └──────────┘
```

## Going further

- Add a "tester" Agent that automatically writes tests after development
- Have the reviewer automatically send code back to the developer for fixes when issues are found
- Use the `codex-sdk` runtime to let the developer actually execute code

## Next steps

- [Telegram Squad](/en/cases/telegram-squad) -- 1 commander + 10 soldiers in Docker orchestration
