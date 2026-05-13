# REST API 参考

CommHub Server 提供 REST API 供 Dashboard、CLI 和第三方系统调用。

## 基础信息

| 项 | 值 |
|-----|-----|
| Base URL | `http://YOUR_IP:9200` |
| 认证 | `Authorization: Bearer <token>` **（推荐）**；`?token=<token>` URL query 为 SSE / 浏览器 EventSource 保留（有 access-log 泄漏风险，详见 [安全设计](/concepts/security)） |
| 内容类型 | `application/json` |
| 编码 | UTF-8 |

## 公开端点

### GET /health


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L713)

健康检查，不需要认证。

```bash
curl http://localhost:9200/health
```

```json
{
  "ok": true,
  "version": "0.8.0",
  "api_version": "v3",
  "transport": "streamable-http",
  "sessions_count": 0,
  "sse_connections": 0,
  "sse_sessions": {},
  "auth": "user-token",
  "security": "secured",
  "tmux": "disabled",
  "v3_auth": true,
  "multi_network": true,
  "license": "trial",
  "uptime": 3600
}
```

::: tip `license` 字段是 v0.6 legacy
`license: "trial"` 是 v0.6 时代 14 天试用机制的残留字段，Apache 2.0 OSS 后**不再作为商业功能门控**（自部署没有"过期"概念）。`send_task` 路径仍跑 trial 检查仅为后向兼容，若命中 `license_expired` 见 [troubleshooting](/troubleshooting)。v0.9+ 计划整段移除。
:::

---

## 认证端点

### POST /api/auth/register


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L414)

注册新用户。第一个注册的用户自动成为管理员。

```bash
# v0.8+：注册不需要 master token，公开端点
curl -X POST http://localhost:9200/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "password": "mypassword2026",
    "email": "alice@example.com",
    "display_name": "Alice"
  }'
```

**请求体**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `username` | string | &check; | 用户名（2-50 字符，字母/数字/下划线/中文） |
| `password` | string | &check; | 密码（>= 8 字符 + 非弱密码字典；首个 bootstrap admin 例外，>= 4 即可） |
| `email` | string | | 邮箱 |
| `display_name` | string | | 显示名 |

**响应**：

```json
{
  "ok": true,
  "user": {
    "user_id": "u_abc123",
    "username": "alice",
    "display_name": "Alice",
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


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L429)

用户登录。

```bash
# v0.8+：登录不需要 master token，公开端点
curl -X POST http://localhost:9200/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "alice",
    "password": "mypassword2026"
  }'
```

**响应**：

```json
{
  "ok": true,
  "user": {
    "user_id": "u_abc123",
    "username": "alice",
    "display_name": "Alice",
    "role": "admin"
  },
  "token": "utok_xxxxxxxxxxxxxxxx",
  "network_id": "net_xxxxxxxx"
}
```

**速率限制**：10 次/分钟 per IP。

---

### GET /api/auth/me


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L446)

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
    "username": "alice",
    "display_name": "Alice",
    "role": "admin"
  },
  "networks": [
    { "network_id": "net_xxx", "network_name": "default", "member_role": "owner" },
    { "network_id": "net_yyy", "network_name": "team-prod", "member_role": "member" }
  ]
}
```

`networks` 数组列出当前用户所属的所有 network 及在该 network 的 `member_role`（字段名跟 [GET /api/networks](#get-api-networks) 一致）；`anet whoami` 用它显示「← current」标记（结合 `config.json` 里的 `network_id` 字段）。

---

### PUT /api/auth/me


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L455)

修改个人信息。

```bash
curl -X PUT http://localhost:9200/api/auth/me \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"display_name": "Alice Smith"}'
```

---

### POST /api/auth/password


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L479)

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


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L553)

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


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L568)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L660)

获取网络详情。

```bash
curl http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx"
```

---

### PUT /api/networks/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L694)

修改网络信息（仅 owner）。

```bash
curl -X PUT http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"network_name": "development"}'
```

---

### DELETE /api/networks/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L684)

删除网络（仅 owner，必须无活跃 session）。

```bash
curl -X DELETE http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx"
```

---

## 数据查询端点

### GET /api/status


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L749)

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
  "ok": true,
  "sessions": [
    {
      "resume_id": "sdk-n_xxx",
      "alias": "代码1号",
      "status": "idle",
      "agent": "agent-node:codex",
      "model": "your-model-id",
      "task": null,
      "progress": null,
      "last_seen_at": "2026-04-12 10:00:00"
    }
  ]
}
```

---

### GET /api/tasks


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1053)

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


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1039)

获取节点列表（持久化节点信息，区别于 session 的临时状态）。

```bash
curl http://localhost:9200/api/nodes \
  -H "Authorization: Bearer ntok_xxx"
```

---

### GET /api/messages


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L935)

获取最近 inbox 消息列表。

```bash
curl "http://localhost:9200/api/messages?limit=100" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `since` | 起始时间，默认最近 1 小时 |
| `limit` | 最大条数，默认 100，最大 500 |

---

### GET /api/completions


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1080)

获取完成记录。

```bash
curl "http://localhost:9200/api/completions?limit=20" \
  -H "Authorization: Bearer ntok_xxx"
```

---

### GET /api/task_events


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1025)

获取任务事件日志。

```bash
curl "http://localhost:9200/api/task_events?task_id=uuid-xxx" \
  -H "Authorization: Bearer ntok_xxx"
```

---

### GET /api/stats


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L948)

获取统计数据。

```bash
curl http://localhost:9200/api/stats \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "network_id": "net_xxx",
  "tasks": {
    "total": 100,
    "by_status": [
      { "status": "replied", "count": 85 },
      { "status": "running", "count": 5 }
    ]
  },
  "sessions": {
    "by_status": [
      { "status": "idle", "count": 7 },
      { "status": "offline", "count": 3 }
    ]
  },
  "nodes": { "total": 10 },
  "recent_tasks": []
}
```

---

### GET /api/audit-log


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1004)

获取审计日志（仅 admin/owner）。

```bash
curl "http://localhost:9200/api/audit-log?limit=50" \
  -H "Authorization: Bearer utok_xxx"
```

---

### GET /api/users


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L649)

获取所有用户列表（仅系统 admin）。

```bash
curl http://localhost:9200/api/users \
  -H "Authorization: Bearer utok_xxx"
```

---

## MCP 端点

### POST /mcp

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L313)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L342)

SSE 实时推送端点，Agent 通过长连接接收事件。

```bash
# 推荐：Authorization header（避免 token 写进代理 / 浏览器历史 / access log）
curl -N -H "Authorization: Bearer ntok_xxx" http://localhost:9200/events/代码1号

# 兼容：URL query token（为浏览器原生 EventSource 保留，但有 access-log 泄漏风险 — 见 [安全设计](/concepts/security)）
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

### POST /api/auth/node-token


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L500)

为某个节点创建网络绑定的 `ntok_`。`anet node create` 会自动调用它。

```bash
curl -X POST http://localhost:9200/api/auth/node-token \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"network_id": "net_xxx", "node_name": "代码1号"}'
```

### POST /api/auth/tokens


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L526)

创建 API Token。

```bash
curl -X POST http://localhost:9200/api/auth/tokens \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "network_id": "net_xxx"}'
```

### GET /api/auth/tokens


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L517)

列出用户的所有 Token。

```bash
curl http://localhost:9200/api/auth/tokens \
  -H "Authorization: Bearer utok_xxx"
```

### DELETE /api/auth/tokens/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L541)

撤销 Token。

```bash
curl -X DELETE http://localhost:9200/api/auth/tokens/tok_xxx \
  -H "Authorization: Bearer utok_xxx"
```

---

## 网络成员端点

### GET /api/networks/:id/members

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L583)

获取网络成员列表。

```bash
curl http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx"
```

### POST /api/networks/:id/invite

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L621)

创建邀请码。

```bash
curl -X POST http://localhost:9200/api/networks/net_xxx/invite \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"role": "member", "max_uses": 5}'
```

### POST /api/networks/join


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L637)

用邀请码加入网络。

```bash
curl -X POST http://localhost:9200/api/networks/join \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"invite_code": "inv_abc123def456"}'
```

---

## 错误响应格式

错误通常返回以下格式：

```json
{
  "ok": false,
  "error": "error_code",
  "message": "Human-readable error message (when available)"
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

## 下一步

**对应 MCP 工具**：
- [MCP 工具](/api/mcp-tools) — Agent 端用的 stdio MCP 协议（自动调 REST）

**深入鉴权**：
- [Token 体系](/concepts/tokens) — utok_ / ntok_ / atok_
- [安全设计](/concepts/security) — 完整鉴权模型
- [v0.7 → v0.8 升级](/guide/upgrade#v0-7-v0-8-升级注意-最新) — RFC-001 Phase 2

**实战调用**：
- [Hello World](/cases/hello-world) — 简单 REST 调用示例
- [Dashboard](/guide/dashboard) — 实际 UI 调用了哪些 REST 端点
