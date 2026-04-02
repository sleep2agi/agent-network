# Commander MCP Server

## 启动
```bash
cd server && bun install && bun run start
```

## 架构
- MCP Streamable HTTP (`/mcp`) — Claude Code / Codex 连接端点
- SSE Push (`/events/:session`) — Agent 实时接收任务推送
- HTTP REST (`/api/*`) — 监控脚本/curl 用
- SQLite WAL (`~/.commander/commander.db`)

## MCP Tools (9 个)
### 子 Agent (4)
- `report_status` — 心跳+状态+进度，返回 inbox_count
- `report_completion` — 任务完成汇报
- `get_inbox` — 拉取待办命令
- `ack_inbox` — 确认收到

### Hub (5)
- `get_all_status` — 全局状态面板
- `get_session_status` — 单 session 详情
- `send_task` — 下发任务
- `broadcast` — 群发
- `get_completions` — 已完成任务列表
