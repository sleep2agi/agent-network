# 军团编队

最完整的案例：1 个指挥 + 5 个代码兵 + 5 个文案兵，Docker Compose 一键启动，支持 Telegram 接入。

**预计时间**：10 分钟  
**Agent 数量**：11（指挥室 + 5 Codex + 5 MiniMax）  
**模型**：Codex + MiniMax
**需要**：Docker

## 效果

通过 Telegram 或 Dashboard 给指挥室下令：

```
你: "写一个 REST API 服务"
指挥室 → 代码1号: "搭建项目骨架"
指挥室 → 代码2号: "实现 CRUD 接口"
指挥室 → 文案1号: "写 API 文档"
指挥室 → 文案2号: "写 README"
...全部完成后汇总报告
```

## 一键启动

```bash
cd demos/codex-telegram-squad

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入：
# - MINIMAX_API_KEY=你的MiniMax Key
# - TELEGRAM_BOT_TOKEN=你的Telegram Bot Token（可选）

# 启动
docker compose up -d

# 查看状态
docker compose ps
docker compose logs -f commander
```

## 架构

```
┌─────────────────────────────────────────────┐
│              Docker Compose                  │
│                                              │
│  ┌──────────┐                               │
│  │ CommHub   │ ← 通信中枢                    │
│  │ Server    │                               │
│  └─────┬────┘                               │
│        │                                     │
│  ┌─────┴────┐                               │
│  │  指挥室   │ ← 接收命令，分配任务           │
│  │(Commander)│                               │
│  └─────┬────┘                               │
│        │                                     │
│   ┌────┴────────────────────┐               │
│   │                         │               │
│   ▼                         ▼               │
│  ┌───────────────┐   ┌───────────────┐      │
│  │ 代码 1-5 号    │   │ 文案 1-5 号    │     │
│  │ (Codex)     │   │ (MiniMax)     │      │
│  │ 写代码+跑命令  │   │ 写文案+翻译    │     │
│  └───────────────┘   └───────────────┘      │
│                                              │
│  ┌──────────┐  ┌──────────┐                 │
│  │Dashboard │  │  seed    │ ← 初始化        │
│  └──────────┘  └──────────┘                 │
└─────────────────────────────────────────────┘
```

## 容器列表

| 容器 | 角色 | 模型 | 说明 |
|------|------|------|------|
| server | CommHub | - | 通信中枢 |
| seed | 初始化 | - | 注册 admin、创建网络、生成 ntok_ |
| commander | 指挥室 | Codex | 接收命令、分配任务 |
| worker-1~5 | 代码兵 | Codex | 写代码、跑命令 |
| worker-6~10 | 文案兵 | MiniMax | 文案、翻译 |
| dashboard | Web UI | - | 浏览器管控台 |

## 环境变量

```bash
# 必填
MINIMAX_API_KEY=sk-cp-xxx        # MiniMax API Key（commander + 文案 worker 用）

# 可选（接入 Telegram）
TELEGRAM_BOT_TOKEN=123456:ABC    # Telegram Bot Token
TELEGRAM_ALLOW_USER=你的ID        # 允许的 Telegram 用户 ID（单数 ALLOW_USER，不是 ALLOWED_USERS）

# 可选（用 Codex）
# 需要先 codex auth login
```

::: warning env var 命名陷阱
`TELEGRAM_ALLOW_USER` 是**单数**（verify [`demos/codex-telegram-squad/.env.example`](https://github.com/sleep2agi/agent-network/blob/main/demos/codex-telegram-squad/.env.example) + [`docker-compose.yml:52`](https://github.com/sleep2agi/agent-network/blob/main/demos/codex-telegram-squad/docker-compose.yml#L52)）。误写 `TELEGRAM_ALLOWED_USERS` / `_USERS` 复数 env 会被 docker compose 忽略 —— Telegram bot 收到非白名单消息直接拒绝，但日志里没明显错误，容易当成 bot 配置错。
:::

## 操作命令

```bash
# 启动
docker compose up -d

# 查看所有容器状态
docker compose ps

# 看指挥室日志
docker compose logs -f commander

# 看某个代码兵日志
docker compose logs -f worker-1

# 停止
docker compose down

# 重建
docker compose up -d --build
```

## Telegram 接入

1. 在 @BotFather 创建 Bot，拿到 Token
2. 填入 `.env` 的 `TELEGRAM_BOT_TOKEN`
3. 重启：`docker compose up -d`
4. 在 Telegram 给 Bot 发消息，指挥室会接收并分配

::: tip 非 Docker 部署？用 v0.8.2 一键绑定
如果你不跑 Docker Compose，而是用 `anet node create / start` 起的单 node，可以直接：
```bash
# 注意：telegram 后面要带 <node-id> 位置参数；白名单 flag 是 --allow（不是 --allow-user）
anet channel add telegram <node-id> --bot-token <BOT_TOKEN> --allow <TG_USER_ID>
```
自动生成节点的 `channels/telegram` 配置，无需手编 `.env`。详见 [Channel 概念 — Telegram](/guide/channels#telegram-channel)。
:::

## 下一步

**继续看 case**：
- [Hello World](/cases/hello-world) — 最简 6 步 demo（两个 Agent 对话开胃）
- [辩论赛 Demo](/cases/debate) — 内置 6 Agent 辩论编排（一条命令跑完）
- [翻译流水线](/cases/translation-pipeline) — 多 agent 串联流水线

**改造和深入**：
- 把代码兵换成 DeepSeek 或 Kimi？看 [多模型配置](/guide/multi-model) — 国产模型 Anthropic-compatible endpoint 表
- 想理解 Telegram channel 插件怎么实现？看 [Channel 概念](/guide/channels) + 仓库 [demos/codex-telegram-squad](https://github.com/sleep2agi/agent-network/tree/main/demos/codex-telegram-squad)
- 想接微信/飞书？看 [Channel 概念](/guide/channels) 末尾的扩展指南

**生产部署**：
- 把整套搬到云服务器：[生产部署](/deploy/production)
- 改 Docker Compose 调整 worker 数量、模型组合：直接编辑 `docker-compose.yml`，每个 worker 一段独立配置
- 监控指挥室和 worker 状态：[Dashboard](/guide/dashboard) 的 Topology + Tasks 两个面板
