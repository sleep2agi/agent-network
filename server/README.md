# @sleep2agi/commhub-server

AI Agent 通信中枢 — MCP Server + SSE Push + REST API。

## 快速启动

```bash
# 需要 Bun
bunx @sleep2agi/commhub-server

# 或指定端口 + auth
PORT=9200 COMMHUB_AUTH_TOKEN=your-secret bunx @sleep2agi/commhub-server
```

启动后:
- MCP: `http://0.0.0.0:9200/mcp` (Claude Code / Codex 连接)
- SSE: `http://0.0.0.0:9200/events/:alias` (Agent 实时推送)
- REST: `http://0.0.0.0:9200/api/*` (Dashboard / 监控)
- Health: `http://0.0.0.0:9200/health`

## MCP 工具 (17 个)

### Agent 端 (从 Agent 调用)
| 工具 | 说明 |
|------|------|
| `report_status` | 心跳 + 状态更新 (idle/working/blocked/error/offline) |
| `report_completion` | 任务完成汇报 |
| `get_inbox` | 拉取待办任务 |
| `ack_inbox` | 确认收到任务 |

### Hub 端 (从指挥室 / Dashboard 调用)
| 工具 | 说明 |
|------|------|
| `send_task` | 下发任务 (+ 可选 ttl_seconds) |
| `send_message` | 发消息 (不触发 Agent 处理) |
| `send_reply` | 回复任务 (replied/failed/cancelled + in_reply_to) |
| `send_ack` | 确认任务 (不入 inbox) |
| `retry_task` | 重试失败/过期/取消的任务 |
| `cancel_task` | 取消待处理任务 |
| `reassign_task` | 转移任务到另一个 Agent |
| `get_task` | 查询任务详情 |
| `get_all_status` | 全局状态面板 |
| `get_session_status` | 单 session 详情 |
| `broadcast` | 群发消息 |

## REST API

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查 (无需 auth) |
| `/api/status` | GET | 所有 session |
| `/api/tasks` | GET | 任务列表 (支持 status/from_name/to_name/task_id/limit 过滤) |
| `/api/nodes` | GET | 节点持久化信息 |
| `/api/task_events` | GET | 任务审计日志 |
| `/api/messages` | GET | 消息列表 |
| `/api/completions` | GET | 完成记录 |
| `/mcp` | POST | MCP Streamable HTTP |

## 数据库 (6 表)

SQLite WAL 模式, 自动创建在 `~/.commhub/commhub.db`

| 表 | 说明 |
|---|------|
| `sessions` | 运行时 session (21 列, 含 node_id/session_id/channels) |
| `inbox` | 消息队列 (13 列, 含 in_reply_to/scope) |
| `tasks` | 任务生命周期 (17 列, 完整状态机) |
| `nodes` | 持久化节点身份 (11 列, 独立于 session) |
| `completions` | 完成记录 (7 列) |
| `task_events` | 审计日志 (7 列, 每次状态变化记录) |

任务状态机:
```
created → delivered → acked → running → replied
                                      → failed → retry → delivered
                                      → cancelled
delivered → expired (5min patrol)
delivered/acked/running → reassign → delivered (新agent)
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | 9200 | 监听端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `COMMHUB_AUTH_TOKEN` | (无) | Bearer token 鉴权 |
| `COMMHUB_DB` | ~/.commhub/commhub.db | 数据库路径 |

## 鉴权

设置 `COMMHUB_AUTH_TOKEN` 后, 所有端点需要 Bearer token:
- Header: `Authorization: Bearer <token>`
- 或 Query: `?token=<token>`
- `/health` 不需要 auth

## License

MIT
