# Translation Pipeline

Three Agents form a translation pipeline: Chinese original -> English translation -> Japanese translation.

**Estimated time**: 5 minutes  
**Number of Agents**: 3 (dispatcher + English translator + Japanese translator)  
**Models**: MiniMax + DeepSeek

::: tip Docker quick start
```bash
cd demos/translation-pipeline
MINIMAX_API_KEY=your-key docker compose up
```
:::

## Result

```
You -> 调度员: "Translate: 今天天气真好"
调度员 -> 英文翻译: "Translate this Chinese text to English: 今天天气真好"
英文翻译 -> 调度员: "The weather is really nice today"
调度员 -> 日文翻译: "Translate this English text to Japanese: The weather is really nice today"
日文翻译 -> 调度员: "今日は天気がとても良いです"
调度员 -> You: "Translation complete! CN -> EN -> JP: 今日は天気がとても良いです"
```

## Steps

::: tip Prerequisites
This case assumes you've already run [Hello World](/en/cases/hello-world) to finish the first-time install + admin bootstrap + `anet login`. If not, walk through hello-world's step 0 first.
:::

### 1. Create Agents

::: tip Two ways to create
- **A. Interactive** (recommended first time): run `anet node create <name> --runtime claude-agent-sdk` and the CLI prompts you to pick a provider + paste an API key
- **B. Env preset** (scriptable): prefix the command with `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` and the CLI skips the picker
:::

```bash
# Dispatcher (orchestrates the workflow; DeepSeek has strong reasoning)
ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-DeepSeek-key \
anet node create 调度员 --runtime claude-agent-sdk

# English translator (MiniMax — low-latency in China, very cheap)
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-MiniMax-key \
anet node create 英文翻译 --runtime claude-agent-sdk

# Japanese translator (also MiniMax)
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=your-MiniMax-key \
anet node create 日文翻译 --runtime claude-agent-sdk
```

### 2. Start all Agents

```bash
anet node start 调度员
anet node start 英文翻译
anet node start 日文翻译
```

### 3. Send a task

In the Dashboard ChatPanel, select `调度员` and send this Task:

```text
翻译任务：把'今天天气真好，我想出去走走'翻译成英文和日文。先发给英文翻译翻成英文，再发给日文翻译翻成日文，最后把结果汇总给我。
```

### 4. View results

```bash
# Check task flow
anet tasks

# View dispatcher logs
anet logs 调度员
```

## Architecture

```
         ┌──────────┐
         │   You    │
         └─────┬────┘
               │ "Translate: 今天天气真好"
               ▼
         ┌──────────┐
         │  调度员   │ ← Orchestrates workflow
         └─────┬────┘
               │
       ┌───────┴───────┐
       ▼               ▼
 ┌──────────┐    ┌──────────┐
 │ 英文翻译  │    │ 日文翻译  │
 │ (MiniMax) │    │ (MiniMax) │
 └──────────┘    └──────────┘
```

## Key points

- **Dispatcher** uses DeepSeek: strong at understanding complex instructions and orchestration
- **Translators** use MiniMax: low cost, good with Chinese, high translation quality
- Agents communicate automatically through CommHub -- no code required

## Next steps

- [Debate Demo](/en/cases/debate) -- Built-in 6-agent orchestration
- [Telegram Squad](/en/cases/telegram-squad) -- Large-scale Docker orchestration
