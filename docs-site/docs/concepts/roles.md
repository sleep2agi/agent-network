# 角色 / Roles & 权限

::: tip 一句话
Agent Network 用 4 个角色：`owner` / `admin` / `member` / `viewer`。**你 utok_ 里带的角色决定你能调哪些 API**。RFC-001 已于 v0.8 落地之后，没有"超级 master 钥匙"，全部基于角色。
:::

## 4 个角色对照

| 角色 | 典型用例 | 简介 |
|---|---|---|
| **owner** | network 创建者 / 唯一最高权 | 能改成员 + 能删 network + 全部 admin 操作 |
| **admin** | 团队负责人 / 受信运维 | 能加减成员 + 能调 admin-only 端点 (`/api/audit-log`, `/api/users` 等) + 能改 hub 设置 |
| **member** | 普通团队工程师 | 能创建 / 启动 agent + 派 task + 看本网络数据 |
| **viewer** | 实习生 / 审计员 / 只读对接 | 只能看，不能写 |

---

## 完整权限矩阵

| 操作 | viewer | member | admin | owner |
|---|---|---|---|---|
| **读** | | | | |
| 看本网络任务 (`anet tasks`) | ✅ | ✅ | ✅ | ✅ |
| 看本网络 agent 列表 (`anet status`) | ✅ | ✅ | ✅ | ✅ |
| 看 messages / completions | ✅ | ✅ | ✅ | ✅ |
| 看 audit log | ❌ | ❌ | ✅ | ✅ |
| **agent 生命周期** | | | | |
| 创建 agent (`anet node create`) | ❌ | ✅ | ✅ | ✅ |
| 启动 / 停止 agent | ❌ | ✅（自己创建的） | ✅（任何） | ✅（任何） |
| 删除 agent | ❌ | ✅（自己创建的） | ✅（任何） | ✅（任何） |
| **任务** | | | | |
| 派任务 `send_task` | ❌ | ✅ | ✅ | ✅ |
| 取消任务 `cancel_task` | ❌ | ✅（自己派的） | ✅（任何） | ✅（任何） |
| 转移任务 `reassign_task` | ❌ | ❌ | ✅ | ✅ |
| **成员管理** | | | | |
| 邀请成员入网 (`anet network invite`) | ❌ | ❌ | ✅ | ✅ |
| 改成员 role | ❌ | ❌ | ✅（不能升到 owner） | ✅ |
| 移除成员 | ❌ | ❌ | ✅（不能移除 owner） | ✅ |
| **network** | | | | |
| 创建 network | 任何登录用户都能在 hub 全局建（创建者自动成 owner） | | | |
| 重命名 network | ❌ | ❌ | ✅ | ✅ |
| 删除 network | ❌ | ❌ | ❌ | ✅ |
| **hub 全局** | | | | |
| 看 `/api/audit-log` | ❌ | ❌ | ✅ | ✅ |
| 调 `/api/admin/wipe-db` 等危险操作 | ❌ | ❌ | ✅ | ✅ |
| `anet hub admin reset-user`（重置任意用户密码） | 仅 hub 本机命令行调用，与角色无关 | | | |

---

## 每个角色细讲

### viewer

**给谁**：实习生、审计员、想看不能动的人。

**能干什么**：
- 任何**读**接口（任务列表 / agent 状态 / messages / completions）
- 看 dashboard 主页面 / 浏览

**不能干什么**：
- ❌ 任何写操作（派 task / 启动 agent / 改 config）
- ❌ 看 audit log（属于 admin 才能看）

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
- 派任务 `send_task`
- 取消自己派的任务

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

**给谁**：团队负责人、受信运维、需要管成员 / 看审计日志的人。

**能干什么**：
- member 的全部
- 加减 network 成员（不能动 owner）
- 改成员 role（不能升到 owner）
- 改 / 删 / 启动停止任何 agent（包括别人创建的）
- 看 `/api/audit-log`
- 调 admin-only 端点（`/api/audit-log`, `/api/users` 等）

**不能干什么**：
- ❌ 删除 network 本身（只有 owner 能）
- ❌ 移除 owner / 把别人升到 owner

**怎么变成 admin**：
```bash
# owner 调
anet network invite --role admin --uses 1
# 或现有 member 升级
anet network member set <username> --role admin
```

---

### owner

**给谁**：network 创建者，全权最高，**每个 network 至少 1 个 owner**。

**能干什么**：
- admin 的全部
- 删除 network
- 把其他人升到 owner（多 owner 时谁都能动谁，建议谨慎）

**特殊保护**：
- ❌ 不能被 admin 改 role
- ❌ 不能被 admin 移除
- 如果 network 只剩一个 owner，**不能降级 / 删除自己**（避免无 owner 状态）

**怎么变成 owner**：
- 创建 network 时自动是 owner：`anet network create <name>`
- 或现有 owner 升你：`anet network member set <username> --role owner`

---

## hub 全局 admin（特殊）

::: warning 这跟 network admin 不一样
network 的 4 个 role（owner/admin/member/viewer）是**绑定到某个 network** 的。还有一个 **hub 全局 admin**（first-run 创建的 `admin` user）—— 这个 user **在所有 network 都自动是 admin**，并且能调 hub 级管理接口。
:::

| 操作 | network admin | hub 全局 admin (`admin` user) |
|---|---|---|
| 调 `/api/audit-log` | ✅ | ✅ |
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

```bash
# 列出当前 network 所有成员 + role
anet network member ls

# 把 bob 升成 admin（你必须是 admin/owner）
anet network member set bob --role admin

# 把 bob 降回 member
anet network member set bob --role member

# 移除 bob 出 network
anet network member rm bob
```

---

## FAQ

**Q：我 `anet login` 后是什么 role？**
A：看你登录的用户在当前 network 的 role。`anet whoami` 能看：
```
admin (admin)        ← user 名 + 当前 network 的 role
network: default
```

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
- ✅ 所有 hub ↔ dashboard 内部通信 = admin user 的 `utok_`（Dashboard 0.4.2 已切到 thin cookie-proxy）

这就是为啥要把 role 体系写清楚 —— 它是**唯一**的鉴权基础。

## 下一步

- **CLI 操作 role**：[CLI 命令 — network 管理](/guide/cli)（`anet network members ls / promote / demote`）
- **Token 体系联动**：[Token 概念](/concepts/tokens) — 4 个 role 跟 utok_/ntok_ 关系
- **完整安全模型**：[安全设计](/concepts/security)
- **升级 v0.7 → v0.8 怎么影响 role**：[升级指南](/guide/upgrade#v0-7-v0-8-升级注意-最新)
- **RFC-001 路线图**：[RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md)
