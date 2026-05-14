# 翻译流水线

三个 Agent 组成翻译流水线：中文原文 → 英文翻译 → 日文翻译。

**预计时间**：5 分钟  
**Agent 数量**：3（调度员 + 英文翻译 + 日文翻译）  
**模型**：MiniMax（3 个 Agent 同一 provider，跟 `demos/translation-pipeline/docker-compose.yml` 一致，只需一个 `MINIMAX_API_KEY`）

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

::: tip 先决条件
本案例假设你已经跑过 [Hello World](/cases/hello-world) 完成了首次安装 + admin bootstrap + `anet login`。如果还没装，先跟 hello-world 走一遍 0 步起步。
:::

### 1. 创建 Agent

::: tip 两种创建方式
- **A. 交互式**（推荐第一次）：跑 `anet node create <name> --runtime claude-agent-sdk`，CLI 会弹菜单让你选 provider + 输 API key
- **B. env 预设**（脚本化）：用 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 前置，CLI 不再弹菜单
:::

```bash
# 调度员（负责编排流程，用 MiniMax）
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的-MiniMax-Key \
anet node create 调度员 --runtime claude-agent-sdk

# 英文翻译（用 MiniMax 国内直连便宜）
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的-MiniMax-Key \
anet node create 英文翻译 --runtime claude-agent-sdk

# 日文翻译（同 MiniMax）
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的-MiniMax-Key \
anet node create 日文翻译 --runtime claude-agent-sdk
```

### 2. 全部启动

```bash
anet node start 调度员
anet node start 英文翻译
anet node start 日文翻译
```

### 3. 发任务

如果还没启动 Dashboard，另开一个终端：

```bash
anet hub dashboard
# 浏览器打开 http://localhost:3000，用 admin / anethub 登录
```

在 Dashboard 的 ChatPanel 里选择 `调度员`，发送 Task：

```text
翻译任务：把'今天天气真好，我想出去走走'翻译成英文和日文。先发给英文翻译翻成英文，再发给日文翻译翻成日文，最后把结果汇总给我。
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

- 3 个 Agent 都用 **MiniMax**：低成本、中文好、国内直连，翻译质量高；想换 provider 把 `ANTHROPIC_BASE_URL` 指到别家即可
- **调度员**只做编排（拆任务 + 串流程），翻译质量主要看翻译 Agent
- Agent 之间通过 CommHub 自动通信，不需要写代码

## 下一步

- [辩论赛 Demo](/cases/debate) -- 6 Agent 内置编排
- [军团编队](/cases/telegram-squad) -- Docker 大规模编排
