# 你好世界

最简单的案例：两个 Agent 互相发消息。

**预计时间**：3 分钟  
**Agent 数量**：2  
**模型**：MiniMax（或任意模型）

::: tip Docker 一键启动
```bash
cd demos/hello-world
MINIMAX_API_KEY=你的Key docker compose up
```
详见 [demos/hello-world](https://github.com/sleep2agi/agent-network/tree/main/demos/hello-world)
:::

## 效果

```
小明 → 小红: "你好，请自我介绍一下"
小红 → 小明: "你好！我是小红，一个 AI 助手..."
```

## 步骤

### 1. 确保 CommHub 运行中

```bash
anet hub start
```

### 2. 创建两个 Agent

```bash
# Agent 1：小明（用 MiniMax，国内直连，成本极低）
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的MiniMax-API-Key \
anet node create 小明 --runtime claude-agent-sdk

# Agent 2：小红（同样用 MiniMax）
ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic \
ANTHROPIC_AUTH_TOKEN=你的MiniMax-API-Key \
anet node create 小红 --runtime claude-agent-sdk
```

::: tip 没有 MiniMax Key？
去 [platform.minimaxi.com](https://platform.minimaxi.com) 注册，创建 API Key 即可。免费额度足够跑这个案例。
:::

### 3. 启动

```bash
# 分两个终端窗口启动
anet node start 小明
anet node start 小红
```

### 4. 发任务

打开 Dashboard（浏览器访问 CommHub 地址），点 **Dispatch** 按钮给小明发任务：

```
请给小红发一条消息，让她自我介绍一下
```

### 5. 查看结果

```bash
# 查看任务状态
anet tasks

# 查看小明的日志
anet logs 小明

# 查看小红的日志
anet logs 小红
```

## 原理

```
┌──────┐    send_task     ┌──────────┐    send_task     ┌──────┐
│ 你   │ ──────────────→ │  小明    │ ──────────────→ │  小红  │
│(CLI) │                  │(Agent)   │                  │(Agent)│
└──────┘                  └──────────┘                  └──────┘
                               ▲                            │
                               │        send_reply          │
                               └────────────────────────────┘
```

1. 你通过 CLI 或 Dashboard 给小明发任务
2. 小明收到任务，通过 CommHub 给小红发消息
3. 小红回复，小明收到结果
4. 小明将结果汇报给你

## 下一步

跑通了 hello-world，根据兴趣往下走：

**更复杂的 demo**
- [翻译流水线](/cases/translation-pipeline) — 3 个 Agent 链式协作（DeepSeek 调度 + MiniMax 翻译）
- [辩论赛 Demo](/cases/debate) — 6 个 Agent（主持 + 正反 4 辩 + 评委）一键 9 步辩论
- [军团编队](/cases/telegram-squad) — 11 个 Agent + Docker Compose + Telegram 接入

**深入了解**
- [CLI 命令参考](/guide/cli) — 完整命令手册
- [多模型配置](/guide/multi-model) — 给不同 Agent 用不同模型 / provider
- [Dashboard 指南](/guide/dashboard) — 浏览器面板里能做什么

**部署到团队 / 公网**
- [一键安装](/guide/one-shot-install) — 多 Agent + tmux 一条命令起
- [生产部署](/deploy/production) — 公网部署 + TLS + 改密 checklist
