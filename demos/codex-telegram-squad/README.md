# Codex Telegram Squad Demo

1 个 Codex 控制中心（带 Telegram）+ 10 个 AI Worker 协作。

## 架构

```
Telegram → Commander (Codex) → CommHub Server
                                           ├── worker-1~5 (Codex)
                                           └── worker-6~10 (MiniMax via Claude SDK)
```

## 启动

```bash
cd demos/codex-telegram-squad

# 1. 配置
cp .env.example .env
# 编辑 .env 填入 Telegram bot token + MiniMax API key

# 2. 启动（13 个容器）
docker compose up -d

# 3. 查看状态
docker compose logs -f commander
curl http://localhost:9299/api/status

# 4. 通过 Telegram 给 commander 发消息，它会分配任务给 worker
```

## 停止

```bash
docker compose down
```

## 配置说明

| 环境变量 | 说明 |
|---------|------|
| `COMMHUB_AUTH_TOKEN` | ⚠️ v0.8 起软废弃（仅 `/api/*` 只读 + deprecation warning）；新部署 hub 起来自动 bootstrap admin utok_，**不再需要**此 env。v1.0 完全移除。 |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token (from @BotFather) |
| `TELEGRAM_ALLOW_USER` | 允许的 Telegram 用户 ID |
| `MINIMAX_API_KEY` | MiniMax API Key |

## Worker 分工

- **worker-1~5**: Codex — 代码任务、文件操作
- **worker-6~10**: MiniMax — 文本处理、翻译、分析
- **commander**: 接收 Telegram 指令，智能分配给合适的 worker
