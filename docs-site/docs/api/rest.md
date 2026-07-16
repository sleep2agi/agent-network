# REST API 参考

CommHub Server 提供 REST API 供 Dashboard、CLI 和第三方系统调用。

## 基础信息

| 项 | 值 |
|-----|-----|
| Base URL | `http://YOUR_IP:9200` |
| 认证 | `Authorization: Bearer <token>` **（推荐）**；`?token=<token>` URL query 为 SSE / 浏览器 EventSource 保留（有 access-log 泄漏风险，详见 [安全设计](/concepts/security)） |
| 内容类型 | `application/json` |
| 编码 | UTF-8 |
| Endpoint 数 | 30+（**13 类**：[公开 1](#公开端点) · [认证 5](#认证端点) · [网络 5](#网络端点) · [数据查询 10](#数据查询端点) · [任务派发 2](#任务派发端点) · [MCP 1](#mcp-端点) · [SSE 1](#sse-端点) · [Token 管理 4](#token-管理端点) · [网络成员 6](#网络成员端点) · [文件 2](#文件端点) · [节点改名 3](#节点改名端点-rfc-010) · [Tmux 调试 3 (opt-in)](#tmux-调试端点-opt-in) · [Legacy 2](#legacy-端点-v0-6-时代-oss-后不再演进)） |
| 全 endpoint source | [`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) |

## 公开端点

### GET /health


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

健康检查，不需要认证。

```bash
curl http://localhost:9200/health
```

```json
{
  "ok": true,
  "version": "0.8.8",
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
`license: "trial"` 是 v0.6 时代 14 天试用机制的残留字段，Apache 2.0 OSS 后**不再作为商业功能门控**（自部署没有"过期"概念）。`send_task` 路径仍跑 trial 检查仅为后向兼容（verify [`server/src/tools.ts:521`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L521) `license_expired` 仍 emit），若命中见 [troubleshooting](/troubleshooting)。**v0.9.x / v0.10.x scope 都未动**（Recovery & Observability 主题为先），整段移除排到 v0.11+ / 未排期。
:::

---

## 认证端点

### POST /api/auth/register


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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
| `username` | string | &check; | 用户名（2-50 字符，字母/数字/下划线/连字符/中文） |
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
    "email": "alice@example.com",
    "role": "admin"
  },
  "token": "utok_xxxxxxxxxxxxxxxx",
  "network_token": "ntok_xxxxxxxxxxxxxxxx",
  "network_id": "net_xxxxxxxx"
}
```

`user` 对象 5 字段对照 [`server/src/auth.ts:7-13`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L7) `AuthUser` interface（`display_name` / `email` 可为 `null`）；`token` 是 `utok_` 给 CLI/Dashboard 用，`network_token` 是 `ntok_` 给 default network 里的 agent 用。

**常见 4xx**（verify [`auth.ts register()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `username must be at least 2 characters` | 用户名 < 2 字符 |
| 400 | `username too long (max 50)` | 用户名 > 50 字符 |
| 400 | `username contains invalid characters` | 含非 `a-zA-Z0-9_\-` 或非中文字符 |
| 400 | `username already taken` | 用户名重复 |
| 400 | `password must be at least 8 characters` | 第二个起注册用户密码 < 8 |
| 400 | `password must be at least 4 characters` | 首位用户（bootstrap admin）密码 < 4 |
| 400 | `password is too common` | 命中弱密码字典（[`password-dict.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/password-dict.ts)，首位用户豁免） |
| 429 | `too many requests, try again later` | 超过 30/分 IP rate limit（[`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)；localhost 豁免，详见 [安全 — IP rate limit](/concepts/security#ip-级别限制)）|

**速率限制**：30 次/分钟 per IP。

---

### POST /api/auth/login


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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
    "email": "alice@example.com",
    "role": "admin"
  },
  "token": "utok_xxxxxxxxxxxxxxxx",
  "network_id": "net_xxxxxxxx"
}
```

`user` 对象 5 字段同 register 响应（注 `email` 可为 `null`）；`network_id` 是该用户作为 owner 的 default network（[`auth.ts:113-115`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L113) 取 `ORDER BY role = 'owner' DESC LIMIT 1`）。每次 login 都签发**新的** `utok_`（不撤销已有，多设备登录互不踢，[`auth.ts:102-110`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L102)）。

**常见 4xx**（verify [`auth.ts login()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 401 | `invalid username or password` | 用户名不存在 **或** 密码哈希不匹配（[`auth.ts:99-100`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L99) 故意把两种错误合并成同一文案，避免 username enumeration）；server 同时写 `login_failed` audit |
| 429 | `too many attempts, try again later` | 超过 10/分 IP rate limit（[`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)；触发时写 `login_rate_limited` audit + clientIP）|

**速率限制**：10 次/分钟 per IP。

---

### GET /api/auth/me


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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
    "email": "alice@example.com",
    "role": "admin"
  },
  "networks": [
    { "network_id": "net_xxx", "network_name": "default", "member_role": "owner" },
    { "network_id": "net_yyy", "network_name": "team-prod", "member_role": "member" }
  ],
  "current_network": "net_xxx"
}
```

`networks` 数组列出当前用户所属的所有 network 及在该 network 的 `member_role`（字段名跟 [GET /api/networks](#get-api-networks) 一致）；`anet whoami` 用它显示「← current」标记（结合 `config.json` 里的 `network_id` 字段）。`current_network` 字段是 server 端**根据当前 token 的 binding** 解析出的 network_id（`utok_` 是全局 token 取 `~/.anet/config.json` 的 network_id；`ntok_` 强制 binding 到颁发时的 network）。

---

### PUT /api/auth/me


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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

只更新提供的字段（[server/src/index.ts](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) 用 `if (body.X)` 条件 SQL）；`username` / `role` / `password` **不**通过此 endpoint 修改。

**响应**（成功）：

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

**常见 4xx**（verify [`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `<JSON parse error>` | 请求体不是合法 JSON（catch 块直接 echo 异常 message） |
| 401 | `token required` / `invalid token` | 缺/无效 utok_ |

::: info 字段缺失不报错
如果只传 `display_name` 而省略 `email`（或两者都不传），server 不会报 400 —— [`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) 用 `if (body.X)` 条件累加 SQL，全部省略时只 re-SELECT user 返回。**无字段长度校验**（v0.9.x / v0.10.x 都未动，schema-level 校验排到 v0.11+ / 未排期）。
:::

---

### POST /api/auth/password


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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
  "revoked": 2,
  "token": "utok_xxxxxxxxxxxxxxxx",
  "token_id": "tok_new_session_id"
}
```

`revoked` 字段是**其他设备**上被撤销的 utok\_/atok\_ 数量（不含本次调用方自己的 token，那个是 index.ts L490 单独撤销的）。

**关键副作用** (verify [`auth.ts:267-282 changePassword + revokeOtherUserTokens`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L267) + [`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)):
1. **当前调用方的 `utok_`** (`resolved.tokenId`) 立即撤销（[`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) `revokeToken(...)` 显式删）
2. **其他设备的所有 `utok_` / `atok_`** 同步撤销（[`auth.ts:269-270`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L269) `DELETE ... WHERE user_id=? AND network_id IS NULL AND token_id != ?currentTokenId` 一锅端）—— 计数返回到 `revoked` 字段
3. **`ntok_` 不受影响**（`revokeOtherUserTokens` 只删 `network_id IS NULL` 的 token，agent node 用 `ntok_` 跑着的不会被改密打断；跟 [account-system 改密码副作用](/guide/account-system#修改密码) ZH 描述一致）
4. **新 `utok_`** (`issued.token`) 颁发给调用方作为响应返回 —— 调用方应立即用新 token 覆盖本地存储
5. 写 audit log: `action='password_changed'`

跟 `anet passwd` CLI 行为一致（CLI 拿到新 token 后自动写 `~/.anet/config.json`）。其他设备下次请求拿 `401 invalid token` → 必须 `anet login` 重新登录。

**常见 4xx**（verify [`auth.ts changePassword()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `new password must be at least 8 characters` | 新密码 < 8 字符 |
| 400 | `new password is too common` | 命中弱密码字典（[`password-dict.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/password-dict.ts)）|
| 400 | `user not found` | `user_id` 不存在（罕见，token 已 expire 或 user 被 admin 删） |
| 400 | `incorrect current password` | `old_password` 跟存的 hash 不匹配 |
| 401 | `token required` / `invalid token` | 缺 / 无效 utok_ |

::: tip 跟 register 强度规则一致
密码强度规则跟 register 共用 `validatePasswordStrength()`（参 [POST /api/auth/register 4xx](#post-api-auth-register)）。bootstrap admin 豁免仅适用于首位注册，**改密码无豁免**。
:::

---

## 网络端点

### GET /api/networks


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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
      "description": "Auto-created default network",
      "settings": null,
      "visibility": "private",
      "max_members": 50,
      "created_at": "2026-04-12 10:00:00",
      "updated_at": "2026-04-12 10:00:00",
      "member_role": "owner"
    }
  ]
}
```

`networks` 数组每行 10 字段：9 个 `networks` 表字段 ([`server/src/db.ts:168-177`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L168) 含 v3 migration `visibility` + `max_members`) + 1 个 join 字段 `member_role`（[`auth.ts:382-388`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L382) JOIN `network_members`）。排序：owner 在前，其余按 `created_at`（`ORDER BY nm.role = 'owner' DESC, n.created_at`）。`settings` / `description` 可为 `null`。`ntok_` 调用只返回当前 binding 那一个 network（不是全部）；`utok_` 返回所有所属网络。

---

### POST /api/networks


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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

**响应**（成功）：

```json
{
  "ok": true,
  "network_id": "net_xyz789",
  "network_name": "prod"
}
```

**常见 4xx**（verify [`auth.ts createNetwork()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `network name already exists` | 同一 owner 名下已有同名 network（`UNIQUE(owner_id, network_name)` 约束） |
| 400 | `quota exceeded: max N networks for free plan` | 触发 plan quota 配额限制（v0.8 起 admin 用户豁免；free plan 默认 max_networks_owned=2，**当前 quota 仍在 `auth.ts:184-189` enforced**，跟 networks 表的 `max_members` 不同：那个 dormant、这个 active） |
| 401 | `token required` / `invalid token` | 未提供 / 提供了无效 utok_ |

---

### GET /api/networks/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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
    "settings": null,
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

`network` 对象 9 字段 = `SELECT * FROM networks WHERE network_id = ?1` ([`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)) 完整 schema (含 v3 migration `visibility` + `max_members`)。`settings` 字段保留作未来 per-network JSON 配置，目前为 `null`。`stats.tasks` 按 status 聚合（同 [GET /api/stats](#get-api-stats) 内嵌结构）。

---

### PUT /api/networks/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

获取所有 session 状态。

```bash
curl "http://localhost:9200/api/status?network_id=net_xxx" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `network_id` | 按网络过滤（绑了 `ntok_` 时此参数被强制覆盖为 token 自带的 network）|
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
  ],
  "summary": {
    "idle": 7,
    "working": 1,
    "offline": 2,
    "total": 10
  }
}
```

`summary` 字段是按 status 聚合的计数（[`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）：`working` 类把 `working / blocked / error / waiting_input / running / busy` 都归一进去；`offline` 类是 server 端 `updated_at` 落后 10 分钟的 session（每次 GET 实时计算并写回 DB）；其他算 `idle`。

---

### GET /api/tasks


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

获取任务列表。

```bash
curl "http://localhost:9200/api/tasks?status=running&limit=10" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `network_id` | 按网络过滤（绑了 `ntok_` 时此参数被强制覆盖为 token 自带的 network）|
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
      "task_id": "t_a1b2c3d4",
      "from_node_id": null,
      "from_name": "指挥室",
      "to_node_id": "node_xxx",
      "to_name": "代码1号",
      "priority": "normal",
      "status": "replied",
      "content": "写一个 Python 快排算法",
      "result": "已完成，使用快排实现",
      "in_reply_to": null,
      "requires_response": "reply",
      "scope": "single",
      "created_at": "2026-04-12 10:00:00",
      "delivered_at": "2026-04-12 10:00:01",
      "started_at": "2026-04-12 10:00:02",
      "completed_at": "2026-04-12 10:00:15",
      "expires_at": "2026-04-12 11:00:00"
    }
  ],
  "count": 1,
  "stats": [
    { "status": "replied", "count": 85 },
    { "status": "running", "count": 5 }
  ]
}
```

字段对照 `tasks` 表 schema ([`server/src/db.ts:87-105`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L87)) `SELECT *`：主键是 `task_id` 不是 `message_id`；任务完成时间字段是 `completed_at` 不是 `replied_at`；TTL 字段是 `expires_at` 绝对时间不是 `ttl_seconds` 相对秒（`ttl_seconds` 仅 send_task **入参**用，写入时算成 `expires_at`）。`anet tasks` CLI 用 `from_name` / `to_name` / `status` / `created_at` / `content` 渲染表格 (cli.ts L2810-2817)。

---

### GET /api/task/{task_id}


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

按 `task_id` 取**单个任务**的完整记录。路径同时接受 `/api/task/<id>` 与 `/api/tasks/<id>`（末尾 `s` 可选）。

```bash
curl http://localhost:9200/api/task/<task_id> \
  -H "Authorization: Bearer ntok_xxx"
```

**路径参数**：

| 参数 | 说明 |
|------|------|
| `task_id` | 任务 ID（URL 编码）；绑定 `ntok_` 时结果被强制限定在 token 自带的 network |

**响应（200）**：`task` 为 `tasks` 表整行（`SELECT *`，字段同上 [GET /api/tasks](#get-api-tasks)）。

```json
{
  "ok": true,
  "task": { "task_id": "...", "status": "replied", "from_name": "...", "to_name": "...", "content": "...", "created_at": "...", "completed_at": "..." }
}
```

**未找到（404）**：

```json
{ "ok": false, "error": "task_not_found", "task_id": "<task_id>" }
```

---

### GET /api/nodes


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

获取节点列表（持久化节点信息，区别于 session 的临时状态）。

```bash
curl http://localhost:9200/api/nodes \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `node_id` | 按节点 ID 过滤 |
| `alias` | 按别名过滤 |
| `network_id` | 按网络过滤（ntok_ 强制 binding 时此参数被覆盖） |

**响应**：

```json
{
  "ok": true,
  "nodes": [
    {
      "node_id": "node_abc123",
      "node_name": "代码1号",
      "alias": "代码1号",
      "runtime": "claude-agent-sdk",
      "model": "your-model-id",
      "config_path": ".anet/nodes/代码1号/config.json",
      "channels": null,
      "server": "http://localhost:9200",
      "hostname": "dev-machine",
      "network_id": "net_xxxxx",
      "created_at": "2026-04-12 10:00:00",
      "updated_at": "2026-04-12 10:00:00"
    }
  ],
  "count": 1
}
```

::: info nodes vs sessions
`nodes` 表是**持久节点身份**（创建即写入，删 agent 才删），`sessions` 表是**运行时心跳状态**（agent 启动写入，10 分钟无心跳标 `offline`）。看 agent 是否在线用 [GET /api/status](#get-api-status)，看 agent 配置元数据用本 endpoint。
:::

---

### DELETE /api/nodes/:ref

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

删除节点（hub server 端）—— 从 `nodes` 表删持久身份 + 从 `sessions` 表删运行时心跳记录（同一个 transaction），并往 alias channel + network channel 推 `node_deleted` SSE 事件让 dashboard 实时刷新。配套 PR #86「node delete cascade and node_deleted SSE」。

```bash
# :ref 接受 node_id / node_name / alias 任一（URL-encoded）
curl -X DELETE "http://localhost:9200/api/nodes/n_abc12345" \
  -H "Authorization: Bearer ntok_xxx"

# 中文 alias 要 URL-encode
curl -X DELETE "http://localhost:9200/api/nodes/%E4%BB%A3%E7%A0%811%E5%8F%B7" \
  -H "Authorization: Bearer ntok_xxx"
```

**路径参数**：`:ref` 在 server 端 [`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) 用 OR 拼 `node_id = ? OR node_name = ? OR alias = ?` 找节点（网络作用域过滤后取 `updated_at DESC` 第一条）。

**响应**（成功，200）：

```json
{
  "ok": true,
  "deleted": true,
  "node_id": "n_abc12345",
  "node_name": "代码1号",
  "alias": "代码1号",
  "network_id": "net_xxxxx"
}
```

**SSE 副作用**：删完往**两个 SSE channel** 推 `node_deleted` event（[`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）：
- `alias` 自身的 SSE channel（如果还有订阅者）
- 该 `network_id` 的 user 级 SSE channel（每个网络成员都能立刻看到）

```json
// node_deleted SSE event payload
{ "type": "node_deleted", "node_id": "n_abc12345", "node_name": "代码1号", "alias": "代码1号", "network_id": "net_xxxxx" }
```

**错误响应**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|----------|
| 404 | `node not found` | `:ref` 在当前网络作用域内匹配不到 nodes 行 |
| 403 | `permission_denied` | 调用方在该 network 是 `viewer`，或 `ntok_` 锁定的不是这个 network |

**网络作用域**：跟 `GET /api/nodes` 一致 —— `ntok_` 锁 token 的 network；`utok_` 看到有权限的所有 networks 里的节点。

::: warning 跟 `anet node delete` 不一样
这个 REST endpoint 只删 hub server 端的 `nodes` / `sessions` 行；**不**删本地 `.anet/nodes/<alias>/` 配置目录，也**不**自动撤销 `ntok_`。从 hub 端清节点身份用本 endpoint；从 client CLI 一站式清干净（含本地 dir + tmux + 可选撤销 ntok_）用 `anet node delete <alias>`（详见 [CLI — `anet node delete`](/guide/cli#agent-node-管理)）。
:::

---

### GET /api/servers

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

按**物理服务器**（`hostname` + `ip`）聚合 agent 列表 + host 实时遥测，给 dashboard 「服务器侧栏」用。Refs [issue #119](https://github.com/sleep2agi/agent-network/issues/119)。

```bash
curl http://localhost:9200/api/servers \
  -H "Authorization: Bearer ntok_xxx"
```

**返回前的副作用**：跟 `/api/status` 一样，先把 10 分钟以上没心跳的 session 标 `offline`（`UPDATE sessions SET status='offline' WHERE updated_at < cutoff`），再做聚合。所以本 endpoint 的 `agent_count` 反映**所有 session**（不限 status）；要排除 offline 自己在客户端过滤 `last_seen` 即可。

**响应**：注意是**裸数组**，不是 `{ ok: true, ... }` 包裹（跟同文件其他 endpoint 不同，是历史选择）。

```json
[
  {
    "hostname": "dev-machine",
    "ip": "192.168.1.42",
    "agent_count": 7,
    "cpu_load_1min": 0.42,
    "cpu_cores": 8,
    "mem_avail_gb": 12.3,
    "mem_used_gb": 19.7,
    "last_seen": "2026-05-15 11:23:45"
  }
]
```

| 字段 | 来源 | 说明 |
|------|------|------|
| `hostname` | agent-node `os.hostname()` | 没 telemetry 的老 agent 显示 `"unknown"` |
| `ip` | agent-node 首个 non-internal IPv4 | 没 telemetry 显示 `"unknown"` |
| `agent_count` | server 聚合时 `+1` | 该 host 上的 session 总数（含 offline） |
| `cpu_load_1min` | Linux `/proc/loadavg`；macOS/Win `os.loadavg()`（Windows 永远 `[0,0,0]` 主动转 `null`） | 同 hostname+ip 取**最新**那条 |
| `cpu_cores` | `os.cpus().length` | 同上 |
| `mem_avail_gb` | Linux `/proc/meminfo` MemAvailable；macOS/Win `os.freemem()` | GB, 0.1 精度 |
| `mem_used_gb` | `mem_total - mem_avail` | GB, 0.1 精度 |
| `last_seen` | `COALESCE(last_seen_at, updated_at)` | 该 host 下最新心跳时间 |

**网络作用域**：跟 `/api/status` 一样走 `addNetworkScope` —— `ntok_` 强制锁定该 token 的 network，`utok_` 看到自己有权限的所有 networks。

::: info 数据来源
host telemetry 由 agent-node 在每次 `report_status` 时带上（[issue #119](https://github.com/sleep2agi/agent-network/issues/119) step 1，agent-node v2.3.8+）。老 agent 不带 telemetry 字段时 SQL `NULL`，`hostname`/`ip` 渲染成 `"unknown"`、其他字段为 `null`。server 端 schema 是 silent-drop unknown keys，可以独立升级 agent / server。
:::

---

### GET /api/server/:host/health

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) · v0.10.0 / `commhub-server@0.8.2`

取**单台物理服务器**的当前健康快照 + 24h 分桶历史 telemetry。Refs [issue #99](https://github.com/sleep2agi/agent-network/issues/99)（守护节点 Phase 1 scaffold）。

::: tip 需要 `agent-network@2.2.1+`
通过 `anet hub start` 默认路径要拿到这个 endpoint，**agent-network 必须 ≥ 2.2.1**（v0.10.1 hotfix [`PINNED_SERVER_VERSION`](/changelog#v0-10-1-—-hotfix-pinned-server-version-跟-v0-10-0-ship-chain-bump-2026-05-17-✅-stable) `0.8.0` → `0.8.2`）。老版本（含 2.2.0）`anet hub start` 仍跑 `commhub-server@0.8.0`，本 endpoint 不存在 → **404**。绕开方案：手动 `bunx --bun @sleep2agi/commhub-server@latest --host 127.0.0.1` 起新版 server。
:::

```bash
curl http://localhost:9200/api/server/dev-machine/health \
  -H "Authorization: Bearer ntok_xxx"

# host 含特殊字符（如 IP `192.168.1.42` 不用 encode；hostname 含空格 / `/` 需 urlencode）
curl "http://localhost:9200/api/server/$(python3 -c 'import urllib.parse; print(urllib.parse.quote("my host"))')/health" \
  -H "Authorization: Bearer ntok_xxx"
```

**路径参数**：

| 参数 | 说明 |
|------|------|
| `:host` | `hostname` 或 `ip`（任一匹配即可，URL-encoded）|

**返回前的副作用**：跟 `/api/servers` 一样先把 10 分钟无心跳 session 标 `offline`，再做查询。

**响应**：

```json
{
  "ok": true,
  "host": "dev-machine",
  "hostname": "dev-machine",
  "ip": "192.168.1.42",
  "agent_count": 7,
  "alert_level": "ok",
  "alerts": [],
  "latest": {
    "cpu_load_1min": 0.42,
    "cpu_cores": 8,
    "cpu_pct": 5.3,
    "mem_total_gb": 32.0,
    "mem_used_gb": 19.7,
    "mem_avail_gb": 12.3,
    "disk_total_gb": 500.0,
    "disk_used_gb": 213.5,
    "disk_avail_gb": 286.5,
    "last_seen": "2026-05-16 18:23:45"
  },
  "history": {
    "5m":  [{ "ts": "...", "cpu_pct": 5.1, "mem_used_gb": 19.5, ... }, ...],
    "1h":  [{ "ts": "...", "cpu_pct": 4.8, "mem_used_gb": 18.9, ... }, ...],
    "24h": [{ "ts": "...", "cpu_pct": 4.2, "mem_used_gb": 17.6, ... }, ...]
  }
}
```

| 字段 | 说明 |
|------|------|
| `host` | 请求路径里传入的 host 值 |
| `agent_count` | 该 host 上活跃 session 数（窗口取最新一行的 `COUNT(*) OVER ()`）|
| `alert_level` | `ok` / `warn` / `critical`（取 `serverAlertLevel(latest)` 计算；v0.10.2+ 加 `disk_avail_gb < 1 → critical` / `< 5 → warn` 触发，verify [`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）|
| `alerts` | 当前命中告警列表，`alert_level != ok` 时非空 |
| `latest` | 该 host 最近一次心跳的瞬时 telemetry（CPU / mem / disk + `last_seen`）|
| `latest.disk_total_gb` / `disk_used_gb` / `disk_avail_gb` | **v0.10.2 起**（agent-node `2.4.1+`，[`host-telemetry.ts readDiskStats()`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/host-telemetry.ts)）—— 通过 `execFileSync('df', ['-k', '/'])` 采样，POSIX `-k` Linux + macOS 同 parse 路径；Windows / 解析失败 graceful `null`（dashboard 渲染 `—` 不误导成 0）。老 agent (`< 2.4.1`) 不带字段时三字段都 `null` |
| `history.5m` | 最近 5min，**1 min bucket**（取自 `agent_telemetry` 历史表）|
| `history.1h` | 最近 1h，**5 min bucket** |
| `history.24h` | 最近 24h，**1 hour bucket**；v0.10.2 起 bucket 内附 `disk_avail_min` / `disk_used_max` 字段（极值聚合，verify [`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）|

**404**：`{ "ok": false, "error": "server not found" }` —— 该 host 没有任何（活跃或离线）session 命中。

**网络作用域**：同 `/api/servers`，`ntok_` 锁 token network；`utok_` 看所有有权限 networks。

---

### GET /api/server/:host/agents

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) · v0.10.0 / `commhub-server@0.8.2`

取**单台服务器上的 agent 列表** + per-agent 进程 telemetry（rss / cpu / uptime / in-flight count）。Refs [issue #99](https://github.com/sleep2agi/agent-network/issues/99) + [issue #142](https://github.com/sleep2agi/agent-network/issues/142) per-agent process telemetry。

```bash
curl http://localhost:9200/api/server/dev-machine/agents \
  -H "Authorization: Bearer ntok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "host": "dev-machine",
  "agent_count": 2,
  "agents": [
    {
      "alias": "代码1号",
      "runtime": "claude-code-cli",
      "raw_agent": "claude-code-cli",
      "model": null,
      "status": "idle",
      "task": null,
      "progress": 0,
      "last_seen": "2026-05-16 18:23:45",
      "health": "online",
      "hostname": "dev-machine",
      "ip": "192.168.1.42",
      "telemetry": {
        "cpu_load_1min": 0.42, "cpu_cores": 8, "cpu_pct": 5.3,
        "mem_total_gb": 32.0, "mem_used_gb": 19.7, "mem_avail_gb": 12.3,
        "disk_total_gb": 500.0, "disk_used_gb": 213.5, "disk_avail_gb": 286.5,
        "process_rss_bytes": 245678912, "process_rss_mb": 234.3,
        "process_cpu_pct": 3.1, "process_uptime_seconds": 1842,
        "process_in_flight_count": 0
      },
      "process_telemetry": {
        "rss_bytes": 245678912, "rss_mb": 234.3,
        "cpu_pct": 3.1, "uptime_seconds": 1842, "in_flight_count": 0
      }
    }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `agents[].runtime` | `normalizeRuntime(agent)` 归一化后的 runtime ID（`claude-code-cli` / `claude-agent-sdk` / `codex-sdk`）|
| `agents[].raw_agent` | 原 `agent` 字段（未归一化），方便排查 |
| `agents[].health` | `agentHealthChip(status, last_seen)` 健康灯（`online` / `idle` / `offline` / 等）|
| `agents[].telemetry` | 该 agent 心跳带上的 host-level + process-level 完整 telemetry（reading-friendly 视图）|
| `agents[].process_telemetry` | per-agent 进程 telemetry（`rss_bytes` / `rss_mb` / `cpu_pct` / `uptime_seconds` / `in_flight_count`，[issue #142](https://github.com/sleep2agi/agent-network/issues/142) ship in `agent-node@2.4.0`，server schema align in `commhub-server@0.8.2`）|

**404**：`{ "ok": false, "error": "server not found" }` —— 该 host 没匹配到任何 session。

**网络作用域**：同 `/api/server/:host/health`。

---

### GET /api/messages


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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
      "id": "m_abc123",
      "from_alias": "代码1号",
      "to_alias": "指挥室",
      "type": "reply",
      "priority": "normal",
      "content": "[代码1号] 已完成，使用快排实现",
      "created_at": "2026-04-12 10:00:15",
      "network_id": "net_xxxxx"
    },
    {
      "id": "m_def456",
      "from_alias": "指挥室",
      "to_alias": "代码1号",
      "type": "task",
      "priority": "normal",
      "content": "写一个快排算法",
      "created_at": "2026-04-12 10:00:00",
      "network_id": "net_xxxxx"
    }
  ]
}
```

字段对照 server SELECT ([`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)) `id, session_name as to_alias, from_session as from_alias, type, priority, content, created_at, network_id` —— 主键字段是 `id` 不是 `message_id`，含 `priority` + `network_id` 两个之前 doc 漏掉的字段。

::: info 当前 schema 限制
SELECT 暂未包含 `in_reply_to` 字段；轮询匹配回复消息时按 `from_alias` + `type='reply'` + recency 启发式匹配（详见 `cli.ts` 注释）。
:::

---

### GET /api/completions


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

获取完成记录（agent 通过 `report_completion` MCP 工具写入的总结性记录，跟 `tasks` 表 `status='replied'` 的简单 reply 不同）。

```bash
curl "http://localhost:9200/api/completions?since=2026-04-12T00:00:00Z" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `since` | 起始时间（ISO 8601）；默认最近 24 小时 |
| `network_id` | 按网络过滤（绑了 `ntok_` 时此参数被强制覆盖为 token 自带的 network）|

固定返回最多 100 条（server 端硬编码 `LIMIT 100`，无 `limit` 参数）。

**响应**：

```json
{
  "ok": true,
  "completions": [
    {
      "id": "c_abc123",
      "session_name": "代码1号",
      "task": "写一个 Python 快排算法",
      "result": "已完成，使用 Lomuto partition，附加 unit test",
      "artifacts": "[{\"file\":\"quicksort.py\"}]",
      "score": 0.95,
      "duration_minutes": 2.5,
      "network_id": "net_xxxxx",
      "completed_at": "2026-04-12 10:00:15"
    }
  ]
}
```

`artifacts` 字段是 JSON 字符串（agent 自由 schema），消费侧需 `JSON.parse()`。

---

### GET /api/task_events


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

获取任务状态变更日志（task 生命周期审计）。每次 task `status` 变化 server 都会插一行，是排查「任务卡住 / 谁改了状态」的主要数据源。

```bash
curl "http://localhost:9200/api/task_events?task_id=t_a1b2c3d4" \
  -H "Authorization: Bearer ntok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `task_id` | 按特定 task 过滤（不传则返回最近所有 task 的事件） |
| `network_id` | 按网络过滤（绑了 `ntok_` 时此参数被强制覆盖为 token 自带的 network）|
| `limit` | 最大条数（默认 50，最大 500） |

> `network_id` 不在 task_events handler 本体里读，而是所有 REST 端点统一走 [`resolveRestNetworkScope` (index.ts)](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)：`utok_` 调用可传 `network_id` 指定网络（校验 membership），`ntok_` 调用强制锁到 token 绑定的 network，system admin 可查任意网络。

**响应**：

```json
{
  "ok": true,
  "events": [
    {
      "id": 1234,
      "task_id": "t_a1b2c3d4",
      "from_status": "delivered",
      "to_status": "running",
      "actor": "node_abc123",
      "detail": null,
      "created_at": "2026-04-12 10:00:02"
    },
    {
      "id": 1235,
      "task_id": "t_a1b2c3d4",
      "from_status": "running",
      "to_status": "replied",
      "actor": "node_abc123",
      "detail": "completed in 12s",
      "created_at": "2026-04-12 10:00:14"
    }
  ],
  "count": 2
}
```

事件按 `created_at DESC` 排序（最新的在最前）。`actor` 是触发状态变更的发起方（agent `node_id` / `'hub'` / `'system'` 等），`from_status` 在初始 `created` 事件可能为 `null`。完整状态机见 [Task 生命周期](/concepts/task-lifecycle#状态说明)。

---

### GET /api/stats


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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

### GET /api/server-logs

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

读 hub 进程内**内存环形 buffer** 里的最近 N 行 console 日志（debug 用）。**仅 `users.role = 'admin'` 系统 admin 可调**（跟 [GET /api/users](#get-api-users) / [GET /api/audit-log](#get-api-audit-log) 同款 system-admin gate，注意**不是网络级 admin**）。Buffer 容量默认 500 行（由 `COMMHUB_LOG_RING` env 调，[`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）。

```bash
curl "http://localhost:9200/api/server-logs?limit=100" \
  -H "Authorization: Bearer utok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `limit` | 最大行数（默认 200，最大 = `COMMHUB_LOG_RING`，默认上限 500） |
| `since` | ISO 8601 时间戳；只返回 `ts > since` 的新日志（增量轮询用） |

**响应**：

```json
{
  "ok": true,
  "logs": [
    { "ts": "2026-04-12T10:00:00.123Z", "level": "log", "line": "[10:00:00] 代码1号 (sdk-n_xxx) → report_status: working | 写排序算法" },
    { "ts": "2026-04-12T10:00:01.456Z", "level": "warn", "line": "⚠ deprecation: ..." }
  ],
  "capacity": 500
}
```

按时间**倒序**返回（最新在最前）；每行 `line` 截断到 4000 字符（[`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）。**进程重启 buffer 清空** —— 这不是持久化日志，要持久化日志做 stdout/journald 重定向。

**4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 401 | `auth required` / `invalid token` | 缺/无效 utok_ |
| 403 | `admin only` | 调用者 `users.role !== 'admin'`（首位注册用户默认是 admin） |

---

### GET /api/audit-log


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

获取审计日志。**权限：所有已认证用户都可调，但非**系统 admin** 只能看到自己的 log 行**（server 端走 `users.role !== 'admin'` 自动加 `WHERE user_id = <caller>` 过滤，见 [`server/src/index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）。系统 admin (`users.role = 'admin'`) 看全部 + 可用 `user_id` 参数过滤任意用户。

::: warning 不是网络级 admin/owner
这里的 "admin" 指 `users.role='admin'`（**系统级**，首位注册用户默认是），**不是**网络级别的 `owner / admin / member / viewer`。详见 [GET /api/users](#get-api-users) 同款区分。
:::

```bash
curl "http://localhost:9200/api/audit-log?limit=50" \
  -H "Authorization: Bearer utok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `limit` | 最大条数（默认 50，最大 200） |
| `action` | 按 action 过滤（任何角色可用） |
| `user_id` | 按用户过滤（**仅系统 admin 有效**，非 admin 传也被忽略，强制走 own-logs） |

**响应**：

```json
{
  "ok": true,
  "logs": [
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
      "action": "network_renamed",
      "target_type": "network",
      "target_id": "net_xyz789",
      "detail": "prod-v2",
      "created_at": "2026-04-12 09:55:00"
    }
  ],
  "count": 2
}
```

字段名是 `logs` + `count`（**不是** `audit_log`，之前 doc 误写）。`audit_log` **表** schema 见 [`server/src/db.ts:201-212`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L201) 完整 10 列（含 `ip` + `network_id`）。**完整 action 值列表 + 触发场景**见 [安全设计 — 审计日志](/concepts/security#审计日志)。

::: warning `create_network` 不审计
POST `/api/networks` 不调 `logAudit`，所以 audit_log 里**不会**有 `create_network` 行。看 network 创建请走 [`GET /api/networks`](#get-api-networks) 列表对比，或借 `target_type='network' + action='network_renamed'` 间接推断（跟 [security.md 审计](/concepts/security#审计日志) `::: info` 一致）。
:::

---

### GET /api/users


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

获取所有用户列表（仅**系统 admin** —— 即 `users.role = 'admin'`，跟网络级别的 `owner / admin / member / viewer` 角色不同）。

```bash
curl http://localhost:9200/api/users \
  -H "Authorization: Bearer utok_xxx"
```

**响应**：

```json
{
  "ok": true,
  "users": [
    {
      "user_id": "u_abc123",
      "username": "alice",
      "display_name": "Alice",
      "email": "alice@example.com",
      "role": "admin",
      "created_at": "2026-04-12 10:00:00"
    },
    {
      "user_id": "u_def456",
      "username": "bob",
      "display_name": null,
      "email": null,
      "role": "user",
      "created_at": "2026-04-13 09:00:00"
    }
  ]
}
```

**4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 401 | `auth required` | 缺 `Authorization` header |
| 403 | `admin required` | 调用者不是 `users.role='admin'`（仅首位注册用户默认 admin） |

响应**不含** `password_hash` 字段（SELECT 显式 enumerate 6 列）。按 `created_at` 升序排（首位注册的 admin 在最前）。

---

## 任务派发端点

REST 版的 `send_task` / `broadcast`（非 MCP 路径，适合 webhook / 反代 / Dashboard 用）。

### POST /api/task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

REST 版 `send_task`：往指定 alias 的 inbox 投递任务 + 写 tasks 表 + SSE 推 `new_task`。

```bash
curl -X POST http://localhost:9200/api/task \
  -H "Authorization: Bearer ntok_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "alias": "代码1号",
    "task": "写一个快排算法",
    "priority": "high",
    "ttl_seconds": 7200
  }'
```

**请求体**（verify [`TaskSchema`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | 目标 Agent 别名（最大 200 字符） |
| `task` | string | &check; | 任务内容（最大 10000 字符） |
| `priority` | enum | | `high` / `normal`（默认）/ `low` |
| `from` | string | | 发送者标识（默认 `"api"`） |
| `network_id` | string | | 目标 network（utok\_ 调用时；ntok\_ 调用强制绑定） |
| `ttl_seconds` | number | | 过期秒数（默认 3600；非 schema 字段，server 在 [`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) 直接取 `body.ttl_seconds`） |

**响应**（成功）：

```json
{ "ok": true, "message_id": "uuid-xxx" }
```

**常见 4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `invalid JSON` | 请求体解析失败 |
| 400 | `invalid input` | 字段类型/长度不符合 `TaskSchema`（含 `details` 字段附 zod 报错） |
| 400 | `network_id required for user token when multiple networks are available` | utok\_ 调用方有多个 network，必须显式指定 `network_id` |
| 403 | `access denied to requested network` | utok\_ 调用方不是 `network_id` 成员 |
| 403 | `permission_denied` | 角色不足（viewer 不能写）|

**不**写 audit log（[`/api/task` 处理函数 index.ts](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) 没有 `logAudit` 调用，跟 `POST /api/networks` 的「不写」一致）；成功后给 target alias 推送 `new_task` SSE 事件。

### POST /api/broadcast

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

REST 版 `broadcast`：往一组 session 的 inbox 同步广播 + 给每个 SSE 推 `broadcast`。

```bash
curl -X POST http://localhost:9200/api/broadcast \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "5 分钟后例会，请保存进度",
    "filter_status": "idle"
  }'
```

**请求体**（verify [`BroadcastSchema`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `message` | string | &check; | 广播内容（最大 10000 字符；**字段名是 `message` 不是 `content`**） |
| `filter_server` | string | | 只发给指定 `server` 字段的 session |
| `filter_status` | string | | 只发给指定 status 的 session（如 `idle` / `working`） |

> 跟 MCP [`broadcast`](mcp-tools#broadcast) 同款字段；`from_session` 不是参数，server 端硬编码 `'api'`（[`index.ts` — `POST /api/broadcast` handler](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) 跟 MCP 版的 `'hub'` 不同）。

**响应**（成功）：

```json
{
  "ok": true,
  "recipients": 10,
  "message_ids": ["uuid-1", "uuid-2"]
}
```

`message_ids.length === recipients`，每个 target session 一个 inbox row。

**常见 4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `invalid JSON` / `invalid input` | 请求体解析或字段验证失败 |
| 400 | `network_id required for user token when broadcasting` | utok\_ 调用方有多个 network，须先 `?network_id=` 或带 ntok\_ 绑定 |
| 403 | `permission_denied` | 角色不足（viewer 不能写） |

---

## MCP 端点

### POST /mcp

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

MCP Streamable HTTP 端点，Agent 通过此端点调用 MCP Tools。

```bash
curl -X POST http://localhost:9200/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
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

### GET /events/:name

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

SSE 实时推送端点，客户端通过长连接接收事件。路径段 `:name` 是一个**通用 channel 名**（源码里叫 `:session`）：Agent 用自己的 **node alias** 订阅、Dashboard 用 **username** 订阅 user channel。SSE 层本身是 per-channel-name 的 `Map`（[`push.ts:11` `clients`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts#L11)），不区分 alias / username —— `pushEvent(name, ...)` 推给谁取决于谁注册了那个 name（如 `node.renamed` 同时推 alias 流和成员 username channel，见下表）。

```bash
# 推荐：Authorization header（避免 token 写进代理 / 浏览器历史 / access log）
curl -N -H "Authorization: Bearer ntok_xxx" http://localhost:9200/events/代码1号

# 兼容：URL query token（为浏览器原生 EventSource 保留，但有 access-log 泄漏风险 — 见 [安全设计](/concepts/security)）
curl -N "http://localhost:9200/events/代码1号?token=ntok_xxx"
```

**推送的事件类型**（verify `grep pushEvent server/src/{tools,rename}.ts + push.ts`）：

| 事件 | 触发条件 | 数据 |
|------|---------|------|
| `connected` | 初始连接握手（[`push.ts:35`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts#L35)，每个 client 连上 SSE 时发一次） | `{session, network_id}` |
| `new_task` | 收到新任务（`send_task` / `retry_task` / `reassign_task` / REST `POST /api/task`） | `{inbox_count, priority, from}` |
| `new_message` | 收到新消息（`send_message`） | `{from, message_id}` |
| `new_reply` | 收到 reply（`send_reply`） | `{from, message_id, in_reply_to, status}` |
| `broadcast` | 收到广播（`broadcast` 工具） | `{inbox_count}` |
| `chained_reply` | 子任务完成自动串回上游父任务发起者 ([`tools.ts:286/646`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L286)) | `{parent_task_id, child_task_id, child_alias}` |
| `node.renamed` | RFC-010 节点改名 COMMIT 时广播（[`rename.ts:100-123`](https://github.com/sleep2agi/agent-network/blob/main/server/src/rename.ts#L100)），推给 old + new 两个 alias 流 **+ 每个网络成员的 user channel**（dashboard 订阅的是 `/events/<username>` user channel、不是 per-alias 流，#84 SSE channel fix） | `{txn_id, alias(=new_alias), network_id, data:{old_alias, new_alias, surfaces_updated[], history_policy:"preserve"}}` |

> 旧 doc 在 `new_message` 上写过 `message` 字段、`broadcast` 上写过 `{content, from}` —— 都不对。verify [`tools.ts:571 + 911`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L571) 实际 payload 以上表为准。另注：`new_task` / `new_message` 在目标 alias **刚被改名**时会额外带一个 `renamed_from` 字段（指向旧 alias，`tools.ts` 的 `canonical.renamed` 分支）。
>
> **校正**：原表列过 `heartbeat` event with `{time}` payload，源码不发这个事件。[`push.ts:38-44`](https://github.com/sleep2agi/agent-network/blob/main/server/src/push.ts#L38) 实际发 SSE **comment 行** `: keepalive\n\n`（每 30s 一次，纯粹是给 proxy / LB 防 idle timeout 用），不会被 EventSource `onmessage` / `addEventListener` 触发，也不带 JSON payload。`connected` event 才是真正每次连接发一次的初始事件（agent-node 在 [`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) 显式处理它）。

**示例 SSE 数据流**：

```
event: connected
data: {"type":"connected","session":"代码1号","network_id":"net_xxx"}

event: new_task
data: {"type":"new_task","inbox_count":1,"priority":"high","from":"指挥室"}

: keepalive

: keepalive
```

---

## Token 管理端点

### POST /api/auth/node-token


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

为某个节点创建网络绑定的 `ntok_`。`anet node create` 会自动调用它，写入到 `.anet/nodes/<node-name>/config.json` 的 `token` 字段。

```bash
curl -X POST http://localhost:9200/api/auth/node-token \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"network_id": "net_xxx", "node_name": "代码1号"}'
```

**响应**（成功）：

```json
{
  "ok": true,
  "token": "ntok_xxxxxxxxxxxxxxxx"
}
```

`token` 是该 `(node_name, network_id)` 组合的 `ntok_`，hub 端强制 binding——agent 用这个 token 调 MCP 时，server 自动锁定到 `network_id`，跨网络访问拒绝。详见 [Token 概念 — ntok_](/concepts/tokens#_2-ntok-agent-的-token-每个-agent-一个)。

**常见 4xx**（verify [`auth.ts createNetworkTokenForNode()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) + [`index.ts` route](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `network_id and node_name required` | 请求体缺 `network_id` 或 `node_name` |
| 400 | `not a member of this network` | 调用者不在 `network_id` 内（必须先 join 才能 mint ntok_） |
| 400 | `no write access to this network` | 调用者是 `viewer` 角色（viewer 不能创建 full-access network token） |
| 401 | `auth required` / `invalid token` | 缺/无效 utok_ |

### POST /api/auth/tokens


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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
  "token": "atok_xxxxxxxxxxxxxxxx",
  "token_id": "tok_abc123def456"
}
```

::: warning Token 明文只返回一次
`token` 字段是明文 Token，**仅在创建时返回这一次**——hub 端只存 hash。丢失后请用 [DELETE /api/auth/tokens/:id](#delete-api-auth-tokens-id) 撤销 + 重新创建。
:::

::: info 这个 endpoint 创建的是 legacy `atok_`
本 endpoint 走 [`auth.ts:243` `generateToken()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L243) 颁发 `atok_` 前缀 + `scope='full'` token，是 V2 时代的兼容路径，不是 v0.8 主线的 `utok_` / `ntok_`。新代码请用：
- **`utok_`（用户 Token）**：通过 [POST /api/auth/login](#post-api-auth-login) 或 [POST /api/auth/register](#post-api-auth-register) 自动颁发
- **`ntok_`（节点 Token）**：通过 [POST /api/auth/node-token](#post-api-auth-node-token) 创建（绑定到指定 network + 节点 alias）

详见 [Token 体系](/concepts/tokens)。
:::

### GET /api/auth/tokens


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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
      "name": "node:代码1号",
      "scope": "network",
      "network_id": "net_xxxxxxxx",
      "last_used_at": "2026-04-12 10:00:00",
      "created_at": "2026-04-10 09:00:00"
    },
    {
      "token_id": "tok_xyz789",
      "name": "user-login",
      "scope": "user",
      "network_id": null,
      "last_used_at": null,
      "created_at": "2026-04-12 10:30:00"
    }
  ]
}
```

每行 6 字段对照 [`auth.ts:209-213`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L209) `listTokens` SELECT：`token_id / name / scope / network_id / last_used_at / created_at`。`scope` 取值 `user` (utok\_) / `network` (ntok\_) / `full` (legacy atok\_)；`network_id` 仅 `network` / `full` scope 有值。按 `created_at DESC` 排序。明文 Token 字段**不返回**（只能在 POST 创建时拿一次）。

### DELETE /api/auth/tokens/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

撤销 Token（hub 端立即吊销，跟 `anet logout` 仅本机清 token 区别开）。

```bash
curl -X DELETE http://localhost:9200/api/auth/tokens/tok_xxx \
  -H "Authorization: Bearer utok_xxx"
```

**响应**（成功）：

```json
{ "ok": true }
```

**4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 404 | `token not found` | `token_id` 不存在或不属于当前 user（[`auth.ts:252-254`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L252) `DELETE ... WHERE token_id=?1 AND user_id=?2` 受影响行 0） |

写 audit log `action='token_revoked'`。撤销后该 token 的下一次请求拿 401 `invalid token`。

---

## 网络成员端点

### GET /api/networks/:id/members

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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

写 audit log `action='member_role_changed'`，`detail` 字段记 `<user_id> → <new_role>`。FAQ Q17 提到的「改角色」入口就是这个 endpoint。

### DELETE /api/networks/:id/members/:user_id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

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

**响应**（成功）：

```json
{
  "ok": true,
  "invite_code": "inv_abc123def456"
}
```

**常见 4xx**（verify [`auth.ts createInvite()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) + [`index.ts` route handler](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `invalid role` | `role` 不是 `admin` / `member` / `viewer` 之一 |
| 403 | `not a member of this network` | 调用者本身不在该网络（[`index.ts` callerRole gate](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)） |
| 403 | `owner/admin required` | 调用者是 `member` / `viewer`，无权 issue 邀请码 |

接收方用 `anet network join inv_abc123def456` 或 `POST /api/networks/join` 加入。`invite_code` 是 `inv_` 前缀 + 12 字符（`auth.ts:346` `slice(0, 12)`）。

### POST /api/networks/join


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

用邀请码加入网络。

```bash
curl -X POST http://localhost:9200/api/networks/join \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"invite_code": "inv_abc123def456"}'
```

**响应**（成功）：

```json
{
  "ok": true,
  "network_id": "net_abc123",
  "role": "member"
}
```

**常见 4xx**（verify [`auth.ts joinByInvite()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `invalid invite code` | `invite_code` 不存在 |
| 400 | `invite code fully used` | `used_count >= max_uses`（max_uses=-1 无限） |
| 400 | `invite code expired` | `expires_at < now()`（不传 `expires_days` 创建则不会过期） |
| 400 | `already a member of this network` | 调用者已是该网络成员 |

`anet network join` CLI 拿到该响应后会自动切换到加入的 network（即 `~/.anet/config.json` 的 `network_id` 字段更新为 `res.network_id`），并打印 `Joined network as <role>`。同时 server 自动颁发一个 `network_id` 绑定的 token 给加入者（[`auth.ts:374-377`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L374) `name='auto-join' scope='full'`），写 audit `network_joined`。

---

## 文件端点

附件（图片等）的上传 / 下载，支撑 Dashboard 发图片、commhub 附件、codex-sdk 图片输入等功能。两个端点都需 `Authorization: Bearer <token>`。

### POST /api/upload

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

上传一个文件，返回可下载的 `url`。

- 请求：`multipart/form-data`，必须带一个 `file` 字段，且必须带 `Content-Length` 头。
- 大小上限 **12 MiB**（`MAX_UPLOAD_BYTES`），两段校验：先按 `Content-Length` fail-fast，再按解析后的实际大小复核。
- 限流：**60 次/小时**（按 token id 计，无 token 时按 IP），超限返回 `429 rate_limited`（带 `X-RateLimit-*` 头）。

```bash
curl -X POST http://localhost:9200/api/upload \
  -H "Authorization: Bearer utok_xxx" \
  -F "file=@./cover.png"
```

成功 `200`：

```json
{ "ok": true, "file_id": "...", "url": "/api/files/<file_id>", "size": 12345, "mime": "image/png" }
```

常见错误：`411 length_required`（缺 `Content-Length`）· `413 payload_too_large`（超 12 MiB，带 `limit_bytes`）· `415 unsupported_media_type`（不是 `multipart/form-data`）· `400 missing_file`（没 `file` 字段）· `429 rate_limited`。

### GET /api/files/:file_id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

下载 `POST /api/upload` 返回的文件。始终强制 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`（浏览器不 inline 渲染，防 XSS）。

```bash
curl -OJ http://localhost:9200/api/files/<file_id> -H "Authorization: Bearer utok_xxx"
```

常见错误：`400 bad_file_id`（id 格式非法）· `404 not_found`（无此文件索引）/ `404 blob_missing`（有索引但磁盘上文件不在）。

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

---

## 节点改名端点（RFC-010）

> RFC-010 active-rename 两阶段事务的协调端点，由 `anet node rename` 内部调用（流程见 [node-lifecycle §7](https://github.com/sleep2agi/agent-network/blob/main/docs/node-lifecycle.md)）。一般不直接手调，列在此处供集成方参考。三个端点都要 `Authorization: Bearer`（缺 token 401 / 无效 token 401）。

### POST /api/node-rename/prepare

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

PHASE 1：登记一笔改名事务（old node 不动，全程可回滚）。成功后写 `node_rename_prepared` audit。

```bash
curl -X POST http://localhost:9200/api/node-rename/prepare \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"network_id":"net_xxx","old_alias":"old-bot","new_alias":"new-bot"}'
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `network_id` | ✅ | 节点所在网络 |
| `old_alias` | ✅ | 当前 alias |
| `new_alias` | ✅ | 目标 alias |

**响应**：`{ ok, txn_id }` —— `txn_id` 用于后续 commit / abort。三个字段缺一返回 400。

### POST /api/node-rename/commit

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

PHASE 2 C1：提交改名事务（CommHub 路由切到 `new_alias`）。成功后写 `node_rename_committed` audit。

```bash
curl -X POST http://localhost:9200/api/node-rename/commit \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"txn_id":"..."}'
```

body `{ txn_id }` 必填（缺则 400）。

### POST /api/node-rename/abort

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

回滚改名事务（C1 之前调用，old node 恢复原状）。成功后写 `node_rename_aborted` audit。

```bash
curl -X POST http://localhost:9200/api/node-rename/abort \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"txn_id":"..."}'
```

body `{ txn_id }` 必填（缺则 400）。

---

## Tmux 调试端点（opt-in）

::: warning 默认关闭
仅在 `COMMHUB_ENABLE_TMUX=1` 启动 hub 时启用（[`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）。**默认全部返回 404 `tmux disabled`**。启用后还需 (a) 调用方 IP 在 `COMMHUB_TMUX_ALLOWLIST` 允许范围（逗号分隔，默认仅 localhost；verify [`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)）+ (b) `users.role='admin'` system-admin auth。设计意图：让 hub 主机上的 agent tmux session 暴露给同机的 dev / dashboard 调试，**绝不要在公网开**。公网部署 hardening 步骤见 [生产部署 §5 tmux 控制面已关闭](/deploy/production#_5-确认-tmux-控制面已关闭)。
:::

### GET /api/tmux/:name

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

抓取指定 tmux session 当前 pane 末尾 N 行输出（`tmux capture-pane -t <name> -p` 包装）。

```bash
curl "http://localhost:9200/api/tmux/anet-node-代码1号?lines=50" \
  -H "Authorization: Bearer utok_xxx"
```

**查询参数**：

| 参数 | 说明 |
|------|------|
| `lines` | 末尾行数（默认 30） |

**响应**（成功）：

```json
{ "ok": true, "tmux_name": "anet-node-代码1号", "lines": 50, "output": "...captured pane content..." }
```

### POST /api/tmux/:name/send

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

往指定 tmux session 注入按键（`tmux send-keys -t <name> "<text>" Enter` 包装）。

```bash
curl -X POST "http://localhost:9200/api/tmux/anet-node-代码1号/send" \
  -H "Authorization: Bearer utok_xxx" \
  -H "Content-Type: application/json" \
  -d '{"text": "/help", "enter": true}'
```

**请求体**：

| 字段 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `text` | string | &check; | 要注入的按键内容 |
| `enter` | boolean | | 是否末尾追加 Enter 键（默认 `true`） |

**4xx / 4xx 都共用**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 404 | `tmux disabled` | 未设 `COMMHUB_ENABLE_TMUX=1` |
| 403 | `tmux access denied from this ip` | 调用方 IP 不在 `COMMHUB_TMUX_ALLOWLIST` 范围（默认仅 localhost） |
| 401 / 403 | 需 admin auth（同 [GET /api/server-logs](#get-api-server-logs)） |
| 400 | `text is required` (POST only) | 请求体缺 `text` 字段 |
| 400 | `<tmux stderr>` | `tmux` 子进程非 0 退出（如 session 不存在） |

### GET /ws/tmux/:name

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

WebSocket 端点 —— 实时流式推送指定 tmux session 的 pane 输出。是 `GET /api/tmux/:name` 的 live 版本：HTTP 那个是一次性 `capture-pane`，这个是连上后持续 stream。鉴权门控跟上面两个 HTTP 端点**完全一致**（走同一个 `requireTmuxAccess` —— `COMMHUB_ENABLE_TMUX=1` + IP 在 `COMMHUB_TMUX_ALLOWLIST` 内 + `users.role='admin'` auth；任一不满足在 WS upgrade 前就被拒）。

```
ws://localhost:9200/ws/tmux/anet-node-代码1号
```

连上后 server 按固定间隔 `tmux capture-pane` 把 pane 内容推过来；连接断开自动停止轮询。同样**绝不要在公网开**。

---

## Legacy 端点（v0.6 时代，OSS 后不再演进）

::: warning Apache 2.0 OSS 后不再依赖
v0.8 起项目转 Apache 2.0 开源 + 自部署，没有官方付费 license。下面两个 endpoint 是 v0.6 试用 / 激活码体系的遗留路径，hub 仍保留 `licenses` 表 + 14 天 trial 兜底，但**新用户和文档主线不需要碰**。命中 `license_expired` 见 [troubleshooting](/troubleshooting#license-expired-授权过期-legacy-行为)。
:::

### GET /api/license

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

查 `licenses` 表第一行（按 `created_at` 升序），返回 trial / pro 状态 + 剩余天数。

```bash
curl http://localhost:9200/api/license
# → 公开端点（不需要 Authorization header）
```

**响应**（trial / pro）：

```json
{
  "ok": true,
  "license": { "type": "trial", "expires_at": "2026-04-25 12:00:00", "days_left": 12, "expired": false },
  "limits": { "max_agents": 5, "max_networks": 1, "max_tasks_day": 100 }
}
```

**响应**（无 license 行）：

```json
{ "ok": true, "status": "no_license" }
```

### POST /api/license/activate

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts)

注入 pro license key（[`index.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts) 只校验 `key.startsWith('anet-') && length >= 16`，**没真正的服务端校验**）。删除原有 license 行 + 写新 pro license（限额 50 agent / 10 network / 10000 task/day，过期 365 天）。

```bash
curl -X POST http://localhost:9200/api/license/activate \
  -H "Content-Type: application/json" \
  -d '{"key": "anet-anything-16-plus-chars"}'
```

**响应**（成功）：

```json
{ "ok": true, "type": "pro", "expires_in_days": 365 }
```

**4xx**：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `key required` | 请求体缺 `key` |
| 400 | `invalid license key` | `key` 不以 `anet-` 开头或长度 < 16（**仅前缀长度校验，无真实签名**） |

> 这个 endpoint 几乎是「自助绕过」，OSS 后只为兜底命中 `license_expired` 用。详见 [troubleshooting — license_expired](/troubleshooting#license-expired-授权过期-legacy-行为) + [CLI `anet activate`](/guide/cli#其他)。

---

## 下一步

**对应 MCP 工具**：
- [MCP 工具](/api/mcp-tools) — Agent 端用的 stdio MCP 协议（自动调 REST）

**深入鉴权**：
- [Token 体系](/concepts/tokens) — utok_ / ntok_ / atok_
- [安全设计](/concepts/security) — 完整鉴权模型
- [v0.7 → v0.8 升级](/guide/upgrade#v0-7-v0-8-升级注意-最新) — RFC-001 Phase 2

**实战调用**：
- [Dashboard](/guide/dashboard) — 实际 UI 调用了哪些 REST 端点
