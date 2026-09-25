<script setup>
// Old deep links (/api/rest#<anchor>) whose section moved to a sub-page when the
// REST reference was split (docs slimming, 2026-09-25): forward them.
import { onMounted } from 'vue'
const moved = { data: ["数据查询端点", "get-api-status", "get-api-tasks", "get-api-task", "get-api-nodes", "get-api-host-supervisors", "delete-api-nodes-ref", "put-api-nodes-ref-avatar", "校验规则-avatar-validate-ts-↗", "get-api-servers", "get-api-server-host-health", "get-api-server-host-agents", "get-api-messages", "get-api-messages-scope-user", "get-api-node-create-requests", "post-api-messages-ack", "get-api-completions", "get-api-task-events", "get-api-stats", "get-api-server-logs", "get-api-audit-log", "get-api-users", "任务派发端点", "post-api-task", "mcp-优先与-rest-fallback", "post-api-broadcast", "mcp-端点", "post-mcp", "sse-端点", "get-events-name", "get-events-network-network-id"], admin: ["token-管理端点", "post-api-auth-node-token", "post-api-auth-tokens", "get-api-auth-tokens", "delete-api-auth-tokens-id", "网络成员端点", "get-api-networks-id-members", "post-api-networks-id-members", "put-api-networks-id-members-user-id", "delete-api-networks-id-members-user-id", "post-api-networks-id-invite", "post-api-networks-join", "文件端点", "post-api-upload", "get-api-files-file-id", "节点改名端点-rfc-010", "post-api-node-rename-prepare", "post-api-node-rename-commit", "post-api-node-rename-abort", "tmux-调试端点-opt-in", "get-api-tmux-name", "post-api-tmux-name-send", "get-ws-tmux-name", "legacy-端点-v0-6-时代-oss-后不再演进", "get-api-license", "post-api-license-activate"] }
onMounted(() => {
  const id = decodeURIComponent(window.location.hash.slice(1))
  if (!id) return
  const page = moved.data.includes(id) ? 'rest-data' : moved.admin.includes(id) ? 'rest-admin' : null
  if (page) window.location.replace('/api/' + page + '#' + encodeURIComponent(id))
})
</script>

# REST API 参考

CommHub Server 提供 REST API 供 Dashboard、CLI 和第三方系统调用。

## 基础信息

| 项 | 值 |
|-----|-----|
| Base URL | `http://YOUR_IP:9200` |
| 认证 | `Authorization: Bearer <token>` **（推荐）**；`?token=<token>` URL query 为 SSE / 浏览器 EventSource 保留（有 access-log 泄漏风险，详见 [安全设计](/concepts/security)） |
| 内容类型 | `application/json` |
| 编码 | UTF-8 |
| Endpoint 数 | 30+（**13 类**：[公开 1](#公开端点) · [认证 5](#认证端点) · [网络 5](#网络端点) · [数据查询 10](/api/rest-data#数据查询端点) · [任务派发 2](/api/rest-data#任务派发端点) · [MCP 1](/api/rest-data#mcp-端点) · [SSE 1](/api/rest-data#sse-端点) · [Token 管理 4](/api/rest-admin#token-管理端点) · [网络成员 6](/api/rest-admin#网络成员端点) · [文件 2](/api/rest-admin#文件端点) · [节点改名 3](/api/rest-admin#节点改名端点-rfc-010) · [Tmux 调试 3 (opt-in)](/api/rest-admin#tmux-调试端点-opt-in) · [Legacy 2](/api/rest-admin#legacy-端点-v0-6-时代-oss-后不再演进)） |
| 全 endpoint source | [`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) |

## 公开端点

### GET /health


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> 🔴 **这份样例是实测抓的,不是手写的** —— 2026-08-13 在干净容器里
> `bunx --bun @sleep2agi/commhub-server@0.8.8`,未认证 `curl /health` 的原样响应。
>
> **两条线的键不一样,解析 `/health` 的脚本要按信道分别处理:**
>
> 🔴 **`latest` 已于 2026-08-27 从 `0.8.8` 移到 `0.9.0-preview.30`(含脱敏修复 `7bacb729`)。**
> 下面按**版本**描述,不按信道 —— 信道会移动,版本不会。
> 现在指向哪个版本:`npm view @sleep2agi/commhub-server dist-tags`。
>
> | 键 | `0.8.8` | `0.9.0-preview.29` |
> |---|---|---|
> | `sse_sessions` | **未认证也会返回,且未脱敏** | 未认证不返回 |
> | `limits` | 没有 | 有 |
>
> **本次实测中**,其余 13 个键两条线都有 —— 每条线各一个样本,不是永久契约。

::: danger `0.8.8` 的 `sse_sessions` 会向匿名调用方泄露全部在线 agent
上面那个样本里 `sse_sessions` 是 `{}`,**只是因为那个干净容器一条 SSE 连接都没有**。
**不要把它读成「latest 不泄露」。**

`/health` 的脱敏是 [#473](https://github.com/sleep2agi/agent-network/issues/473) 修的,
落于 **2026-07-29**(`7bacb729`),而 `commhub-server@0.8.8` 发布于 **2026-06-24** ——
**早 35 天,所以 `0.8.8` 不含这个修复。**

在有连接的 `0.8.8` hub 上,匿名 `GET /health` 返回的是**每个活跃连接的
`{networkId}:{alias}` 明细**。当时的公开 hub 审计(2026-07-30)一次拿到了
**网络 id + 全部 95 个 agent 别名**,证据见 `server/src/health-redaction.test.ts`。

所以两条线的差别不是「有键 / 没键」,是:

- **`0.8.8`** —— 未认证可读全部在线会话明细(空 hub 上恰好为空);
- **preview `0.9.0-preview.22` 及以后** —— 匿名只给聚合计数,明细移到需鉴权的 `GET /api/stats/sse`;
- ⚠️ **preview `0.9.0-preview.0` ~ `.21` 同样会泄露** —— 它们发布于 2026-06-28 ~ 07-04,**早于修复**。
  别把「preview」整条线当成安全的。

把 `0.8.8` 的 hub 暴露到公网前,先确认这一点。
:::

另外,如果你的解析代码用「键是否存在」来判断权限,两条线的行为也不同。

未认证请求的行为**按线区分**(见上表与上面的告警):preview 上只返回聚合数据、
不含 `sse_sessions`;`0.8.8` 上该键**未脱敏**返回 —— 空 hub 上恰好为空,
一旦有连接就是完整的 `{networkId}:{alias}` 明细。携带有效 token 时：
- system-admin、legacy master 或 DEV_OPEN 调用方可看到完整 `sse_sessions`；
- 普通 `utok_` / `ntok_` 只看到其有权访问网络的 session；无网络成员关系时返回空对象。

::: tip `license` 字段是 v0.6 legacy
`license: "trial"` 是 v0.6 时代 14 天试用机制的残留字段，Apache 2.0 OSS 后**不再作为商业功能门控**（自部署没有"过期"概念）。`send_task` 路径仍跑 trial 检查仅为后向兼容（verify [`server/src/tools.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) 里 `license_expired` 仍 emit），若命中见 [troubleshooting](/troubleshooting)。**v0.9.x / v0.10.x scope 都未动**（Recovery & Observability 主题为先），整段移除排到 v0.11+ / 未排期。
:::

---

## 认证端点

### POST /api/auth/register


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

`user` 对象 5 字段对照 [`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) 搜 `interface AuthUser` `AuthUser` interface（`display_name` / `email` 可为 `null`）；`token` 是 `utok_` 给 CLI/Dashboard 用，`network_token` 是 `ntok_` 给注册时自动创建的那个网络里的 agent 用。

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
| 429 | `too many requests, try again later` | 超过 30/分 IP rate limit（[`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)；localhost 豁免，详见 [安全 — IP rate limit](/concepts/security#ip-级别限制)）|

**速率限制**：30 次/分钟 per IP。

---

### POST /api/auth/login


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

`user` 对象 5 字段同 register 响应（注 `email` 可为 `null`）；`network_id` 是该用户作为 owner 的 default network（[`auth.ts:197-199`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L197) 取 `ORDER BY role = 'owner' DESC LIMIT 1`）。每次 login 都签发**新的** `utok_`（不撤销已有，多设备登录互不踢，[`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) 搜 `// User token (utok_) — not bound to network, for CLI/Dashboard login`）。

**常见 4xx**（verify [`auth.ts login()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 401 | `invalid username or password` | 用户名不存在 **或** 密码哈希不匹配（[`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) 搜 `invalid username or password`（全仓 2 处） 故意把两种错误合并成同一文案，避免 username enumeration）；server 同时写 `login_failed` audit |
| 429 | `rate_limited` | 超过 10/分 IP rate limit（[`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)；触发时写 `login_rate_limited` audit + clientIP）|

**速率限制**：10 次/分钟 per IP。

429 的**完整响应体**（`error` 字段是 `rate_limited`，不是文案本身）：

```json
{ "ok": false, "error": "rate_limited",
  "message": "Too many login attempts. Try again later.",
  "retry_after_ms": 42000 }
```

同时返回 `Retry-After` 响应头（秒，由 `retry_after_ms` 向上取整）。
按 `error` 字段判定，不要匹配 `message` 文案。

---

### GET /api/auth/me


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

只更新提供的字段（[server/src/server.ts](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) 用 `if (body.X)` 条件 SQL）；`username` / `role` / `password` **不**通过此 endpoint 修改。

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

**常见 4xx**（verify [`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `<JSON parse error>` | 请求体不是合法 JSON（catch 块直接 echo 异常 message） |
| 401 | `token required` / `invalid token` | 缺/无效 utok_ |

::: info 字段缺失不报错
如果只传 `display_name` 而省略 `email`（或两者都不传），server 不会报 400 —— [`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) 用 `if (body.X)` 条件累加 SQL，全部省略时只 re-SELECT user 返回。**无字段长度校验**（v0.9.x / v0.10.x 都未动，schema-level 校验排到 v0.11+ / 未排期）。
:::

---

### POST /api/auth/password


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

`revoked` 字段是**其他设备**上被撤销的 utok\_/atok\_ 数量（不含本次调用方自己的 token，那个由 `server.ts` 改密处理函数里的 `revokeToken(resolved.user.user_id, resolved.tokenId)` 单独撤销）。

**关键副作用** (verify [`auth.ts` `changePassword` + `revokeOtherUserTokens`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L417) + [`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)):
1. **当前调用方的 `utok_`** (`resolved.tokenId`) 立即撤销（[`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) `revokeToken(...)` 显式删）
2. **其他设备的所有 `utok_` / `atok_`** 同步撤销（[`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) 搜 `network_id IS NULL AND token_id != ` `DELETE ... WHERE user_id=? AND network_id IS NULL AND token_id != ?currentTokenId` 一锅端）—— 计数返回到 `revoked` 字段
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


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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
      "network_name": "alice",
      "owner_id": "u_abc123",
      "description": "Auto-created network for alice",
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

`networks` 数组每行 10 字段：9 个 `networks` 表字段 ([`db.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts) 搜 `CREATE TABLE IF NOT EXISTS networks` 含 v3 migration `visibility` + `max_members`) + 1 个 join 字段 `member_role`（[`auth.ts` `getUserNetworks`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L307) JOIN `network_members`）。排序：owner 在前，其余按 `created_at`（`ORDER BY nm.role = 'owner' DESC, n.created_at`）。`settings` / `description` 可为 `null`。`ntok_` 调用只返回当前 binding 那一个 network（不是全部）；`utok_` 返回所有所属网络。

---

### POST /api/networks


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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
| 400 | `quota exceeded: max N networks for free plan` | 触发 plan quota 配额限制（v0.8 起 admin 用户豁免；free plan 默认 max_networks_owned=2，**真正会拒绝建网的是 plan 配额** —— `auth.ts` 的 `createNetwork()` 按 `max_networks_owned` 校验(free=2,admin 豁免)。注意它与 `/api/license` 的 `limits` 不是一回事:后者(trial 默认 `max_agents=5` / `max_networks=3` / `max_tasks_day=500`)**是软限额**,服务端只存储和返回、不做任何拦截(CLI 里直接标作 `Soft limits`),而且两者的 networks 数字不同(3 vs 2)—— 以实际生效的 plan 配额为准（原文钉的 `184-189` 已漂到发 token 的代码上，所以这里改钉函数名），跟 networks 表的 `max_members` 不同：那个 dormant、这个 active） |
| 401 | `token required` / `invalid token` | 未提供 / 提供了无效 utok_ |

---

### GET /api/networks/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

`network` 对象 9 字段 = `SELECT * FROM networks WHERE network_id = ?1` ([`server/src/server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)) 完整 schema (含 v3 migration `visibility` + `max_members`)。`settings` 字段保留作未来 per-network JSON 配置，目前为 `null`。`stats.tasks` 按 status 聚合（同 [GET /api/stats](/api/rest-data#get-api-stats) 内嵌结构）。

---

### PUT /api/networks/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

## 其余端点 {#more-endpoints}

REST 参考分成三页：

- **本页**：基础信息、公开端点、认证、网络、错误格式
- [数据查询、任务与实时推送](/api/rest-data)：数据查询、任务派发、MCP 端点、SSE 端点
- [管理端点](/api/rest-admin)：Token 管理、网络成员、文件、节点改名、Tmux 调试、Legacy

## 下一步

**对应 MCP 工具**：
- [MCP 工具](/api/mcp-tools) — Agent 端用的 stdio MCP 协议（自动调 REST）

**深入鉴权**：
- [Token 体系](/guide/account-system#tokens) — utok_ / ntok_ / atok_
- [安全设计](/concepts/security) — 完整鉴权模型
- [v0.7 → v0.8 升级](/guide/upgrade#v0-7-v0-8-升级注意-最新) — RFC-001 Phase 2

**实战调用**：
- [Dashboard](/guide/dashboard) — 实际 UI 调用了哪些 REST 端点
