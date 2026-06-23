# 角色 / Roles & 权限

::: tip 一句话
Agent Network 用 4 个角色：`owner` / `admin` / `member` / `viewer`。**你 utok_ 里带的角色决定你能调哪些 API**。RFC-001 已于 v0.8 落地之后，没有"超级 master 钥匙"，全部基于角色。
:::

## 4 个角色对照

| 角色 | 典型用例 | 简介 |
|---|---|---|
| **owner** | network 创建者 / 唯一最高权 | 能改成员 + 能删 network + 全部 admin 操作 |
| **admin** | 团队负责人 / 受信运维 | 能加减成员 + 能改 hub 设置（注：`/api/audit-log` / `/api/users` 等 admin-only 端点是**系统级** `users.role='admin'` 限定，**不是** network admin；详见下方 [hub 全局 admin 特殊](#hub-全局-admin-特殊)） |
| **member** | 普通团队工程师 | 能创建 agent + 派 task + 看本网络数据（`anet node start/stop/delete` 是本地操作，不受角色门控 —— 见下方注 ※）|
| **viewer** | 实习生 / 审计员 / 只读对接 | 只能看，不能写 |

---

## 完整权限矩阵

| 操作 | viewer | member | admin | owner |
|---|---|---|---|---|
| **读** | | | | |
| 看本网络任务 (`anet tasks`) | ✅ | ✅ | ✅ | ✅ |
| 看本网络 agent 列表 (`anet status`) | ✅ | ✅ | ✅ | ✅ |
| 看 messages / completions | ✅ | ✅ | ✅ | ✅ |
| 看 audit log（只自己的 row） | ✅ | ✅ | ✅ | ✅ |
| 看 audit log（其他人的 row） | 仅 **系统级** `users.role='admin'`（**不是** network admin） | | | |
| **agent 生命周期** | | | | |
| 创建 agent (`anet node create`) | ❌ | ✅ | ✅ | ✅ |
| 启动 / 停止 / 删除 agent (`anet node start/stop/delete`) | 不受网络角色门控 —— 见下方注 ※ | | | |
| **任务** | | | | |
| 派任务 `send_task` | ❌ | ✅ | ✅ | ✅ |
| 取消任务 `cancel_task` | ❌ | ✅ | ✅ | ✅ |
| 转移任务 `reassign_task` | ❌ | ✅ | ✅ | ✅ |
| **成员管理** | | | | |
| 邀请成员入网 (`anet network invite`) | ❌ | ❌ | ✅ | ✅ |
| 改成员 role | ❌ | ❌ | ❌ | ✅ |
| 移除成员 | ❌ | ❌ | ✅（不能移除 owner） | ✅ |
| **network** | | | | |
| 创建 network | 任何登录用户都能在 hub 全局建（创建者自动成 owner） | | | |
| 重命名 network | ❌ | ❌ | ❌ | ✅ |
| 删除 network | ❌ | ❌ | ❌ | ✅ |
| **hub 全局**（系统级 `users.role` 门控，**不是** 网络角色） | | | | |
| 看 `/api/audit-log` 自己的 row | ✅ | ✅ | ✅ | ✅ |
| 看 `/api/audit-log` 全部 row | 仅 `users.role='admin'`（verify [`server/src/index.ts:1086-1089`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L1086)） | | | |
| `/api/users` 看用户列表 | 仅 `users.role='admin'`（同上系统级） | | | |
| `/api/server-logs` 调试 console | 仅 `users.role='admin'` | | | |
| 调 `/api/admin/wipe-db` 等危险操作 | 仅 `users.role='admin'` | | | |
| `anet hub admin reset-user`（重置任意用户密码） | 仅 hub 本机命令行调用，与角色无关（owner 本机权限即可） | | | |

> ※ `anet node start / stop / delete` 是**纯本地 CLI 操作** —— 直接读写本机 `.anet/nodes/<alias>/` 目录，`startCommand` / `deleteCommand` 里**没有任何网络角色 / owner / per-creator 检查**。谁的机器上有那份 node config，谁就能 start/stop/delete 它，跟该 user 在网络里是什么 role 无关。受网络角色门控的只有 `anet node create`（要向 hub 换 `ntok_`，`canWrite` 挡 viewer）。

> `send_task` / `cancel_task` / `reassign_task` 三个 MCP 写工具**只过一道 [`canWrite` 门](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L24)**（`role !== "viewer"` —— owner/admin/member 都放行），**没有 per-task ownership 检查** —— member 可以 cancel / reassign 网络里**任何**任务，不限「自己派的」。重命名 network 是 owner-only（[`auth.ts:218 renameNetwork`](https://github.com/sleep2agi/agent-network/blob/main/server/src/auth.ts#L218) `if (net.owner_id !== userId)`），跟「删除 network」一样，admin 不能改名。

---

## 每个角色细讲

### viewer

**给谁**：实习生、审计员、想看不能动的人。

**能干什么**：
- 任何**读**接口（任务列表 / agent 状态 / messages / completions）
- 看 dashboard 主页面 / 浏览

**不能干什么**：
- ❌ 任何**网络级写操作**（派 task / `cancel_task` / `reassign_task` / `anet node create` —— 都过 `canWrite` 门挡 viewer）
- ❌ 看其他人的 `/api/audit-log` row（系统级 `users.role='admin'` 才有跨用户访问；viewer **能看自己的** audit log row）

> 注：`anet node start / stop / delete` 是**纯本地 CLI 操作**，不受网络角色门控（见上方权限矩阵注 ※）—— viewer 在自己机器上仍能 start/stop/delete 已有的 node。受网络角色门控的只有 `anet node create`（要向 hub 换 `ntok_`）。

**怎么变成 viewer**：
```bash
# admin / owner 邀请时指定
anet network invite --role viewer --uses 1
```

---

### member

**给谁**：团队里参与生产的工程师，独立干活。

**能干什么**：
- viewer 的全部
- 创建自己的 agent (`anet node create`)
- 启动 / 停止 / 删自己的 agent
- 派 / 取消 / 转移任务 `send_task` / `cancel_task` / `reassign_task`（都只过 `canWrite` 门，所以 member 能取消 / 转移网络里**任何**任务，不限「自己派的」）

**不能干什么**：
- ❌ 改别人的 agent
- ❌ 加减 network 成员
- ❌ admin 接口

**怎么变成 member**：
```bash
anet network invite --role member --uses 5      # 默认就是 member
anet network join <code>                         # 用邀请码加入
```

---

### admin

**给谁**：团队负责人、受信运维、需要管成员的人。

**能干什么**：
- member 的全部
- 邀请新成员入网 + 移除非 owner 成员（invite [`index.ts:695`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L695) / remove [`index.ts:681`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L681)：`["owner","admin"]` 门控）

> 注：`anet node start / stop / delete` / 改 config **不是 admin 的网络角色特权** —— 它们是纯本地 CLI 操作（见上方权限矩阵注 ※），谁的机器上有那份 node config 谁就能管，跟网络角色无关。admin **不能**远程 start/stop 别人机器上的 agent。

**不能干什么**：
- ❌ **改成员 role** —— `PUT /api/networks/:id/members/:user_id` 是 **owner only**（[`index.ts:674`](https://github.com/sleep2agi/agent-network/blob/main/server/src/index.ts#L674) `if (callerRole !== "owner")` 直接 403）；admin 只能 invite / remove，不能改已有成员的 role
- ❌ 删除 network 本身（只有 owner 能）
- ❌ 移除 owner / 把别人升到 owner
- ❌ 看其他人的 `/api/audit-log` row —— admin-only 端点是**系统级** `users.role='admin'` 限定（**不是** network admin）；network admin 跟 viewer / member 一样只能看自己的 audit log row

**怎么变成 admin**：
```bash
# 方式 1：owner 创建邀请码（推荐）—— 对方用邀请码加入直接拿到 admin role
anet network invite --role admin --uses 1

# 方式 2：现有 member 升级 —— 走 REST（CLI promote 子命令 v0.10.15 仍未提供，排到 v0.11+ / 未排期）
curl -X PUT http://localhost:9200/api/networks/<net_id>/members/<user_id> \
  -H "Authorization: Bearer <owner_utok>" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'
# 详见 [API — PUT members](/api/rest#put-api-networks-id-members-user-id)
```

---

### owner

**给谁**：network 创建者，全权最高，**每个 network 至少 1 个 owner**。

**能干什么**：
- admin 的全部
- 删除 network
- 改其他成员的 role（`PUT /api/networks/:id/members/:user` 要求 caller 是 owner —— admin 改不了成员 role）

**特殊保护**：
- ❌ 不能被 admin 改 role
- ❌ 不能被 admin 移除
- 如果 network 只剩一个 owner，**不能降级 / 删除自己**（避免无 owner 状态）
- ⚠ owner 角色**不能授予**给别人（`updateMemberRole` / `createInvite` 都显式拒 `owner`，详见下方「怎么变成 owner」）—— 所以「多 owner」不是正常路径

**怎么变成 owner**：
- 创建 network 时自动是 owner：`anet network create <name>`
- ⚠ **不能通过 REST `PUT /members/:user_id` promote 到 owner** —— server 拒绝（返回 `cannot assign owner role` 400，详见 [API — PUT members 4xx](/api/rest#put-api-networks-id-members-user-id)）。owner 角色只能通过创建 network 获得

---

## hub 全局 admin（特殊）

::: warning 这跟 network admin 不一样
network 的 4 个 role（owner/admin/member/viewer）是**绑定到某个 network** 的。还有一个 **hub 全局 admin**（first-run 创建的 `admin` user）—— 这个 user **在所有 network 都自动是 admin**，并且能调 hub 级管理接口。
:::

| 操作 | network admin | hub 全局 admin (`admin` user) |
|---|---|---|
| 调 `/api/audit-log` 看**自己的** row | ✅ | ✅ |
| 调 `/api/audit-log` 看**其他人** row | ❌（server 自动 `WHERE user_id = self` 过滤） | ✅（看全部，index.ts:1086-1089） |
| `anet hub admin reset-user`（重置任意用户密码） | ❌ | ✅（仅 hub 本机调用） |
| 创建新 user | ❌ | ✅（仅 hub 全局 admin） |
| 看 hub 所有 network | ❌（只看自己有 role 的） | ✅ |

---

## 角色信息存在哪

每个 utok_ 都绑了 `(user_id, network_id, role)` 三元组（在 `api_tokens` 表的 `scope` 字段）。

```ts
// server 端 auth 解析
const ctx = await resolveToken(req.headers.authorization);
// ctx = { user_id, network_id, role: 'admin' | 'member' | ... }

// endpoint handler
if (!isAdminLike(ctx.role)) return new Response("403", { status: 403 });
```

CLI 不需要你输任何 role 信息 —— `anet login` 时 hub 把 role 写进 token，CLI 自动带着调接口。

---

## 升降级一个成员的角色

::: warning v0.10.15 stable 仍没有 `promote` / `demote` CLI 子命令
v0.9.x / v0.10.x 整条 stable 线都未触碰 member role 管理（每个 release 的具体改动见 [changelog](/changelog)）；完整 CLI 入口排到 v0.11+ / 未排期。目前列成员可以走 CLI，**改角色 / 移除成员一律走 REST**（详见 [API — networks members](/api/rest#get-api-networks-id-members)）。
:::

```bash
# 1. 列出当前 network 所有成员 + role（CLI，已实装）
anet network members

# 2. 改 bob 的角色为 admin（REST，owner only）
#    role 字段不能传 'owner' —— 见 PUT members 4xx 表
#    注：anet whoami / anet network ls 输出的 network_id 截断到 12 字符，REST 调用需完整 id；
#       从 config.json 直接读才是完整 id
NET=$(jq -r .network_id ~/.anet/config.json)
UTOK=$(jq -r .token ~/.anet/config.json)
curl -X PUT "http://localhost:9200/api/networks/$NET/members/u_bob_xxx" \
  -H "Authorization: Bearer $UTOK" \
  -H "Content-Type: application/json" \
  -d '{"role": "admin"}'

# 3. 移除 bob（REST，owner/admin）
curl -X DELETE "http://localhost:9200/api/networks/$NET/members/u_bob_xxx" \
  -H "Authorization: Bearer $UTOK"
```

完整 endpoint 文档：[PUT members](/api/rest#put-api-networks-id-members-user-id) / [DELETE members](/api/rest#delete-api-networks-id-members-user-id)。

---

## FAQ

**Q：我 `anet login` 后是什么 role？**
A：`anet whoami` 输出的 `Role:` 是**系统级 role**（`users.role` —— `admin` 或 `user`），**不是 per-network role**（verify [`agent-network/bin/cli.ts whoamiCommand`](https://github.com/sleep2agi/agent-network/blob/main/agent-network/bin/cli.ts)）：
```
  User: admin (u_xxxxxx)
  Role: admin              ← users.role 系统级（'admin' / 'user'），不是 network role
  Hub:  http://127.0.0.1:9200

  Networks:
    default (net_xxxxxxxxx) ← current
    my-team (net_yyyyyyyyy)
```

要查**当前 network 内**你是 owner/admin/member/viewer 哪一个，跑 `anet network members` 看自己那行（绑定到 `network_members` 表，跟 `users.role` 系统级是两套独立 state）。

**Q：能跨 network 用不同 role 吗？**
A：能。同一个 user 在 networkA 是 admin，在 networkB 是 viewer，完全 OK。每个 network 独立 role。

**Q：默认 `admin / anethub` 账号是什么 role？**
A：first-run 创建时自动是 hub 全局 admin + default network 的 owner。

**Q：能不能让一个 user 只在某个 network 是 admin、在 hub 全局不是？**
A：能。把他设为 network owner 即可（不给 hub 全局 admin）。

**Q：viewer 真的什么都不能写吗，连派 task 都不行？**
A：对，连派 task 都不行。如果想"能看 + 偶尔派"，给 member。

---

## 与 RFC-001 的关系

[RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) 已于 **v0.8.0 落地**：`COMMHUB_AUTH_TOKEN` 进入软废弃（v1.0 完全移除），**hub 鉴权完全基于本文档的 4 个 role**：
- ✅ 没有 "master 钥匙" bypass role 检查
- ✅ 所有 admin 操作 = admin role `utok_` + role check
- ✅ 所有 hub ↔ dashboard 内部通信 = admin user 的 `utok_`（Dashboard 已是 thin cookie-proxy）

这就是为啥要把 role 体系写清楚 —— 它是**唯一**的鉴权基础。

## 下一步

- **CLI 操作 role**：[CLI 命令 — network 管理](/guide/cli)（`anet network members` 列成员；改角色走 REST [PUT members](/api/rest#put-api-networks-id-members-user-id)，CLI promote/demote 排到 v0.11+ / 未排期）
- **Token 体系联动**：[Token 概念](/concepts/tokens) — 4 个 role 跟 utok_/ntok_ 关系
- **完整安全模型**：[安全设计](/concepts/security)
- **升级 v0.7 → v0.8 怎么影响 role**：[升级指南](/guide/upgrade#v0-7-v0-8-升级注意-最新)
- **RFC-001 路线图**：[RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md)
