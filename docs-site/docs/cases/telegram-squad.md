# 军团编队

最完整的案例：1 个指挥 + 5 个代码兵 + 5 个文案兵，Docker Compose 一键启动，支持 Telegram 接入。

**预计时间**：10 分钟  
**Agent 数量**：11（指挥室 + 5 Codex + 5 MiniMax）  
**模型**：GPT-5.4 + MiniMax
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
│  │ (GPT-5.4)     │   │ (MiniMax)     │      │
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
| commander | 指挥室 | Claude | 接收命令、分配任务 |
| codex-1~5 | 代码兵 | GPT-5.4 | 写代码、跑命令 |
| minimax-1~5 | 文案兵 | MiniMax | 文案、翻译 |
| dashboard | Web UI | - | 浏览器管控台 |

## 环境变量

```bash
# 必填
MINIMAX_API_KEY=sk-cp-xxx        # MiniMax API Key

# 可选（接入 Telegram）
TELEGRAM_BOT_TOKEN=123456:ABC    # Telegram Bot Token
TELEGRAM_ALLOWED_USERS=你的ID     # 允许的用户 ID

# 可选（用 Codex）
# 需要先 codex auth login
```

## 操作命令

```bash
# 启动
docker compose up -d

# 查看所有容器状态
docker compose ps

# 看指挥室日志
docker compose logs -f commander

# 看某个代码兵日志
docker compose logs -f codex-1

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

## 下一步

- [混合模型协作](/cases/mixed-model) -- 不同模型各司其职
