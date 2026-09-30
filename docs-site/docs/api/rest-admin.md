# REST API：管理端点

本页是 [REST API 参考](/api/rest) 的一部分：Token、网络成员、文件、节点改名、调试与 Legacy 端点。基础约定（地址、认证、错误格式）见[总览](/api/rest)。

## Token 管理端点

**需要用户令牌。** 节点令牌不能列出、签发或撤销令牌，返回 403 `user_token_required`。

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

每行 6 字段对照 [`auth.ts` `listTokens`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L418) `listTokens` SELECT：`token_id / name / scope / network_id / last_used_at / created_at`。`scope` 取值 `user` (utok\_) / `network` (ntok\_) / `full` (legacy atok\_)；`network_id` 仅 `network` / `full` scope 有值。按 `created_at DESC` 排序。明文 Token 字段**不返回**（只能在 POST 创建时拿一次）。

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
| 404 | `token not found` | `token_id` 不存在或不属于当前 user（[`auth.ts` `revokeToken`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L470) `DELETE ... WHERE token_id=?1 AND user_id=?2` 受影响行 0） |

写 audit log `action='token_revoked'`。撤销后该 token 的下一次请求拿 401 `invalid token`。

---

## 网络成员端点

**需要用户令牌。** 节点令牌不能列出、邀请、加入、改角色或移除成员，返回 403 `user_token_required`。

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
| `agent_access` | enum | | `granted`(默认,只看授权的 Agent)/ `all`(完全信任的成员);见[用户与 Agent 权限端点](#用户与-agent-权限端点) |

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

## 用户与 Agent 权限端点

**需要用户令牌。** 节点令牌调用这些接口返回 403 `user_token_required`。

多用户账号:Hub 管理员(或网络 owner / admin)建号,新成员**默认看不到任何 Agent**,在「可访问的 Agent」里逐个授权。人与人之间的私信不受影响。

**判定规则**(`server/src/agent-access.ts`):网络里 `role` 为 `member` / `viewer`、`agent_access` 不是 `all`、且不是 Hub 管理员的用户是**受限成员**。受限成员:

- 只看得到授权给他的 Agent(`/api/status`、`/api/nodes`、MCP `get_all_status` / `get_session_status`、需求看板的人员选择器);
- 只能给 `can_message=true` 的授权 Agent 发任务 / 消息,发件人固定为自己的用户名;
- 任务、inbox、task_events 只看得到**自己与授权 Agent 之间**的往来,看不到别人(包括 owner)和同一个 Agent 的对话;
- 不能订阅 Agent 的 SSE 频道(即使已授权——那个频道推的是所有人发给它的任务原文),网络观察流只收到自己是一端的路由事件;
- 不能持有网络令牌(`ntok_` / 邀请码令牌):签发被拒,升级前已签发的在他变成受限后解析失败;
- 文件只能下载自己上传的、或对方(授权 Agent / 私信发件人)发给他的附件;也不能把看不见的 `file_id` 当附件转给 Agent;
- 其余面向 Agent 的端点(节点配置 / 日志 / 文件 / 规则 / 改名 / 排程 / 创建节点 / 广播 / 统计)对受限网络 **fail-closed**:整网不返回、写入 403;没列在白名单里的 MCP 工具返回 `agent_access_restricted`。

- **授权 ≠ 管理**:即使授权了某个 Agent,受限成员也不能读写它的规则文件 / 技能 / 项目文件 / 运行日志,不能改配置、改名、启停 —— 授权的含义是「能看见、能对话」;
- 排程是建它的人的委托:建的人后来变成受限成员且没被授权给目标 Agent 发任务时,排程不再派发(运行记录 `error_code=creator_access_revoked`);
- 用户名与某个 Agent 的 alias 撞名(Agent 在他入网之后才注册这个 alias)时,他在这个网络里的用户名频道与「自己的往来」一律关闭,因为「发给他」和「发给那个 Agent」无法区分。

owner / admin 角色与 Hub 管理员不受影响。**升级前已存在的成员行** `agent_access` 默认为 `all`,可见范围不因升级而变;此后新加入的 member / viewer(管理员建号、`POST /members`、邀请码)默认 `granted`。

⚠️ 授权一个 Agent,等于信任这个人使用该 Agent 能做到的事(Agent 自己的网络令牌能读网络里的文件、调用工具)。

### POST /api/admin/users

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts)(`adminCreateUser`)

建一个用户。规则与 `/api/auth/register` 相同(用户名 2–50 位、密码 ≥ 8 且不是常见密码、自动建个人网络),但**不返回令牌**——用户自己登录才拿令牌。

- Hub 管理员:可以不带 `network_id`;
- 某网络的 owner / admin:必须带自己管理的 `network_id`(新用户进这个网络);网络 admin 不能建 `role=admin` 的成员。

```bash
curl -X POST http://localhost:9200/api/admin/users \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"<至少 8 位>","display_name":"Alice","network_id":"net_xxx","role":"member"}'
```

**响应**:

```json
{ "ok": true, "user": { "user_id": "u_abc", "username": "alice", "role": "user" }, "personal_network_id": "net_own", "membership": { "network_id": "net_xxx", "role": "member", "agent_access": "granted" } }
```

| 状态 | `error` | 触发 |
|------|---------|------|
| 400 | `username already taken` / `password must be at least 8 characters` / `password is too common` | register() 的规则 |
| 403 | `admin required` / `owner/admin required` | 调用者无权 |
| 404 | `network_not_found` | `network_id` 不存在 |
| 409 | `username_collides_with_agent_alias` | 用户名与该网络某个 Agent 的 alias 相同(用户频道按用户名寻址,撞名会串流量);账号不会落库 |

写 audit log `admin_user_created`(被拒时 `admin_user_create_denied`)。

### GET /api/admin/users

Hub 管理员专用。返回全部用户,每人带 `networks: [{network_id, network_name, role, agent_access}]`,不含密码哈希。

### GET / PUT /api/networks/:id/members/:user_id/agent-grants

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/agent-access.ts)(`replaceAgentGrants`)

读 / 整体替换某成员可访问的 Agent。owner / admin / Hub 管理员可调;网络 admin 不能改 owner / 其他 admin。只接受用户令牌。

```bash
curl -X PUT http://localhost:9200/api/networks/net_xxx/members/u_abc/agent-grants \
  -H "Authorization: Bearer utok_xxx" -H "Content-Type: application/json" \
  -d '{"grants":[{"node_id":"node_x"},{"node_id":"node_y","can_message":false}]}'
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `grants` | array | 每项 `{node_id}` 或 `{alias}`(只给没有 node_id 的旧会话)+ 可选 `can_message`(默认 `true`)。也接受 `node_id` 字符串数组。整体替换 |
| `agent_access` | `all` \| `granted` | 可选。`all` = 解除限制(旧语义),`granted` = 只看授权的 |
| `group_grants` | array | 可选。授权给 [Agent 分组](#agent-groups):每项 `{group_id}` + 可选 `can_message`,也接受 `group_id` 字符串数组。**不传 = 保持原样**(旧客户端只发 `grants`,不会清掉组授权);传了就整体替换 |

任何一项不是本网络的 Agent → 400 `agent_not_in_network`、不是本网络的组 → 400 `group_not_in_network`,整批不写。成功后写 audit log `member_agent_grants_changed`,并断开该成员已连着的观察流 / 用户流让它按新权限重连。

可见 = 直接授权 ∪ 被授权的组此刻的成员;可对话取并集(任一来源给了就算)。

**响应**:`{ ok, network_id, user_id, agent_access, restricted, grants: [{node_id, alias, can_message}], group_grants: [{group_id, name, can_message}] }`(GET 另带 `role`)。

### Agent 分组 {#agent-groups}

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/agent-access.ts)(`createAgentGroup` / `replaceAgentGroupMembers` / `deleteAgentGroup`)· 设计见 RFC-038 §8

管理员自由定义的一组 Agent。授权给组后,**组里以后新加的 Agent 自动可见**(每次请求现算)。owner / admin / Hub 管理员可调,只接受用户令牌;普通成员与受限成员 403(他们只看得到最终能访问的 Agent)。

| 方法 · 路径 | 说明 |
|---|---|
| `GET /api/networks/:id/agent-groups` | `{ groups: [{group_id, name, description, node_ids, member_count, granted_user_count, …}] }` |
| `POST /api/networks/:id/agent-groups` | `{name, description?, node_ids?}` 建组;同网络重名 409 `group_name_taken` |
| `PATCH /api/networks/:id/agent-groups/:group_id` | `{name?, description?}` |
| `PUT /api/networks/:id/agent-groups/:group_id/members` | `{node_ids}` 整体替换组成员;响应带 `added` / `removed` |
| `DELETE /api/networks/:id/agent-groups/:group_id` | 删组连同组上的授权;响应 `affected_user_ids` |

节点不是本网络的 → 400 `agent_not_in_network`,整批不写。审计:`agent_group_created` / `agent_group_renamed` / `agent_group_members_changed`(只记 diff)/ `agent_group_deleted`,都带 `network_id`。组成员或组本身变化时,断开该组上有授权的成员的实时流,让其按新权限重连。`GET /api/networks/:id/members` 每个成员另带 `agent_group_count`。

### GET /api/networks/:id/humans

任何成员(含受限成员)都能调:网络里的人类成员通讯录,只有 `user_id` / `username` / `display_name`。给受限成员选私信对象用(私信走 MCP `send_desktop_message`)。

用户令牌另得每人的在线状态:`online`(此刻有没有活着的 `/events/users/me` 用户流,按人算、不分网络)和 `last_seen_at`(ISO,连上 / 心跳 / 断开时刷新;只在 Hub 内存里,Hub 重启后未再连过的人为 `null`,表示未知)。节点令牌拿到的仍只有上面三个身份字段。

某人第一条用户流连上、最后一条断开时,Hub 向他所在每个网络里其他连着用户流的成员推 `{"type":"member_presence","member_user_id","online","last_seen_at"}`(事件里的 `user_id` 是收件人自己)。旧客户端忽略未知事件类型。

### POST /api/dm · GET /api/dm · GET /api/dm/threads {#human-dm}

人与人私信(同一网络里的两个用户;受限成员也可以),只接受用户令牌。

- `POST /api/dm` `{network_id?, to_user_id | to_username, message, attachments?, client_request_id?}` —— 写进对方的 user_inbox(`kind=human_dm`),经 `/events/users/me` 推送;发信人 `sender_user_id` 由 Hub 按令牌写入,请求体里的 `from` 一律忽略。同一个 `client_request_id` 重试不产生第二条。对方不存在与不在本网络同为 404 `dm_target_not_in_network`。受限成员附带看不见的文件 → 403 `attachment_not_accessible`；附带一个自己看不见的私信文件（`purpose=dm` 上传、自己既不是上传者也不在带着它的私信里）同样 403。私信的附件先用 `POST /api/upload?purpose=dm` 上传。
- `GET /api/dm?network_id=&with=<user_id>[&limit&before]` —— 我和这个人的双向记录,新的在前,每条带 `direction: in | out`。
- `GET /api/dm/threads?network_id=` —— 每个对方一行:`{other_user_id, last_at, unread}`。

已读沿用 `POST /api/messages/ack`(私信就是收件人 user_inbox 里的行)。

`GET /api/networks/:id/members` 的每一项另带 `agent_access`(生效值)与 `agent_grant_count`;`POST /api/networks/:id/members` 接受可选 `agent_access`(缺省 `granted`);`GET /api/auth/me` 的 `networks[]` 另带 `agent_access`,客户端据此显示「还没有被分配任何 Agent,请联系管理员」。

## 文件端点

附件（图片等）的上传 / 下载，支撑 Dashboard 发图片、commhub 附件、codex-sdk 图片输入等功能。两个端点都需 `Authorization: Bearer <token>`。

### POST /api/upload

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/server.ts)

上传一个文件，返回可下载的 `url`。

- 请求：`multipart/form-data`，必须带一个 `file` 字段，且必须带 `Content-Length` 头。
- 大小上限 **12 MiB**（`MAX_UPLOAD_BYTES`），两段校验：先按 `Content-Length` fail-fast，再按解析后的实际大小复核。
- 限流：**60 次/小时**（按 token id 计，无 token 时按 IP），超限返回 `429 rate_limited`（带 `X-RateLimit-*` 头）。
- `?purpose=dm`（可选）：这个文件是为一条人与人私信传的，它就成了**私信文件**，只有上传者、带着它的私信的收发双方和 Hub 管理员能下载，同网络的其他成员和节点令牌都拿到 `404 not_found`。不带 `purpose` 时行为不变；文件先在别处用过（例如 agent 会话）再转进私信，也不会变成私信文件。其它值返回 `400 bad_purpose`。见 [人与人私信](#human-dm)。

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

> RFC-010 active-rename 两阶段事务的协调端点，由 `anet node rename` 内部调用（流程见 [node-lifecycle §7](https://github.com/sleep2agi/agent-network/blob/main/docs/node-lifecycle.md)）。一般不直接手调，列在此处供集成方参考。三个端点都要 `Authorization: Bearer`（缺 token 401 / 无效 token 401）。节点令牌只能改自己：绑定的网络里，旧 alias 就是这个令牌代表的节点。改别的节点或别的网络**需要用户令牌**，否则 403 `user_token_required`。

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
