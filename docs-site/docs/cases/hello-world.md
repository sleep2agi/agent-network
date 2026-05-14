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

### 0. 第一次用？先 init + login

如果还没装过 anet：

```bash
npm i -g @sleep2agi/agent-network@latest
```

第一次跑 `anet hub start` 会**非交互**自动 bootstrap admin 账号（默认 `admin / anethub`，无 prompt）：

```bash
anet hub start
# 期望输出：
#   ✅ Admin account created
#      username: admin
#      password: anethub
#      Store this password now; it will not be shown again.
#      Admin token saved to ~/.anet/server/admin-utok.json
```

::: warning 公网部署立刻改密
默认 `admin / anethub` 是快速起手，**非生产凭据**。`anet hub start --ip 0.0.0.0` 暴露 LAN/公网时必须立刻 `anet passwd` 改强密码（≥ 8 位 + 非弱密码字典），见 [troubleshooting → 密码强度](/troubleshooting)。
:::

再开一个终端，登录并设置 hub 地址：

```bash
anet init        # 第一次自动指向 http://127.0.0.1:9200
anet login       # 输入 admin / anethub，拿到 utok_
```

::: tip 已经装过、登录过？
直接 `anet hub start` 起 hub 即可，跳到第 2 步。`anet doctor --fix` 可以自动修过期 token。
:::

### 1. 确保 CommHub 运行中

```bash
anet hub start   # 如果上面 0 步已经起着了就跳过
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

如果还没启动 Dashboard，另开一个终端：

```bash
anet hub dashboard
# 浏览器打开 http://localhost:3000，用 admin / anethub 登录
```

在 Dashboard 的 **ChatPanel** 里选择 `小明`，发送 Task：

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
- [翻译流水线](/cases/translation-pipeline) — 3 个 Agent 链式协作（都用 MiniMax，中→英→日）
- [辩论赛 Demo](/cases/debate) — 6 个 Agent（主持 + 正反 4 辩 + 评委）一键 9 步辩论
- [军团编队](/cases/telegram-squad) — 11 个 Agent + Docker Compose + Telegram 接入

**深入了解**
- [CLI 命令参考](/guide/cli) — 完整命令手册
- [多模型配置](/guide/multi-model) — 给不同 Agent 用不同模型 / provider
- [Dashboard 指南](/guide/dashboard) — 浏览器面板里能做什么

**部署到团队 / 公网**
- [一键安装](/guide/one-shot-install) — 多 Agent + tmux 一条命令起
- [生产部署](/deploy/production) — 公网部署 + TLS + 改密 checklist
