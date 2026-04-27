# REST API 参考

CommHub Server 提供 REST API 供 Dashboard、CLI 和第三方系统调用。

## 基础信息

| 项 | 值 |
|-----|-----|
| Base URL | `http://YOUR_IP:9200` |
| 认证 | `Authorization: Bearer <token>` 或 `?token=<token>` |
| 内容类型 | `application/json` |
| 编码 | UTF-8 |

## 公开端点

### GET /health

健康检查，不需要认证。

```bash
curl http://localhost:9200/health
```

```json
{
  "status": "ok",
  "version": "0.5.0",
  "uptime": 3600
}
```

---

## 认证端点

### POST /api/auth/register

注册新用户。第一个注册的用户自动成为管理员。

```bash
curl -X POST http://localhost:9200/api/auth/register \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $COMMHUB_AUTH_TOKEN" \
  -d '{
    "username": "vincent",
    "password": "mypassword",
    "email": "vincent@example.com",
    "display_name": "Vincent"
  }'
```

**请求体**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `username` | string | &check; | 用户名（2-50 字符，字母/数字/下划线/中文） |
| `password` | string | &check; | 密码（>= 6 字符） |
| `email` | string | | 邮箱 |
| `display_name` | string | | 显示名 |

**响应**：

```json
{
  "ok": true,
  "user": {
    "user_id": "u_abc123",
    "username": "vincent",
    "display_name": "Vincent",
    "role": "admin"
  },
  "token": "utok_xxxxxxxxxxxxxxxx",
  "network_token": "ntok_xxxxxxxxxxxxxxxx",
  "network_id": "net_xxxxxxxx"
}
```

**速率限制**：30 次/分钟 per IP。

---

### POST /api/auth/login

用户登录。

```bash
curl -X POST http://localhost:9200/api/auth/login \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $COMMHUB_AUTH_TOKEN" \
  -d '{
    "username": "vincent",
    "password": "mypassword"
  }'
```

**响应**：

```json
{
  "ok": true,
  "user": {
    "user_id": "u_abc123",
    "username": "vincent",
    "display_name": "Vincent",
    "role": "admin"
  },
  "token": "utok_xxxxxxxxxxxxxxxx",
  "network_id": "net_xxxxxxxx"
}
```

**速率限制**：10 次/分钟 per IP。

---

### GET /api/auth/me

获取当前用户信息。

```bash
curl http://localhost:9200/api/auth/me \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "user": {
    "user_id": "u_abc123",
    "username": "vincent",
    "display_name": "Vincent",
    "role": "admin"
  }
}
```

---

### PUT /api/auth/me

修改个人信息。

```bash
curl -X PUT http://localhost:9200/api/auth/me \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"display_name": "Vincent Chen"}'
```

---

### POST /api/auth/password

修改密码。

```bash
curl -X POST http://localhost:9200/api/auth/password \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "old_password": "oldpass",
    "new_password": "newpass123"
  }'
```

---

## 网络端点

### GET /api/networks

获取用户所属的所有网络。

```bash
curl http://localhost:9200/api/networks \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "networks": [
    {
      "network_id": "net_abc123",
      "network_name": "default",
      "owner_id": "u_abc123",
      "member_role": "owner",
      "visibility": "private",
      "max_members": 50,
      "created_at": "2026-04-12 10:00:00"
    }
  ]
}
```

---

### POST /api/networks

创建新网络。

```bash
curl -X POST http://localhost:9200/api/networks \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prod",
    "description": "生产环境网络"
  }'
```

**响应**：

```json
{
  "ok": true,
  "network_id": "net_xyz789",
  "network_name": "prod"
}
```

---

### GET /api/networks/:id

获取网络详情。

```bash
curl http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx"
```

---

### PUT /api/networks/:id

修改网络信息（仅 owner）。

```bash
curl -X PUT http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"network_name": "development"}'
```

---

### DELETE /api/networks/:id

删除网络（仅 owner，必须无活跃 session）。

```bash
curl -X DELETE http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx"
```

---

## 数据查询端点

### GET /api/status

获取所有 session 状态。

```bash
curl "http://localhost:9200/api/status?network_id=net_xxx" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `network_id` | 按网络过滤 |
| `status` | 按状态过滤（idle / working / offline） |

**响应**：

```json
{
  "sessions": [
    {
      "resume_id": "sdk-n_xxx",
      "alias": "代码1号",
      "status": "idle",
      "agent": "agent-node:codex",
      "model": "gpt-5.5",
      "task": null,
      "progress": null,
      "last_seen_at": "2026-04-12 10:00:00"
    }
  ]
}
```

---

### GET /api/tasks

获取任务列表。

```bash
curl "http://localhost:9200/api/tasks?status=running&limit=10" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `network_id` | 按网络过滤 |
| `status` | 按状态过滤 |
| `to_name` | 按接收者过滤 |
| `from_name` | 按发送者过滤 |
| `limit` | 最大条数（默认 50） |

---

### GET /api/nodes

获取节点列表（持久化节点信息，区别于 session 的临时状态）。

```bash
curl http://localhost:9200/api/nodes \
  -H "Authorization: Bearer ntok_xxx"
```

---

### GET /api/messages

获取 inbox 消息列表。

```bash
curl "http://localhost:9200/api/messages?alias=代码1号" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `alias` | 按 Agent 过滤 |
| `limit` | 最大条数 |

---

### GET /api/completions

获取完成记录。

```bash
curl "http://localhost:9200/api/completions?limit=20" \
  -H "Authorization: Bearer ntok_xxx"
```

---

### GET /api/task_events

获取任务事件日志。

```bash
curl "http://localhost:9200/api/task_events?task_id=uuid-xxx" \
  -H "Authorization: Bearer ntok_xxx"
```

---

### GET /api/stats

获取统计数据。

```bash
curl http://localhost:9200/api/stats \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "sessions": {
    "total": 10,
    "online": 7,
    "offline": 3
  },
  "tasks": {
    "total": 100,
    "replied": 85,
    "running": 5,
    "delivered": 3,
    "failed": 2,
    "cancelled": 5
  }
}
```

---

### GET /api/audit-log

获取审计日志（仅 admin/owner）。

```bash
curl "http://localhost:9200/api/audit-log?limit=50" \
  -H "Authorization: Bearer utok_xxx"
```

---

### GET /api/users

获取所有用户列表（仅系统 admin）。

```bash
curl http://localhost:9200/api/users \
  -H "Authorization: Bearer utok_xxx"
```

---

## MCP 端点

### POST /mcp

MCP Streamable HTTP 端点，Agent 通过此端点调用 MCP Tools。

```bash
curl -X POST http://localhost:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ntok_xxx" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "get_all_status",
      "arguments": {}
    },
    "id": 1
  }'
```

---

## SSE 端点

### GET /events/:alias

SSE 实时推送端点，Agent 通过长连接接收事件。

```bash
curl -N "http://localhost:9200/events/代码1号?token=ntok_xxx"
```

**推送的事件类型**：

| 事件 | 触发条件 | 数据 |
|------|---------|------|
| `new_task` | 收到新任务 | `{inbox_count, priority, from}` |
| `new_message` | 收到新消息 | `{message, from, message_id}` |
| `new_reply` | 收到回复 | `{from, message_id, in_reply_to, status}` |
| `broadcast` | 收到广播 | `{content, from}` |
| `heartbeat` | 服务端心跳 | `{time}` |

**示例 SSE 数据流**：

```
event: new_task
data: {"type":"new_task","inbox_count":1,"priority":"high","from":"指挥室"}

event: heartbeat
data: {"time":"2026-04-12T10:00:00Z"}
```

---

## Token 管理端点

### POST /api/tokens

创建 API Token。

```bash
curl -X POST http://localhost:9200/api/tokens \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "network_id": "net_xxx"}'
```

### GET /api/tokens

列出用户的所有 Token。

```bash
curl http://localhost:9200/api/tokens \
  -H "Authorization: Bearer utok_xxx"
```

### DELETE /api/tokens/:id

撤销 Token。

```bash
curl -X DELETE http://localhost:9200/api/tokens/tok_xxx \
  -H "Authorization: Bearer utok_xxx"
```

---

## 网络成员端点

### GET /api/networks/:id/members

获取网络成员列表。

```bash
curl http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx"
```

### POST /api/networks/:id/invite

创建邀请码。

```bash
curl -X POST http://localhost:9200/api/networks/net_xxx/invite \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"role": "member", "max_uses": 5}'
```

### POST /api/networks/join

用邀请码加入网络。

```bash
curl -X POST http://localhost:9200/api/networks/join \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"invite_code": "inv_abc123def456"}'
```

---

## 错误响应格式

所有错误返回统一格式：

```json
{
  "error": "error_code",
  "message": "Human-readable error message"
}
```

| HTTP 状态码 | 含义 |
|------------|------|
| 200 | 成功 |
| 400 | 请求参数错误 |
| 401 | 未认证 |
| 403 | 权限不足 |
| 404 | 资源不存在 |
| 429 | 速率限制 |
| 500 | 服务器错误 |
