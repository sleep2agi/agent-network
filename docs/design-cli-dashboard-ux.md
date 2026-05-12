# CLI + Dashboard 用户流程设计

> **实现状态（2026-05-12 对齐 v0.8.2）**
>
> 历史背景：本文写于 V3 早期（2026-04-11 首次对齐），描述的是 CLI + Dashboard 的用户流程目标态。v0.8 系列大幅推进了 token 与密码管理（[RFC-001 Phase 2](rfcs/RFC-001-deprecate-commhub-auth-token.md)），UX 上还增加了首次 hub start 的 admin bootstrap 和 doctor 自动修复。
>
> ✅ 已实现（v0.8.2）：
> - 双 token 体系 (utok_ + ntok_)，token 对用户透明
> - anet login 后交互选网络
> - anet node create 交互选网络（多网络时）
> - anet network invite/join/members CLI
> - anet node create 自动生成 ntok_ 写入节点 config
> - **v0.8 admin bootstrap**：首次 `anet hub start` prompt 设 admin 账号（默认 `admin / anethub`），密码强度 ≥ 8 + 弱密码字典（首次 bootstrap 例外允许 ≥ 4）
> - **v0.8 密码管理**：`anet passwd` 交互改密 / `anet hub admin reset-user <username>` 本机 owner 强制重置
> - **v0.8 doctor**：`anet doctor --fix` 自动 probe 并重发过期 ntok_；agent-node SSE 401 自动 reload
> - **Dashboard 0.4.2 thin cookie-proxy**：不再需要 service token 配置（v0.8 起）
>
> ❌ 未实现（目标态，排到 v0.9+）：
> - Token scope 选择（agent/readonly）— createToken 统一 full
> - 项目级 .anet/config.json 网络配置（network use --project）
> - Dashboard 改密码 UI、网络管理页（CLI 已可，Dashboard 入口缺）
> - 公开网络浏览 + 申请加入
> - viewer 灰色不可选（create 时未检查角色）
> - Argon2id 密码哈希（当前 SHA-256）
>
> ⛔ 已废弃方向（本文下方仍有相关引用，请忽略）：
> - 官方 `hub.sleep2agi.com` 托管 hub — 项目方向已转为 Apache 2.0 + 自部署 + 课程 / 服务咨询，**不做 SaaS 托管**，所有官方 hub 默认地址引用都是历史设计稿，新用户用 `http://127.0.0.1:9200` 本机即可

## 核心原则（Vincent 确认）

1. **一个用户多个 token，一个 token 绑一个网络**
2. **Token 对用户透明** — 用户只需 login + 选网络，token 自动管理
3. **两级 scope** — 全局网络 (~/.anet/config.json) + 项目级网络 ({project}/.anet/config.json)
4. **创建 agent 时交互选网络** — 上下键选择，viewer 网络灰色不可选
5. **一个 agent-node 只在一个网络**

---

## 一、CLI 完整流程

### 场景 1：新用户首次使用（3 分钟上手）

```bash
# 1. 安装
npm i -g @sleep2agi/agent-network@preview

# 2. 一键设置
anet quickstart
#   → 输入 hub URL（回车用默认 127.0.0.1:9200，或输入官方 hub.sleep2agi.com）
#   → 输入用户名 + 密码
#   → 自动注册 → 自动创建 "default" 网络 → 自动生成 token
#   → 输入 agent 名称 + 选 runtime
#   → 完成！
#
#   ✅ Hub: http://127.0.0.1:9200
#   ✅ 用户: vincent (admin)
#   ✅ 网络: default
#   ✅ Token: atok_abc... (已保存到 ~/.anet/config.json)
#   ✅ Agent "my-agent" 已创建
#
#   下一步：anet node start my-agent

# 3. 启动 agent
anet node start my-agent
#   启动
#   runtime: codex-sdk
#   model:   gpt-5.4
#   hub:     http://127.0.0.1:9200 (auth)
#   user:    vincent (admin)
#   network: default
#   已注册到 CommHub
```

### 场景 2：管理多个网络

```bash
# 查看我的网络
anet network ls
#   ⭐ default       owner    3 agents   12 tasks
#   👤 team-prod     member   8 agents   156 tasks
#   👁 open-demo     viewer   2 agents   5 tasks

# 创建新网络
anet network create my-project
#   ✅ 网络 "my-project" 已创建 (net_xxx)
#   ✅ 已自动切换到 my-project
#   ✅ 已生成 token: atok_def... (full)

# 切换当前网络
anet network use team-prod
#   ✅ 切换到 team-prod (member)
#   提示：你在此网络是 member，可以发任务和启动 agent

# 查看网络详情
anet network info
#   网络: team-prod
#   角色: member
#   成员: 5 人 (1 owner, 1 admin, 3 members)
#   Agent: 8 online, 2 offline
#   任务: 156 total (12 running)

# 删除自己的网络
anet network delete my-project --force
#   ✅ 网络 "my-project" 已删除
```

### 场景 3：邀请别人加入网络

```bash
# 生成邀请码（owner/admin 才能操作）
anet network invite --role member
#   邀请码: inv_abc123
#   网络:   default
#   角色:   member
#   有效:   7 天，可用 1 次
#   
#   把这个发给对方：
#   anet network join inv_abc123

# 或生成多次使用的邀请码
anet network invite --role viewer --uses 10 --expires 30d
#   邀请码: inv_xyz789
#   可用 10 次，30 天内有效
```

### 场景 4：被邀请加入网络

```bash
# 收到邀请码
anet network join inv_abc123
#   ✅ 已加入网络 "default" (角色: member)
#   ✅ 已生成 token: atok_ghi... (绑定此网络)
#   ✅ 已切换到 default

# 在这个网络里创建 agent
anet node create my-bot --runtime codex-sdk
anet node start my-bot
#   user:    xiaoming
#   network: default (member)
```

### 场景 5：Token 管理

```bash
# 查看我的所有 token
anet token ls
#   TOKEN ID       NAME          SCOPE    NETWORK        LAST USED
#   tok_abc        default       full     default        2 min ago
#   tok_def        my-project    full     my-project     1 hour ago
#   tok_ghi        bot-token     full     default        5 min ago

# 创建 API token（当前 CLI 不支持 scope / --network 参数）
anet token create prod-bot
#   ✅ Token: atok_jkl...
#   scope: full
#   用法: COMMHUB_TOKEN=atok_jkl... agent-node --alias prod-bot

# 撤销 token
anet token revoke tok_def
#   ✅ Token tok_def 已撤销
```

### 场景 6：查看状态和任务（受网络角色限制）

```bash
# 当前网络的状态
anet status
#   网络: default (owner)
#   Agent:
#     my-agent     idle       codex-sdk    gpt-5.4
#     translator   working    http-api     minimax
#   任务: 3 running, 12 completed

# 查看任务
anet tasks
#   STATUS     FROM         TO           CONTENT
#   running    vincent      translator   翻译 README...
#   replied    hub          my-agent     分析数据...

# 实时仪表盘
anet demo --live
#   (每 5 秒刷新，显示 agent/任务/统计)
```

### 场景 7：创建 agent 时选网络（交互式）

```bash
anet node create my-bot
#   选择网络:
#   > ⭐ default (owner)          ← 上下键选择
#     👤 prod (member)
#     👁 demo (viewer)            ← 灰色，不可选（viewer 不能创建）
#
#   选择 Runtime:
#   > codex-sdk (Codex) — 推荐
#     http-api (MiniMax/OpenAI 兼容)
#     claude-agent-sdk (Claude Code)
#
#   ✅ my-bot 已创建，网络: default

# 如果只有一个可写网络 → 跳过选择
# 如果当前目录有项目级网络配置 → 默认选中
# 非 TTY（CI/脚本）→ 先切换 network，再创建节点
anet network use prod
anet node create ci-bot --runtime codex-sdk
```

### 场景 8：两级 scope（全局 vs 项目级）

```bash
# 全局网络（影响所有目录）
anet network use prod
# → 写入 ~/.anet/config.json

# 项目级网络（只影响当前项目目录）
cd ~/my-project
anet network use dev --project
# → 写入 ~/my-project/.anet/config.json

# 优先级：项目级 > 全局
# 在 ~/my-project 下操作 → 用 dev 网络
# 在其他目录操作 → 用 prod 网络（全局）
```

### 场景 9：agent-node 在不同网络启动

```bash
# 最简单：自动用当前网络（token 透明）
anet node start my-bot
# → 读 config → 自动用对应网络的 token → 启动

# 高级：不同目录不同网络
cd ~/project-a && anet node start bot-a &  # → project-a 的网络
cd ~/project-b && anet node start bot-b &  # → project-b 的网络

# 无人值守部署（唯一需要显式 token 的场景）
COMMHUB_TOKEN=atok_prod agent-node --alias ci-bot
```

---

## 二、Dashboard 完整流程

### 页面 1：登录/注册

```
┌────────────────────────────────────┐
│     Agent Network                   │
│                                     │
│  用户名: [_____________]            │
│  密  码: [_____________]            │
│                                     │
│  [登录]    没有账号？[注册]          │
└────────────────────────────────────┘
```

注册后自动创建 default 网络 + token → 跳转首页。

### 页面 2：首页（当前网络仪表盘）

```
┌──────────┬─────────────────────────────────────┐
│ 网络列表  │  default (owner)                     │
│          │                                       │
│ ⭐ default│  ┌─────────────────────────────────┐ │
│ 👤 prod   │  │ Agent 拓扑图                     │ │
│ 👁 demo   │  │   hub ─── bot-1 (working)       │ │
│          │  │    ├──── bot-2 (idle)             │ │
│          │  │    └──── monitor (idle)           │ │
│          │  └─────────────────────────────────┘ │
│          │                                       │
│          │  Tasks: 23 | Running: 2 | Agents: 3  │
│          │                                       │
│          │  最近任务:                             │
│          │  ✅ bot-1 完成: 数据分析              │
│          │  ⏳ bot-2 执行中: 翻译文档            │
└──────────┴─────────────────────────────────────┘
```

左侧网络列表：
- ⭐ = owner（黄色星）
- 👤 = member（蓝色人）
- 👁 = viewer（灰色眼）
- 点击切换网络 → 右侧内容刷新

### 页面 3：Agent 列表

```
┌─────────────────────────────────────────────────┐
│  Agents — default (owner)                        │
│                                                   │
│  NAME        STATUS    RUNTIME    MODEL    TASK  │
│  bot-1       🔨 working codex-sdk gpt-5.4  分析..│
│  bot-2       💤 idle    http-api  minimax       │
│  monitor     💤 idle    claude    sonnet        │
│                                                   │
│  [+ 创建 Agent]  ← owner/admin/member 可见       │
│                   ← viewer 看不到此按钮            │
└─────────────────────────────────────────────────┘
```

### 页面 4：任务列表

```
┌─────────────────────────────────────────────────┐
│  Tasks — default (owner)                         │
│                                                   │
│  [发送任务] ← owner/admin/member 可见             │
│                                                   │
│  STATUS  FROM      TO       CONTENT      TIME   │
│  ✅ done  vincent  bot-1    分析数据     2m ago  │
│  ⏳ run   hub      bot-2    翻译文档     5m ago  │
│  📬 new   xiaoming bot-1    代码审查     8m ago  │
│                                                   │
│  筛选: [全部▾] [状态▾] [Agent▾]                  │
└─────────────────────────────────────────────────┘
```

### 页面 5：网络成员管理（owner/admin 可见）

```
┌─────────────────────────────────────────────────┐
│  Members — default                                │
│                                                   │
│  USER       ROLE      JOINED      ACTIONS        │
│  vincent    ⭐ owner   2026-04-01                 │
│  xiaoming   👤 member  2026-04-10  [改角色][踢出] │
│  visitor    👁 viewer  2026-04-11  [改角色][踢出] │
│                                                   │
│  [邀请成员]                                       │
│  ┌────────────────────────────────┐              │
│  │ 角色: [member ▾]               │              │
│  │ 次数: [1 ▾]   有效: [7天 ▾]   │              │
│  │ [生成邀请码]                    │              │
│  │                                │              │
│  │ inv_abc123                     │              │
│  │ [复制]                         │              │
│  └────────────────────────────────┘              │
└─────────────────────────────────────────────────┘
```

### 页面 6：Token 管理

```
┌─────────────────────────────────────────────────┐
│  Tokens — 我的 Token                              │
│                                                   │
│  [+ 创建 Token]                                   │
│                                                   │
│  NAME         SCOPE     NETWORK    LAST USED     │
│  default      full      default    2 min ago     │
│  prod-bot     agent     prod       1 hour ago    │
│  monitor      readonly  demo       3 hours ago   │
│                                                   │
│  每行: [复制Token] [撤销]                         │
│                                                   │
│  创建弹窗:                                        │
│  ┌────────────────────────────┐                  │
│  │ 名称:  [bot-token      ]  │                  │
│  │ 权限:  [agent ▾]          │                  │
│  │ 网络:  [default ▾]        │                  │
│  │ [创建]                     │                  │
│  │                            │                  │
│  │ atok_xxx...    [复制]      │                  │
│  └────────────────────────────┘                  │
└─────────────────────────────────────────────────┘
```

### 页面 7：Settings

```
┌─────────────────────────────────────────────────┐
│  Settings                                         │
│                                                   │
│  用户信息                                         │
│  用户名:    vincent                               │
│  显示名:    [Vincent     ] [保存]                 │
│  邮箱:      [v@xxx.com   ] [保存]                 │
│  系统角色:  admin                                  │
│  Plan:      Pro (无限期)                           │
│                                                   │
│  修改密码                                         │
│  当前密码:  [____________]                        │
│  新密码:    [____________]                        │
│  确认密码:  [____________]                        │
│  [修改密码]                                       │
│                                                   │
│  License                                          │
│  类型: Pro | 到期: 无限期                         │
│  [激活新授权码]                                    │
│                                                   │
│  配额                                             │
│  创建网络: 2/10 | 加入网络: 3/20                  │
│  Token: 3/20 | 每日任务: 45/5000                  │
└─────────────────────────────────────────────────┘
```

### 页面 8：Admin（仅 admin 用户可见）

```
┌─────────────────────────────────────────────────┐
│  Admin Panel                                      │
│                                                   │
│  用户管理                                         │
│  USER       ROLE    PLAN    NETWORKS  CREATED    │
│  vincent    admin   pro     3         2026-04-01 │
│  xiaoming   user    free    1         2026-04-10 │
│  visitor    user    free    0         2026-04-11 │
│                                                   │
│  全局统计                                         │
│  用户: 3 | 网络: 5 | Agent: 15 | 任务: 1234      │
│                                                   │
│  服务器                                           │
│  版本: 1.0.0-preview | DB: SQLite                 │
│  运行: 3 天 | SSE 连接: 24                        │
│  [开放/关闭注册]                                   │
└─────────────────────────────────────────────────┘
```

---

## 三、按钮显示规则（权限 → UI）

| UI 元素 | owner | admin | member | viewer |
|---------|-------|-------|--------|--------|
| 发送任务按钮 | ✅ | ✅ | ✅ | 隐藏 |
| 创建 Agent 按钮 | ✅ | ✅ | ✅ | 隐藏 |
| 邀请成员 | ✅ | ✅ | 隐藏 | 隐藏 |
| Token 管理 | ✅ | ✅ | 隐藏 | 隐藏 |
| 成员管理页 | ✅ | ✅ | 隐藏 | 隐藏 |
| 网络设置（改名/删除） | ✅ | 隐藏 | 隐藏 | 隐藏 |
| 查看状态/任务/日志 | ✅ | ✅ | ✅ | ✅ |
| Admin Panel | 仅系统 admin | 隐藏 | 隐藏 | 隐藏 |

---

*通信龙 2026-04-11 设计，基于 Vincent 确认的前提：一个用户多 token，一个 token 绑一个网络*
