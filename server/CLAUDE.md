# CommHub Server

## 启动
```bash
cd server && bun install && bun run src/index.ts
# or: bunx @sleep2agi/commhub-server
```

## 架构
- MCP Streamable HTTP (`/mcp`) — Claude Code / Codex 连接端点
- SSE Push (`/events/:session`) — Agent 实时接收任务推送
- HTTP REST (`/api/*`) — Dashboard / 监控 / Admin
- SQLite WAL (`~/.commhub/commhub.db`)
- V3 Auth: api_tokens + users + networks

## 数据库 (13 表)
sessions / inbox / tasks / nodes / completions / task_events / users / networks / api_tokens / audit_log / licenses / network_members / network_invites

## MCP Tools (17 个)
### Agent 端
- `report_status` — 心跳+状态+进度 (含 network_id)
- `report_completion` — 任务完成汇报
- `get_inbox` — 拉取待办命令
- `ack_inbox` — 确认收到

### Hub 端
- `send_task` — 下发任务 (含 network_id + ttl_seconds)
- `send_message` — 发消息 (不触发处理)
- `send_reply` — 回复任务 (replied/failed/cancelled)
- `send_ack` — 确认任务
- `retry_task` — 重试失败任务
- `cancel_task` — 取消待处理任务
- `reassign_task` — 转移任务
- `get_task` — 查询任务详情
- `list_tasks` — 查询任务列表 (含 network_id)
- `get_all_status` — 全局状态 (含 network_id)
- `get_session_status` — 单 session 详情
- `broadcast` — 群发 (含 network_id)
- `get_completions` — 完成列表

## REST API（主要端点，完整清单见 docs-site/docs/api/rest.md）
- Auth: POST /api/auth/register + /api/auth/login + /api/auth/password, GET /api/auth/me + PUT /api/auth/me
- Network: GET /api/networks + POST /api/networks + GET/PUT/DELETE /api/networks/:id, GET /members + POST /invite + POST /join
- Token: POST /api/auth/tokens (+ node-token) + GET /api/auth/tokens + DELETE /api/auth/tokens/:id
- Read: GET /api/status + /api/tasks + /api/nodes + /api/stats + /api/audit-log + /api/task_events + /api/messages + /api/completions + /api/users (admin)
- GET /health (public)
- POST /mcp (MCP) + GET /events/:alias (SSE)
