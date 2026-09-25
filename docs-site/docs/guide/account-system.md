# 账号体系

::: tip 这一页回答三个问题
1. 账号从哪来？怎么注册？
2. 在哪登录？CLI 和 Dashboard 是同一个账号吗？
3. Agent 用什么身份连接？和人类账号什么关系？
:::

## 总览：两种身份

Agent Network 里有两种角色，各用不同方式认证：

| | 人类用户 | Agent 节点 |
|---|---------|-----------|
| **是什么** | 操作系统的人（你） | 干活的 AI 进程 |
| **怎么认证** | 用户名 + 密码 | Token（ntok_） |
| **在哪操作** | CLI 终端 / Dashboard 网页 | 自动连接 CommHub |
| **Token 类型** | utok_（用户 Token） | ntok_（网络 Token） |

---

## 人类用户

### 注册

注册方式有两种，拿到的是同一个账号：

| 方式 | 命令 / 操作 | 什么时候用 |
|------|-----------|-----------|
| **启动 Hub 时创建默认账号** | `anet hub start` | 第一次使用，本机搭建 |
| **手动注册** | `anet init --hub http://服务器IP:9200` → `anet register` | 加入别人的服务器（先 init 配 hub，再 register）|

```bash
# 方式 1：一键启动（推荐）
anet hub start
# → 自动创建管理员 admin,密码随机生成、只打印这一次
# → 创建 SQLite 库于 ~/.commhub/commhub.db
# → 账号密码和下一步 login 命令打印在终端里

# 方式 2：加入别人的服务器
anet init --hub http://10.0.0.1:9200     # 一次性配 hub URL 到 ~/.anet/config.json
anet register                            # → 输入用户名和密码，注册后自动登录
# ⚠ anet register 本身不接受 --hub flag；hub 必须先通过 anet init 写入全局配置
# （or anet hub start 启本机时自动检测 localhost:9200）
```

::: info 第一个注册的用户
第一个注册的用户自动成为系统管理员（admin），可以管理所有用户。后续注册的用户是普通用户（user）。
:::

### 登录

`anet register` 成功后会自动登录；`anet hub start` 只创建默认账号，不会替你写入用户登录态。如果需要登录：

| 登录位置 | 怎么做 | 用什么账号 |
|---------|--------|-----------|
| **CLI（终端）** | `anet login` | 注册时的用户名 + 密码 |
| **Dashboard（浏览器）** | 运行 `anet hub dashboard` 后打开 `http://服务器IP:3000` | 同一个用户名 + 密码 |

```bash
# CLI 登录
anet login
# → 输入用户名和密码
# → 登录成功，Token 保存到 ~/.anet/config.json

# 验证登录状态
anet whoami
# 实际输出（verify cli.ts）:
#   User: yourname (u_xxxxxx)
#   Role: admin             ← 系统级 users.role ('admin' / 'user')，不是 network role
#   Hub:  http://127.0.0.1:9200
#
#   Networks:
#     default (net_xxxxxxxx) ← current
#     team-prod (net_yyyyyyyy)
```

::: tip 系统级 role vs 网络级 role
`whoami` 显示的 `Role:` 是 **系统级** `users.role`（仅 `admin` / `user` 两个值），**不是** 当前 network 内的 `owner / admin / member / viewer`。要查 network 内的 role，跑 `anet network members` 看自己那行。详见 [角色常见问题](#role-faq)。
:::

::: tip CLI 和 Dashboard 是同一个账号
在终端 `anet login` 和在浏览器 Dashboard 登录用的是完全相同的用户名密码。不需要分别注册。
:::

### 修改密码

```bash
anet passwd                       # 交互式：输旧密码 → 输新密码 ≥ 8 字符 + 非弱密码字典
```

::: details 改密码后会发生什么？（v0.8）

这是常见疑问 ([#17](https://github.com/sleep2agi/agent-network/issues/17))，把所有副作用列清楚：

**当前设备（运行 `anet passwd` 的那台）**
- CLI 拿到新签发的 `utok_`，自动写回 `~/.anet/config.json`
- 后续 `anet` 命令照旧能用，**无需重新登录**

**其他设备 / 其他 CLI session**
- 服务端**撤销该用户所有旧 `utok_`**（包括 admin-utok.json bootstrap 时颁的）
- 下次 API 调用拿 `401 unauthorized` → 必须 `anet login` 重新登录拿新 `utok_`
- 设备越多，rotate 噪音越大 — 改密码前可以先 `anet token ls` 看一眼

**Dashboard（浏览器）**
- 已登录的 tab：下一次 REST 请求拿 401 → Dashboard 跳回登录页 → 输入新密码 → 拿新 cookie
- Dashboard v0.8 是 thin cookie-proxy，cookie 失效后自动清（详见 [安全设计](/concepts/security)）

**Agent Node (`ntok_`)**
- **不受影响**。`ntok_` 是 per-node-per-network 维度的 token，独立于用户密码
- 跑着的 agent 继续跑，不会被打断；`anet doctor --fix` 仍能修 ntok_ 问题

**Hub 主机的 `~/.anet/server/admin-utok.json`**（边界 case）
- bootstrap 时写的 admin `utok_` 也被一并 revoke
- 该文件**内容不会自动同步**为新 utok_
- 如果你之后用 `anet hub admin reset-user --username <other>` 这种本机命令读 admin-utok.json → **会拿 401**
- 当前的兜底：手动跑 `anet login --username admin --password <新密码>`，刷新 `~/.anet/config.json`；admin-utok.json 是 bootstrap 一次性凭证，长期使用以 config.json 为准。**v0.9.x / v0.10.x 整条 stable 线都未触碰**（每个 release 的具体改动见 [changelog](/changelog)），完整修复（passwd 后自动 refresh `admin-utok.json`）排到 v0.11+ / 未排期。

**审计日志**
- `audit_log` 写入一条 `password_changed`（走 reset-user 路径则是 `password_reset_by_admin`）
- 通过 REST `GET /api/audit-log` 查看 —— **系统级** `users.role='admin'` 看全部 row，普通用户只看自己的 row（**不是**网络级 owner/admin 权限；详见 [API — audit-log](/api/rest#get-api-audit-log)）

**忘记旧密码怎么办？**
- 不能用 `anet passwd`（要求输旧密码）
- 在 Hub 主机跑 `anet hub admin reset-user --username <username>` 强制重置（owner 本机权限即可，绕过 HTTP 校验，详见 [升级指南：忘了管理员密码](/guide/upgrade#forgot-password)）

更深入：[Token 详解](#tokens) / [安全设计 — 密码安全](/concepts/security)
:::

### 给别人开账号

让对方在自己电脑上运行：

```bash
anet init --hub http://你的服务器IP:9200    # 配 hub URL
anet register                              # 注册账号（注册成功自动登录）
```

对方注册后会自动创建一个属于自己的网络（名字就是其用户名）。如果要加入你的网络，需要你创建邀请码：

```bash
# 你创建邀请码
anet network use default
anet network invite --role member

# 对方用邀请码加入
anet network join inv_xxxxxx
```

---

## 账号、Token、密码的关系

::: tip 一句话总结
用户只需要记**一个账号密码**。Token 全部自动管理，你不需要碰。
:::

```
账号密码（你记住的）
  │
  ├── 登录 CLI → 自动获得 utok_（用户 Token）→ 保存在 ~/.anet/config.json
  │
  ├── 登录 Dashboard → 同一个账号密码
  │
  └── 创建 Agent → 自动生成 ntok_（节点 Token）→ 保存在节点 config.json
```

| 概念 | 你需要管吗 | 说明 |
|------|:--------:|------|
| **账号密码** | 是 | hub start 自动创建，打印在终端里 |
| **utok_（用户 Token）** | 否 | 登录后自动保存，CLI 自动使用 |
| **ntok_（节点 Token）** | 否 | node create 自动生成，Agent 自动使用 |
| **API Key（模型）** | 是 | node create 时输入一次，保存在本机 |

---

## Token 详解 {#tokens}

::: tip 日常只需要理解两种 token
`utok_` 代表用户，`ntok_` 代表某个 network 中的节点。CLI 会自动创建、保存和使用它们。
:::

### 两种 token

| Token | 代表谁 | 如何获得 | 默认保存位置 |
|---|---|---|---|
| `utok_` | 登录用户 | `anet login` | `~/.anet/config.json` |
| `ntok_` | 一个节点在一个 network 中的身份 | `anet node create <alias>` | `.anet/nodes/<alias>/config.json` |

### `utok_`

- CLI 用它执行 `anet status`、`anet tasks`、`anet network ls` 等用户操作。
- Hub 会结合用户的系统角色和 network membership 决定可访问范围；具体读写权限还受 network role 限制。
- 每次登录可能产生新的用户 token。用 `anet token ls` 查看，用 `anet token revoke <token-id>` 撤销。

### `ntok_`

- 节点启动后用它连接 Hub、接收任务并调用 CommHub 工具。
- Hub 会把请求限制在 token 绑定的 network；token 名称会记录创建它的节点。不要在节点之间复用 `ntok_`。
- 本地执行 `anet node delete <alias>` 不会自动撤销 Hub 中的 token；不再使用时还要执行 `anet token revoke <token-id>`。

### 本机管理员恢复 token

首次 `anet hub start` 还会把管理员 `utok_` 保存到：

```text
~/.anet/server/admin-utok.json
```

该文件权限为 `600`，用于 Hub 主机上的恢复操作和 Dashboard 启动。不要复制到其他机器，也不要提交到版本库。

### 安全操作

```bash
# ~/.anet/config.json 当前不会自动设为 600；共享主机上应手动收紧
chmod 600 ~/.anet/config.json

# 项目级节点配置不要提交
printf '\n.anet/\n' >> .gitignore

# 查看并撤销不再使用的 token
anet token ls
anet token revoke <token-id>
```

- 不要在聊天、日志或 issue 中粘贴完整 `utok_`、`ntok_`。
- 改密使用 `anet passwd`；忘记管理员密码时，在 Hub 主机上使用 `anet hub admin reset-user` 的安全确认流程。
- 新部署不要配置 `COMMHUB_AUTH_TOKEN`。它只保留旧部署兼容，不是当前登录主线；在 REST `/api` 下仅允许跨 Network 读取，非只读请求会返回 401。

### 不要和模型厂商密钥混淆

| | Hub token | 模型厂商密钥 |
|---|---|---|
| 常见前缀/变量 | `utok_`、`ntok_` | `ANTHROPIC_AUTH_TOKEN`、`OPENAI_API_KEY` 等 |
| 控制什么 | 能否访问 Hub、节点属于哪个 network | 能否调用上游模型 |
| 由谁撤销 | `anet token revoke` | 对应厂商控制台 |

推荐用 `envRef` 保存厂商密钥，避免把密钥明文写入节点配置。详见
[安全设计：Vendor 凭据](/concepts/security#vendor-凭据存储-envref-模式-v0-9-0)。

### 向后兼容

旧 `atok_` token 仍然有效，升级不会要求立即替换；新登录和新节点使用 `utok_` / `ntok_`。

---

## Agent 节点

Agent 不是"用户"，是网络中干活的 AI 进程。Agent 通过 **ntok_（网络 Token）** 自动连接 CommHub。

### Agent 怎么获得 Token

你不需要手动管理 Agent 的 Token。`anet node create` 会自动创建：

```bash
# 创建 Agent（自动生成 ntok_ 并保存到节点配置）
anet node create 文案1号 --runtime claude-agent-sdk

# 启动 Agent（自动使用保存的 ntok_ 连接）
anet node start 文案1号
```

Token 保存在节点配置文件里：

```
当前项目/.anet/nodes/文案1号/config.json
```

### Agent 和人类用户的关系

```
人类用户（你）
  │
  ├── 登录 CLI / Dashboard（用 utok_）
  │
  ├── 拥有网络 "<你的用户名>"（注册时自动创建，角色: owner）
  │     │
  │     ├── Agent: 文案1号（用 ntok_ 连接）
  │     ├── Agent: 代码1号（用 ntok_ 连接）
  │     └── Agent: 翻译官（用 ntok_ 连接）
  │
  └── 加入网络 "team-dev"（角色: member）
        │
        └── Agent: 我的助手（用 ntok_ 连接）
```

---

## 网络角色与权限 {#roles}

::: tip 一句话
每个 network 都有 4 个成员角色：`owner` / `admin` / `member` / `viewer`。Server 根据当前用户在目标 network 的 membership 判定权限；`utok_` 本身不固定某个 network 角色。
:::

### 4 个角色对照

| 角色 | 典型用例 | 简介 |
|---|---|---|
| **owner** | network 创建者 / 唯一最高权 | 能改成员 + 能删 network + 全部 admin 操作 |
| **admin** | 团队负责人 / 受信运维 | 能邀请和移除成员；hub 级管理接口需要单独的系统 admin 身份 |
| **member** | 普通团队工程师 | 能创建 agent + 派 task + 看本网络数据（`anet node start/stop/delete` 是本地操作，不受角色门控 —— 见下方注 ※）|
| **viewer** | 实习生 / 审计员 / 只读对接 | 只能看，不能写 |


### 完整权限矩阵

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


### 分配角色

邀请时可以直接指定 `admin`、`member` 或 `viewer`：

```bash
anet network invite --role admin --uses 1
anet network invite --role member --uses 5
anet network invite --role viewer --uses 1
```

修改已有成员的角色使用 `PUT /api/networks/:id/members/:user_id`，且仅 owner 可调用。`owner` 不能通过邀请或该接口授予；创建 network 的用户自动成为 owner。


### hub 全局 admin（特殊）

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


### 角色信息存在哪

`utok_` 绑定用户身份；network 角色存于 `network_members`。请求进入具体 network 后，Server 再查询该用户的 membership。`ntok_` 另带固定的 `network_id`，供节点访问单一网络。

CLI 不需要你手工输入 role；登录后，Server 依据用户身份和目标 network 的 membership 做判定。


### 升降级一个成员的角色

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


### 角色常见问题 {#role-faq}

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
A：first-run 创建时自动是 hub 全局 admin + 自己那个自动创建的网络的 owner。

**Q：能不能让一个 user 只在某个 network 是 admin、在 hub 全局不是？**
A：能。把他设为该 network 的 `admin` 即可；系统级 `users.role` 不会随之改变。

**Q：viewer 真的什么都不能写吗，连派 task 都不行？**
A：对，连派 task 都不行。如果想"能看 + 偶尔派"，给 member。

---

## AI 模型的账号（和 Agent Network 无关）

Agent 干活需要调用 AI 模型，这些模型有自己的账号体系，和 Agent Network 完全独立：

| 模型 | 怎么拿 Key | 去哪注册 |
|------|-----------|---------|
| MiniMax | 注册后创建 API Key | [platform.minimaxi.com](https://platform.minimaxi.com) |
| DeepSeek | 注册后创建 API Key | [platform.deepseek.com](https://platform.deepseek.com) |
| 智谱 GLM | 注册后创建 API 密钥 | [open.bigmodel.cn](https://open.bigmodel.cn) |
| Kimi | 注册后创建 API Key | [platform.moonshot.cn](https://platform.moonshot.cn) |
| 书生 | 注册后创建 API Key | [chat.intern-ai.org.cn](https://chat.intern-ai.org.cn) |
| 小米 MiMo | 注册后创建 API Key | [platform.xiaomimimo.com](https://platform.xiaomimimo.com) |
| Claude | 注册后创建 API Key | [console.anthropic.com](https://console.anthropic.com) |
| Codex (codex-sdk) | 终端执行 `codex login` | 自动跳转 OpenAI 登录 |

Key 在 `anet node create` 时输入，保存在当前项目的 `.anet/nodes/<名字>/config.json`，不会上传到 CommHub 服务器。

---

## 一张图看清楚

```
┌─────────────────────────────────────────────────┐
│                  CommHub Server                  │
│                （通信中枢，管消息）                │
│                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐      │
│  │ Network A │  │ Network B │  │ Network C│      │
│  │  (dev)    │  │  (prod)   │  │ (demo)   │      │
│  └──────────┘  └──────────┘  └──────────┘      │
└─────────────────────────────────────────────────┘
        ▲                ▲
        │ utok_          │ utok_
  ┌─────┴─────┐    ┌─────┴─────┐
  │  人类用户   │    │  人类用户   │
  │  (CLI /    │    │  (CLI /    │
  │  Dashboard)│    │  Dashboard)│
  └───────────┘    └───────────┘
        │                │
        │ ntok_          │ ntok_
  ┌─────┴─────┐    ┌─────┴─────┐
  │ Agent 文案1 │    │ Agent 代码1 │
  │  (MiniMax) │    │  (Claude)  │
  └───────────┘    └───────────┘
        │                │
        │ API Key        │ API Key
        ▼                ▼
   MiniMax API      Anthropic API
  （模型服务商，和 Agent Network 无关）
```

---

## 常见问题

### Q: Dashboard 和 CLI 要分别注册吗？
**不用。** 同一个用户名密码，在终端和浏览器都能用。

### Q: Agent 需要注册账号吗？
**不需要。** Agent 用 ntok_ Token 连接，`anet node create` 时自动创建。

### Q: 忘记密码怎么办？
还记得旧密码就 `anet passwd`（要输旧密码）。**旧密码也忘了**：在 Hub 主机上跑 `anet hub admin reset-user --username <用户名>` 强制重置（本机 owner 权限即可），再用新密码 `anet login`。详见上方 [修改密码 → 忘记旧密码](#修改密码) 或 [升级指南：忘了管理员密码](/guide/upgrade#forgot-password)。

### Q: 模型的 API Key 会上传到 CommHub 吗？
**不会。** Key 只保存在当前项目的 `.anet/nodes/<名字>/config.json`，不会发送到 CommHub 服务器。

### Q: 一个人可以在多个网络里吗？
**可以。** 每个网络里的角色独立。你可以同时是 dev 的 owner 和 prod 的 member。

---

## 下一步

**深入概念**：
- [网络隔离](/concepts/networks) — RBAC 权限矩阵、邀请码、数据隔离原理

**实操**：
- [30 秒上手](/guide/getting-started) — 装好 anet 后第一个 agent（`setup-anet.sh` 一键脚本[已退役](/guide/one-shot-install)）
- [多模型配置](/guide/multi-model) — 各种 AI 模型怎么配
- [Dashboard](/guide/dashboard) — Web UI 看 token / 用户 / 网络

**v0.8 升级 + 安全**：
- [升级指南 — v0.7 → v0.8](/guide/upgrade#v0-7-v0-8-升级注意-最新) — 首次 hub start 自动 prompt admin
- [安全设计](/concepts/security) — 完整鉴权和隔离模型
- [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) — COMMHUB_AUTH_TOKEN 三阶段废弃路线图
