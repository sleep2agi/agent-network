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
# → 自动创建默认账号 admin / anethub
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
# 实际输出（verify cli.ts:3281-3302）:
#   User: yourname (u_xxxxxx)
#   Role: admin             ← 系统级 users.role ('admin' / 'user')，不是 network role
#   Hub:  http://127.0.0.1:9200
#
#   Networks:
#     default (net_xxxxxxxx) ← current
#     team-prod (net_yyyyyyyy)
```

::: tip 系统级 role vs 网络级 role
`whoami` 显示的 `Role:` 是 **系统级** `users.role`（仅 `admin` / `user` 两个值），**不是** 当前 network 内的 `owner / admin / member / viewer`。要查 network 内的 role，跑 `anet network members` 看自己那行。详见 [roles → FAQ](/concepts/roles)（R227 chain 一致）。
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
- 如果你之后用 `anet hub admin reset-user <other>` 这种本机命令读 admin-utok.json → **会拿 401**
- 当前的兜底：手动跑 `anet login --username admin --password <新密码>`，刷新 `~/.anet/config.json`；admin-utok.json 是 bootstrap 一次性凭证，长期使用以 config.json 为准。完整修复留 follow-up（v0.9）。

**审计日志**
- `audit_log` 写入一条 `password_changed`（走 reset-user 路径则是 `password_reset_by_admin`）
- 通过 REST `GET /api/audit-log` 查看 —— **系统级** `users.role='admin'` 看全部 row，普通用户只看自己的 row（**不是**网络级 owner/admin 权限，R262/R263 chain；详见 [API — audit-log](/api/rest#get-api-audit-log)）

**忘记旧密码怎么办？**
- 不能用 `anet passwd`（要求输旧密码）
- 在 Hub 主机跑 `anet hub admin reset-user <username>` 强制重置（owner 本机权限即可，绕过 HTTP 校验，详见 [FAQ Q17b](/faq#_17b-忘密码怎么办-v0-8)）

更深入：[Token 体系](/concepts/tokens) / [安全设计 — 密码安全](/concepts/security)
:::

### 给别人开账号

让对方在自己电脑上运行：

```bash
anet init --hub http://你的服务器IP:9200    # 配 hub URL
anet register                              # 注册账号（注册成功自动登录）
```

对方注册后会自动创建自己的默认网络。如果要加入你的网络，需要你创建邀请码：

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
  ├── 拥有网络 "default"（角色: owner）
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

## 网络角色（RBAC）

每个用户在每个网络里有一个角色：

| 角色 | 谁是 | 能做什么 |
|------|------|---------|
| **owner** | 创建网络的人 | 一切操作，包括删除网络、改角色 |
| **admin** | 被 owner 提升的用户 | 邀请/踢人、管理 Token，不能删网络 |
| **member** | 通过邀请码加入的用户 | 发任务、回复任务（`send_task` / `send_reply`）|
| **viewer** | 只读用户 | 只能看，不能发任务 / 回复任务 |

::: info 一个用户可以在不同网络有不同角色
比如你在 "dev" 网络是 owner，在 "prod" 网络是 member，在 "demo" 网络是 viewer。
:::

### 权限速查

| 操作 | owner | admin | member | viewer |
|------|:-----:|:-----:|:------:|:------:|
| 查看 Agent 和任务 | ✓ | ✓ | ✓ | ✓ |
| 发任务 / 回复任务 | ✓ | ✓ | ✓ | |
| 创建 Agent (`anet node create`) | ✓ | ✓ | ✓ | |
| 邀请 / 踢除成员 | ✓ | ✓ | | |
| 修改成员角色 | ✓ | | | |
| 删除 / 重命名网络 | ✓ | | | |

> 注：`anet node start / stop / delete` 是**纯本地 CLI 操作**，不受网络角色门控 —— 谁机器上有那份 node config 谁就能跑。受角色门控的只有 `anet node create`（要向 hub 换 `ntok_`）。详见 [角色与权限](/concepts/roles)。

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
| Codex (codex-sdk) | 终端执行 `codex auth login` | 自动跳转 OpenAI 登录 |

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
运行 `anet passwd` 修改密码。如果 CLI 也没登录，需要管理员重置。

### Q: 模型的 API Key 会上传到 CommHub 吗？
**不会。** Key 只保存在当前项目的 `.anet/nodes/<名字>/config.json`，不会发送到 CommHub 服务器。

### Q: 一个人可以在多个网络里吗？
**可以。** 每个网络里的角色独立。你可以同时是 dev 的 owner 和 prod 的 member。

---

## 下一步

**深入概念**：
- [Token 体系详解](/concepts/tokens) — utok_ / ntok_ / atok_ 的完整说明
- [角色与权限](/concepts/roles) — owner / admin / member / viewer 四级权限
- [网络隔离](/concepts/networks) — RBAC 权限矩阵、邀请码、数据隔离原理

**实操**：
- [一键安装与起步](/guide/one-shot-install) — 装好 anet 后第一个 agent
- [多模型配置](/guide/multi-model) — 各种 AI 模型怎么配
- [Dashboard](/guide/dashboard) — Web UI 看 token / 用户 / 网络

**v0.8 升级 + 安全**：
- [升级指南 — v0.7 → v0.8](/guide/upgrade#v0-7-v0-8-升级注意-最新) — 首次 hub start 自动 prompt admin
- [安全设计](/concepts/security) — 完整鉴权和隔离模型
- [RFC-001](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-001-deprecate-commhub-auth-token.md) — COMMHUB_AUTH_TOKEN 三阶段废弃路线图
