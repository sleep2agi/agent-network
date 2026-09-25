# REST API：管理端点

本页是 [REST API 参考](/api/rest) 的一部分：Token、网络成员、文件、节点改名、调试与 Legacy 端点。基础约定（地址、认证、错误格式）见[总览](/api/rest)。

## Token 管理端点

### POST /api/auth/node-token


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

`token` 是该 `(node_name, network_id)` 组合的 `ntok_`，hub 端强制 binding——agent 用这个 token 调 MCP 时，server 自动锁定到 `network_id`，跨网络访问拒绝。详见 [Token 概念 — ntok_](/guide/account-system#tokens)。

**常见 4xx**（verify [`auth.ts createNetworkTokenForNode()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) + [`server.ts` route](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `network_id and node_name required` | 请求体缺 `network_id` 或 `node_name` |
| 400 | `not a member of this network` | 调用者不在 `network_id` 内（必须先 join 才能 mint ntok_） |
| 400 | `no write access to this network` | 调用者是 `viewer` 角色（viewer 不能创建 full-access network token） |
| 401 | `auth required` / `invalid token` | 缺/无效 utok_ |

### POST /api/auth/tokens


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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
本 endpoint 走 [`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) 搜 `generateToken`（全仓 3 处） 颁发 `atok_` 前缀 + `scope='full'` token，是 V2 时代的兼容路径，不是 v0.8 主线的 `utok_` / `ntok_`。新代码请用：
- **`utok_`（用户 Token）**：通过 [POST /api/auth/login](/api/rest#post-api-auth-login) 或 [POST /api/auth/register](/api/rest#post-api-auth-register) 自动颁发
- **`ntok_`（节点 Token）**：通过 [POST /api/auth/node-token](#post-api-auth-node-token) 创建（绑定到指定 network + 节点 alias）

详见 [Token 体系](/guide/account-system#tokens)。
:::

### GET /api/auth/tokens


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

每行 6 字段对照 [`auth.ts` `listTokens`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L347) `listTokens` SELECT：`token_id / name / scope / network_id / last_used_at / created_at`。`scope` 取值 `user` (utok\_) / `network` (ntok\_) / `full` (legacy atok\_)；`network_id` 仅 `network` / `full` scope 有值。按 `created_at DESC` 排序。明文 Token 字段**不返回**（只能在 POST 创建时拿一次）。

### DELETE /api/auth/tokens/:id

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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
| 404 | `token not found` | `token_id` 不存在或不属于当前 user（[`auth.ts` `revokeToken`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L395) `DELETE ... WHERE token_id=?1 AND user_id=?2` 受影响行 0） |

写 audit log `action='token_revoked'`。撤销后该 token 的下一次请求拿 401 `invalid token`。

---

## 网络成员端点

### GET /api/networks/:id/members

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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
| 400 | `cannot remove owner` | 目标是 owner（删除网络才能移除 owner，见 [DELETE /api/networks/:id](/api/rest#delete-api-networks-id)） |

写 audit log `action='member_removed'`，`detail` 字段记 `<user_id>`。

### POST /api/networks/:id/invite

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

**常见 4xx**（verify [`auth.ts createInvite()`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) + [`server.ts` route handler](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）：

| 状态 | `error` 值 | 触发条件 |
|------|------------|---------|
| 400 | `invalid role` | `role` 不是 `admin` / `member` / `viewer` 之一 |
| 403 | `not a member of this network` | 调用者本身不在该网络（[`server.ts` callerRole gate](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)） |
| 403 | `owner/admin required` | 调用者是 `member` / `viewer`，无权 issue 邀请码 |

接收方用 `anet network join inv_abc123def456` 或 `POST /api/networks/join` 加入。`invite_code` 是 `inv_` 前缀 + 12 字符（`auth.ts` `createInvite` `slice(0, 12)`）。

### POST /api/networks/join


> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

`anet network join` CLI 拿到该响应后会自动切换到加入的 network（即 `~/.anet/config.json` 的 `network_id` 字段更新为 `res.network_id`），并打印 `Joined network as <role>`。同时 server 自动颁发一个 `network_id` 绑定的 token 给加入者（[`auth.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts) 搜 `"auto-join", "full"` `name='auto-join' scope='full'`），写 audit `network_joined`。

---

## 文件端点

附件（图片等）的上传 / 下载，支撑 Dashboard 发图片、commhub 附件、codex-sdk 图片输入等功能。两个端点都需 `Authorization: Bearer <token>`。

### POST /api/upload

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

文件下载只接受 `Authorization: Bearer ...` 请求头。出于凭据泄漏防护，
此端点不接受 `?token=` URL 参数（包括 `HEAD` 请求）。

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

下载 `POST /api/upload` 返回的文件。始终强制 `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`（浏览器不 inline 渲染，防 XSS）。

```bash
curl -OJ http://localhost:9200/api/files/<file_id> -H "Authorization: Bearer utok_xxx"
```

常见错误：`400 bad_file_id`（id 格式非法）· `404 not_found`（无此文件索引）/ `404 blob_missing`（有索引但磁盘上文件不在）。

---

## 节点改名端点（RFC-010）

> RFC-010 active-rename 两阶段事务的协调端点，由 `anet node rename` 内部调用（流程见 [node-lifecycle §7](https://github.com/sleep2agi/agent-network/blob/main/docs/node-lifecycle.md)）。一般不直接手调，列在此处供集成方参考。三个端点都要 `Authorization: Bearer`（缺 token 401 / 无效 token 401）。

### POST /api/node-rename/prepare

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

PHASE 2 C1：提交改名事务（CommHub 路由切到 `new_alias`）。成功后写 `node_rename_committed` audit。

```bash
curl -X POST http://localhost:9200/api/node-rename/commit \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"txn_id":"..."}'
```

body `{ txn_id }` 必填（缺则 400）。

### POST /api/node-rename/abort

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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
仅在 `COMMHUB_ENABLE_TMUX=1` 启动 hub 时启用（[`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）。**默认全部返回 404 `tmux disabled`**。启用后还需 (a) 调用方 IP 在 `COMMHUB_TMUX_ALLOWLIST` 允许范围（逗号分隔，默认仅 localhost；verify [`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)）+ (b) `users.role='admin'` system-admin auth。设计意图：让 hub 主机上的 agent tmux session 暴露给同机的 dev / dashboard 调试，**绝不要在公网开**。公网部署 hardening 步骤见 [生产部署 §5 tmux 控制面已关闭](/deploy/production#_5-确认-tmux-控制面已关闭)。
:::

### GET /api/tmux/:name

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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
| 401 / 403 | 需 admin auth（同 [GET /api/server-logs](/api/rest-data#get-api-server-logs)） |
| 400 | `text is required` (POST only) | 请求体缺 `text` 字段 |
| 400 | `<tmux stderr>` | `tmux` 子进程非 0 退出（如 session 不存在） |

### GET /ws/tmux/:name

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

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
  "limits": { "max_agents": 5, "max_networks": 3, "max_tasks_day": 500 }
}
```

**响应**（无 license 行）：

```json
{ "ok": true, "status": "no_license" }
```

### POST /api/license/activate

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

注入 pro license key（[`server.ts`](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts) 只校验 `key.startsWith('anet-') && length >= 16`，**没真正的服务端校验**）。删除原有 license 行 + 写新 pro license（限额 50 agent / 10 network / 10000 task/day，过期 365 天）。

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
