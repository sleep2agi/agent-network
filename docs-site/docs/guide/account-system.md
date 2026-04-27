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
| **一键启动时自动注册** | `anet hub start` 或 `anet quickstart` | 第一次使用，本机搭建 |
| **手动注册** | `anet register --hub http://服务器IP:9200` | 加入别人的服务器 |

```bash
# 方式 1：一键启动（自动注册 admin 账号）
anet hub start
# → 交互式输入用户名和密码
# → 自动注册 + 登录 + 创建默认网络

# 方式 2：加入别人的服务器
anet register --hub http://10.0.0.1:9200
# → 输入用户名和密码
# → 注册成功，自动登录
```

::: info 第一个注册的用户
第一个注册的用户自动成为系统管理员（admin），可以管理所有用户。后续注册的用户是普通用户（user）。
:::

### 登录

注册成功后会自动登录。如果需要重新登录：

| 登录位置 | 怎么做 | 用什么账号 |
|---------|--------|-----------|
| **CLI（终端）** | `anet login` | 注册时的用户名 + 密码 |
| **Dashboard（浏览器）** | 打开 `http://服务器IP:9200` | 同一个用户名 + 密码 |

```bash
# CLI 登录
anet login
# → 输入用户名和密码
# → 登录成功，Token 保存到 ~/.anet/config.json

# 验证登录状态
anet whoami
# → Logged in as: yourname
# → Role: admin
# → Network: default (net_xxxxxxxx)
```

::: tip CLI 和 Dashboard 是同一个账号
在终端 `anet login` 和在浏览器 Dashboard 登录用的是完全相同的用户名密码。不需要分别注册。
:::

### 修改密码

```bash
anet passwd
```

### 给别人开账号

让对方在自己电脑上运行：

```bash
anet register --hub http://你的服务器IP:9200
```

对方注册后会自动创建自己的默认网络。如果要加入你的网络，需要你创建邀请码：

```bash
# 你创建邀请码
anet network invite default --role member

# 对方用邀请码加入
anet network join inv_xxxxxx
```

---

## Agent 节点

Agent 不是"用户"，是网络中干活的 AI 进程。Agent 通过 **ntok_（网络 Token）** 连接 CommHub。

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
~/.anet/nodes/文案1号/config.json
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
| **member** | 通过邀请码加入的用户 | 启动 Agent、发任务、回复任务 |
| **viewer** | 只读用户 | 只能看，不能发任务、不能启动 Agent |

::: info 一个用户可以在不同网络有不同角色
比如你在 "dev" 网络是 owner，在 "prod" 网络是 member，在 "demo" 网络是 viewer。
:::

### 权限速查

| 操作 | owner | admin | member | viewer |
|------|:-----:|:-----:|:------:|:------:|
| 查看 Agent 和任务 | ✓ | ✓ | ✓ | ✓ |
| 发任务 / 回复任务 | ✓ | ✓ | ✓ | |
| 启动 Agent | ✓ | ✓ | ✓ | |
| 邀请 / 踢除成员 | ✓ | ✓ | | |
| 修改成员角色 | ✓ | | | |
| 删除 / 重命名网络 | ✓ | | | |

---

## AI 模型的账号（和 Agent Network 无关）

Agent 干活需要调用 AI 模型，这些模型有自己的账号体系，和 Agent Network 完全独立：

| 模型 | 怎么拿 Key | 去哪注册 |
|------|-----------|---------|
| MiniMax | 注册后创建 API Key | [platform.minimaxi.com](https://platform.minimaxi.com) |
| DeepSeek | 注册后创建 API Key | [platform.deepseek.com](https://platform.deepseek.com) |
| 智谱 GLM | 注册后创建 API 密钥 | [open.bigmodel.cn](https://open.bigmodel.cn) |
| Kimi | 注册后创建 API Key | [platform.moonshot.cn](https://platform.moonshot.cn) |
| Claude | 注册后创建 API Key | [console.anthropic.com](https://console.anthropic.com) |
| GPT-5.5 | 终端执行 `codex auth login` | 自动跳转 OpenAI 登录 |

Key 在 `anet node create` 时输入，保存在本机 `~/.anet/nodes/<名字>/config.json`，不会上传到 CommHub 服务器。

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
**不会。** Key 只保存在你本机的 `~/.anet/nodes/<名字>/config.json`，不会发送到 CommHub 服务器。

### Q: 一个人可以在多个网络里吗？
**可以。** 每个网络里的角色独立。你可以同时是 dev 的 owner 和 prod 的 member。

---

## 下一步

- [Token 体系详解](/concepts/tokens) -- utok_ / ntok_ / atok_ 的完整说明
- [网络隔离](/concepts/networks) -- RBAC 权限矩阵、邀请码、数据隔离原理
- [多模型配置](/guide/multi-model) -- 各种 AI 模型怎么配
