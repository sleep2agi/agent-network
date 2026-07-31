# 角色 / Roles & 权限

::: tip 一句话
每个 network 都有 4 个成员角色：`owner` / `admin` / `member` / `viewer`。Server 根据当前用户在目标 network 的 membership 判定权限；`utok_` 本身不固定某个 network 角色。
:::

## 4 个角色对照

| 角色 | 典型用例 | 简介 |
|---|---|---|
| **owner** | network 创建者 / 唯一最高权 | 能改成员 + 能删 network + 全部 admin 操作 |
| **admin** | 团队负责人 / 受信运维 | 能邀请和移除成员；hub 级管理接口需要单独的系统 admin 身份 |
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
| 看 `/api/audit-log` 全部 row | 仅 `users.role='admin'` | | | |
| `/api/users` 看用户列表 | 仅 `users.role='admin'`（同上系统级） | | | |
| `/api/server-logs` 调试 console | 仅 `users.role='admin'` | | | |
| `anet hub admin reset-user`（重置任意用户密码） | 仅 hub 本机命令行调用，与角色无关（owner 本机权限即可） | | | |

> ※ `anet node start / stop / delete` 由本机 `.anet/nodes/<alias>/` 配置发起，不做 network membership 检查（stop/delete 仍会向 Hub 报告离线或清理身份）。谁持有该本地配置，谁就能执行；`anet node create` 则需要 non-viewer membership 才能取得节点凭证。

> `send_task` / `cancel_task` / `reassign_task` 对 owner/admin/member 开放，viewer 被拒绝；取消和转移任务没有“仅限自己创建的任务”规则。重命名和删除 network 仅 owner 可执行。

---

## 分配角色

邀请时可以直接指定 `admin`、`member` 或 `viewer`：

```bash
anet network invite --role admin --uses 1
anet network invite --role member --uses 5
anet network invite --role viewer --uses 1
```

修改已有成员的角色使用 `PUT /api/networks/:id/members/:user_id`，且仅 owner 可调用。`owner` 不能通过邀请或该接口授予；创建 network 的用户自动成为 owner。

---

## hub 全局 admin（特殊）

::: warning 这跟 network admin 不一样
network 的 4 个 role（owner/admin/member/viewer）绑定到具体 network。另有 `users.role='admin'` 的 **hub 全局 admin**，可调用用户列表、完整审计日志、server logs 等 hub 级接口；它**不会自动获得每个 network 的 admin 成员身份**。
:::

| 操作 | network admin | hub 全局 admin (`admin` user) |
|---|---|---|
| 调 `/api/audit-log` 看**自己的** row | ✅ | ✅ |
| 调 `/api/audit-log` 看**其他人** row | ❌（server 自动 `WHERE user_id = self` 过滤） | ✅ |
| `anet hub admin reset-user`（重置任意用户密码） | ❌ | ✅（仅 hub 本机调用） |
| 通过公开注册接口创建 user | ✅（受注册限速与密码规则约束） | ✅ |
| 直接列出所有 network | ❌（只看自己有 role 的） | ❌（同样按 membership 列表） |

---

## 角色信息存在哪

`utok_` 绑定用户身份；network 角色存于 `network_members`。请求进入具体 network 后，Server 再查询该用户的 membership。`ntok_` 另带固定的 `network_id`，供节点访问单一网络。

CLI 不需要你手工输入 role；登录后，Server 依据用户身份和目标 network 的 membership 做判定。

---

## 升降级一个成员的角色

::: info 当前操作入口
CLI 可以列成员；改角色和移除成员使用 REST（详见 [API — networks members](/api/rest#get-api-networks-id-members)）。
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

**Q：首次启动创建的 `admin` 账号是什么 role？**
A：first-run 创建时自动是 hub 全局 admin + default network 的 owner。

**Q：能不能让一个 user 只在某个 network 是 admin、在 hub 全局不是？**
A：能。把他设为该 network 的 `admin` 即可；系统级 `users.role` 不会随之改变。

**Q：viewer 真的什么都不能写吗，连派 task 都不行？**
A：对，连派 task 都不行。如果想"能看 + 偶尔派"，给 member。

---

## 下一步

- **CLI 操作 role**：[CLI 命令 — network 管理](/guide/cli)
- **Token 体系联动**：[Token 概念](/concepts/tokens) — 4 个 role 跟 utok_/ntok_ 关系
- **完整安全模型**：[安全设计](/concepts/security)
