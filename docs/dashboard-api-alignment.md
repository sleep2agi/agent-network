# Dashboard API Alignment

> 日期：2026-04-10 | N站马实测 CommHub Server v0.4.1

## 当前可用接口

| 端点 | 方法 | 状态 | 说明 |
|------|------|------|------|
| `/api/status` | GET | 可用 | sessions 16 字段，无 node_id/channels/last_seen_at |
| `/api/completions` | GET | 可用 | {session_name, task, result, completed_at} |
| `/api/task` | POST | 可用 | 发任务 |
| `/health` | GET | 可用 | 版本/SSE/在线数 |
| `/api/tasks` | GET | **不存在** | 需要新增 |

## 前端需要的接口（按优先级）

### P0: GET /api/tasks

```json
// Request
GET /api/tasks?status=running&from_name=N站马&to_name=N站牛&limit=100

// Response
{
  "ok": true,
  "count": 42,
  "tasks": [{
    "task_id": "xxx",
    "from_name": "N站马",
    "to_name": "N站牛",
    "status": "running",
    "priority": "normal",
    "content": "...",
    "result": "...",
    "created_at": "2026-04-10T10:00:00Z",
    "delivered_at": "...",
    "started_at": "...",
    "completed_at": "...",
    "expires_at": "..."
  }]
}
```

### P0: GET /api/status 补字段

sessions 新增：
- `node_id` — 稳定节点 ID
- `session_id` — 运行时会话 ID
- `channels` — string[] (如 ["commhub", "telegram"])
- `last_seen_at` — 最后心跳时间
- `config_path` — 可选

### P1: Bearer token

所有接口统一支持 `Authorization: Bearer <COMMHUB_AUTH_TOKEN>`

## 临时方案

前端 Tasks 页先降级对接 `/api/completions`，等 server 升级后切 `/api/tasks`。

## 待确认

- [ ] /api/tasks 由谁实现？（通信龙 server 侧 or N站牛中间层）
- [ ] /api/status 新字段什么时候能上？
