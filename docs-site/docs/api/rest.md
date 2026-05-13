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
  -d '{"display_name": "Alice Smith", "email": "alice@example.com"}'
```

**请求体**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `display_name` | string | | 显示名 |
| `email` | string | | 邮箱 |

只更新提供的字段（[server/src/index.ts:464-465](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L464) 用 `if (body.X)` 条件 SQL）；`username` / `role` / `password` **不**通过此 endpoint 修改。

**响应**：

```json
{
  "ok": true,
  "user": {
    "user_id": "u_abc123",
    "username": "alice",
    "display_name": "Alice Smith",
    "email": "alice@example.com",
    "role": "admin"
  }
}
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

**响应**：

```json
{
  "ok": true,
  "token": "utok_xxxxxxxxxxxxxxxx",
  "token_id": "tok_new_session_id"
}
```

**关键副作用** (verify [server/src/index.ts:486-491](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L486)):
1. 当前调用用的 `utok_` (`resolved.tokenId`) 立即撤销
2. 颁发新的 `utok_` (`issued.token`) 给调用方，作为本次响应返回 —— 调用方应立即用新 token 覆盖本地存储
3. 写 audit log: `action='password_changed'`
4. **其他设备上的 utok_ 不在此处显式撤销**——具体行为取决于 `changePassword()` 内部实现, 详见 [Token 生命周期对照](/concepts/tokens#token-生命周期对照)

跟 `anet passwd` CLI 行为一致（CLI 拿到新 token 后自动写 `~/.anet/config.json`）。

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

获取网络详情（含成员身份校验：必须是该 network 成员或系统 admin，否则 403）。

```bash
curl http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "network": {
    "network_id": "net_abc123",
    "network_name": "prod",
    "owner_id": "u_abc123",
    "description": "生产环境网络",
    "visibility": "private",
    "max_members": 50,
    "created_at": "2026-04-12 10:00:00",
    "updated_at": "2026-04-12 10:00:00"
  },
  "stats": {
    "nodes": 5,
    "sessions": 4,
    "tasks": [
      { "status": "replied", "count": 42 },
      { "status": "running", "count": 3 }
    ]
  }
}
```

---

### PUT /api/networks/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L694)

重命名网络（仅 owner）。

```bash
curl -X PUT http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "development"}'
```

**请求体**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `name` | string | &check; | 新网络名（**注意字段名是 `name` 不是 `network_name`**；缺失时返回 `name required` 400） |

**响应**（成功）：

```json
{ "ok": true }
```

**常见 4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `name required` | 请求体缺 `name` 字段（注意不是 `network_name`） |
| 400 | `network not found` | `network_id` 不存在 |
| 400 | `not your network` | 调用者不是该网络的 owner |
| 400 | `name already taken` | 该 owner 名下已有同名网络 |

写 audit log `action='network_renamed'`，`detail` 字段记新名。

---

### DELETE /api/networks/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L684)

删除网络（仅 owner，必须无活跃 session）。

```bash
curl -X DELETE http://localhost:9200/api/networks/net_abc123 \
  -H "Authorization: Bearer utok_xxx"
```

**响应**（成功）：

```json
{ "ok": true }
```

**常见 4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `network not found` | `network_id` 不存在 |
| 400 | `not your network` | 调用者不是该网络的 owner |
| 400 | `network has N active session(s) — stop them first` | 还有正在跑的 agent session 关联此网络（`anet node stop <name>` 全部停掉后再删） |

写 audit log `action='network_deleted'`。

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
      "agent": "agent-node:codex-sdk",
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
| `status` | 按状态过滤；任何 [Task 生命周期状态机](/concepts/task-lifecycle#状态说明) 状态都可传 |
| `to_name` | 按接收者过滤 |
| `from_name` | 按发送者过滤 |
| `limit` | 最大条数（默认 50） |

**响应**：

```json
{
  "ok": true,
  "tasks": [
    {
      "message_id": "t_a1b2c3d4",
      "from_name": "指挥室",
      "to_name": "代码1号",
      "content": "写一个 Python 快排算法",
      "status": "replied",
      "priority": "normal",
      "created_at": "2026-04-12 10:00:00",
      "delivered_at": "2026-04-12 10:00:01",
      "replied_at": "2026-04-12 10:00:15",
      "ttl_seconds": 3600
    }
  ]
}
```

`anet tasks` CLI 用 `from_name` / `to_name` / `status` / `created_at` / `content` 渲染表格 (cli.ts L2810-2817)。

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

**响应**：

```json
{
  "ok": true,
  "messages": [
    {
      "message_id": "m_abc123",
      "from_alias": "代码1号",
      "to_alias": "指挥室",
      "type": "reply",
      "content": "[代码1号] 已完成，使用快排实现",
      "created_at": "2026-04-12 10:00:15"
    },
    {
      "message_id": "m_def456",
      "from_alias": "指挥室",
      "to_alias": "代码1号",
      "type": "task",
      "content": "写一个快排算法",
      "created_at": "2026-04-12 10:00:00"
    }
  ]
}
```

::: info 当前 schema 限制
SELECT 暂未包含 `in_reply_to` 字段；轮询匹配回复消息时按 `from_alias` + `type='reply'` + recency 启发式匹配（详见 `cli.ts:3827` 注释）。
:::

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

**响应**：

```json
{
  "ok": true,
  "audit_log": [
    {
      "user_id": "u_abc123",
      "username": "alice",
      "action": "password_reset_by_admin",
      "target_type": "user",
      "target_id": "u_def456",
      "detail": "local cli reset-user",
      "created_at": "2026-04-12 10:00:00"
    },
    {
      "user_id": "u_abc123",
      "username": "alice",
      "action": "create_network",
      "target_type": "network",
      "target_id": "net_xyz789",
      "detail": "name=prod",
      "created_at": "2026-04-12 09:55:00"
    }
  ]
}
```

`audit_log` 表 schema 见 [`agent-network/bin/cli.ts:2171`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts#L2171)（INSERT 语句明确列）。常见 `action` 值：`password_reset_by_admin` / `register` / `login` / `create_network` / `send_task` / `report_status` 等。

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

为某个节点创建网络绑定的 `ntok_`。`anet node create` 会自动调用它，写入到 `.anet/nodes/<node-name>/config.json` 的 `token` 字段。

```bash
curl -X POST http://localhost:9200/api/auth/node-token \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"network_id": "net_xxx", "node_name": "代码1号"}'
```

**响应**：

```json
{
  "ok": true,
  "token": "ntok_xxxxxxxxxxxxxxxx"
}
```

`token` 是该 `(node_name, network_id)` 组合的 `ntok_`，hub 端强制 binding——agent 用这个 token 调 MCP 时，server 自动锁定到 `network_id`，跨网络访问拒绝。详见 [Token 概念 — ntok_](/concepts/tokens#_2-ntok-agent-的-token-每个-agent-一个)。

### POST /api/auth/tokens


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L526)

创建 API Token。

```bash
curl -X POST http://localhost:9200/api/auth/tokens \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-agent", "network_id": "net_xxx"}'
```

**响应**：

```json
{
  "ok": true,
  "token": "utok_xxxxxxxxxxxxxxxx",
  "token_id": "tok_abc123def456",
  "name": "my-agent"
}
```

::: warning Token 明文只返回一次
`token` 字段是明文 Token，**仅在创建时返回这一次**——hub 端只存 hash。丢失后请用 [DELETE /api/auth/tokens/:id](#delete-api-auth-tokens-id) 撤销 + 重新创建。
:::

### GET /api/auth/tokens


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L517)

列出用户的所有 Token。

```bash
curl http://localhost:9200/api/auth/tokens \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "tokens": [
    {
      "token_id": "tok_abc123def456",
      "name": "my-agent",
      "last_used_at": "2026-04-12 10:00:00"
    },
    {
      "token_id": "tok_xyz789",
      "name": "dashboard",
      "last_used_at": null
    }
  ]
}
```

明文 Token 字段**不返回**（只能在 POST 创建时拿一次）。

### DELETE /api/auth/tokens/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L541)

撤销 Token（hub 端立即吊销，跟 `anet logout` 仅本机清 token 区别开）。

```bash
curl -X DELETE http://localhost:9200/api/auth/tokens/tok_xxx \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "revoked": true
}
```

---

## 网络成员端点

### GET /api/networks/:id/members

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L583)

获取网络成员列表（仅 owner / admin）。

```bash
curl http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "members": [
    {
      "user_id": "u_abc123",
      "username": "alice",
      "display_name": "Alice",
      "role": "owner",
      "joined_at": "2026-04-12 10:00:00"
    },
    {
      "user_id": "u_def456",
      "username": "bob",
      "display_name": "Bob",
      "role": "member",
      "joined_at": "2026-04-15 14:30:00"
    }
  ]
}
```

`anet network members` CLI 用这个响应渲染成员列表（按 `m.display_name || m.username` 显示，role 加 emoji 图标）。

### POST /api/networks/:id/members

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L599)

添加网络成员（owner / admin only；通常 invite 流程更顺，[POST /api/networks/:id/invite](#post-api-networks-id-invite) 创建邀请码让对方自行加入）。

```bash
curl -X POST http://localhost:9200/api/networks/net_xxx/members \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"user_id": "u_def456", "role": "member"}'
```

**请求体**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `user_id` | string | &check; | 目标用户 ID |
| `role` | enum | | `admin` / `member` / `viewer`（默认 `member`） |

**响应**（成功）：

```json
{ "ok": true }
```

**常见 4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 403 | `not a member of this network` | 调用者本身不在该网络 |
| 403 | `owner/admin required` | 调用者是 `member` / `viewer`，无权添加成员 |
| 400 | `user already a member` | `user_id` 已经是该网络成员 |

写 audit log `action='member_added'`，`detail` 字段记 `<user_id> as <role>`。

### PUT /api/networks/:id/members/:user_id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L606)

修改成员角色（仅 owner，不能修改 owner 自己的角色）。

```bash
curl -X PUT http://localhost:9200/api/networks/net_xxx/members/u_def456 \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'
```

**请求体**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `role` | enum | &check; | 新角色：`admin` / `member` / `viewer`（不能改成 `owner`） |

**响应**（成功）：

```json
{ "ok": true }
```

**常见 4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 403 | `not a member of this network` | 调用者本身不在该网络 |
| 403 | `owner required` | 仅 owner 能改角色（admin 也不行） |
| 400 | `cannot assign owner role` | `role` 字段传 `owner`，server 拒绝（owner 通过创建网络获得，不能后续 promote） |
| 400 | `member not found or is owner` | 目标 `user_id` 不在网络内，或者是 owner 自己（owner 角色不可改） |

写 audit log `action='member_role_changed'`，`detail` 字段记 `<user_id> → <new_role>`。R119 FAQ Q17 提到的「改角色」入口就是这个 endpoint。

### DELETE /api/networks/:id/members/:user_id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L613)

移除成员（owner / admin only，不能移除 owner 自己）。

```bash
curl -X DELETE http://localhost:9200/api/networks/net_xxx/members/u_def456 \
  -H "Authorization: Bearer utok_xxx"
```

**响应**（成功）：

```json
{ "ok": true }
```

**常见 4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 403 | `not a member of this network` | 调用者本身不在该网络 |
| 403 | `owner/admin required` | 调用者是 `member` / `viewer`，无权移除成员 |
| 400 | `not a member` | 目标 `user_id` 不在该网络 |
| 400 | `cannot remove owner` | 目标是 owner（删除网络才能移除 owner，见 [DELETE /api/networks/:id](#delete-api-networks-id)） |

写 audit log `action='member_removed'`，`detail` 字段记 `<user_id>`。

### POST /api/networks/:id/invite

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L621)

创建邀请码。

```bash
curl -X POST http://localhost:9200/api/networks/net_xxx/invite \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"role": "member", "max_uses": 5, "expires_days": 7}'
```

**请求体**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `role` | enum | | `admin` / `member` / `viewer`（默认 `member`） |
| `max_uses` | number | | 最大使用次数（默认 `1`；`-1` 无限） |
| `expires_days` | number | | 过期天数（不传则不过期） |

**响应**：

```json
{
  "ok": true,
  "invite_code": "inv_abc123def456"
}
```

接收方用 `anet network join inv_abc123def456` 或 `POST /api/networks/join` 加入。

### POST /api/networks/join


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L637)

用邀请码加入网络。

```bash
curl -X POST http://localhost:9200/api/networks/join \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"invite_code": "inv_abc123def456"}'
```

**响应**：

```json
{
  "ok": true,
  "network_id": "net_abc123",
  "role": "member"
}
```

`anet network join` CLI 拿到该响应后会自动切换到加入的 network（即 `~/.anet/config.json` 的 `network_id` 字段更新为 `res.network_id`），并打印 `Joined network as <role>`。

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
