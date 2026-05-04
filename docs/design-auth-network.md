# 用户 × 网络 × Agent Node 认证权限设计 V2

> **实现状态（2026-04-11 对齐）**
> 
> ✅ 已实现：
> - 双 token：utok_（用户）+ ntok_（节点网络）+ atok_（兼容）
> - 注册返回 utok_ + ntok_，登录返回 utok_
> - network_members + network_invites 表
> - 邀请码创建/加入/成员 CRUD API
> - 首个用户自动 admin
> - users.plan 字段 + networks.visibility/max_members 字段
> 
> ❌ 未实现（目标态）：
> - MCP 写操作检查网络角色（viewer 当前能 send_task）
> - 配额执行（字段有但不拦截）
> - utok_/ntok_ 权限边界（utok_ 当前能调 MCP）
> - Token scope (agent/readonly) — createToken 统一写 full
> - 公开网络自动加入 + 审批流
> - bcrypt 密码哈希（当前 SHA-256）
> 
> 注意：本文档中描述的权限矩阵、配额限制、公开网络等功能为**设计目标**，
> 具体实现进度以上方状态为准。

## 0. 总览

```
┌─────────────────────────────────────────────────────────────┐
│  CommHub Server                                              │
│                                                              │
│  Users (账号)                                                │
│  ├── Vincent (admin)                                        │
│  │   ├── "dev" 网络 ────── role: owner                      │
│  │   ├── "公司prod" 网络 ── role: member (被邀请)            │
│  │   └── "开源demo" 网络 ── role: viewer (公开)              │
│  │                                                          │
│  ├── 小明 (user)                                             │
│  │   ├── "小明实验" 网络 ── role: owner                      │
│  │   └── "dev" 网络 ────── role: member (Vincent 邀请)       │
│  │                                                          │
│  └── 游客 (user)                                             │
│      └── "开源demo" 网络 ── role: viewer (公开网络自动加入)   │
│                                                              │
│  每个网络内：                                                 │
│  Network "dev" ──→ Agent: solver-1, translator-2, monitor    │
│  Network "prod" ─→ Agent: api-bot, alert-bot                 │
└─────────────────────────────────────────────────────────────┘
```

## 1. 双层权限模型

### Layer 1: 系统角色（全局，per user）

| 系统角色 | 谁 | 权限 |
|---------|-----|------|
| **admin** | 第一个注册的用户（自动） | 管理所有用户、看全局统计、开关注册 |
| **user** | 后续注册的用户 | 创建网络、加入网络、管理自己的 agent |

实现：users 表已有 `role` 字段。第一个注册的用户自动 `role = 'admin'`。

### Layer 2: 网络角色（per user per network）

| 网络角色 | 含义 | 权限 |
|---------|------|------|
| **owner** | 创建者 | 一切权限（删网络、管成员、管 token、踢人） |
| **admin** | 网络管理员 | 管 agent + 管 token + 发任务 + 读 |
| **member** | 成员 | 启动 agent + 发任务 + 读状态（最常用） |
| **viewer** | 只读 | 看 agent 状态、看任务、看日志，不能写 |

### 权限矩阵

| 操作 | owner | admin | member | viewer |
|------|-------|-------|--------|--------|
| 删除/重命名网络 | ✅ | ❌ | ❌ | ❌ |
| 邀请/踢除成员 | ✅ | ✅ | ❌ | ❌ |
| 创建/撤销 token | ✅ | ✅ | ❌ | ❌ |
| 启动 agent-node | ✅ | ✅ | ✅ | ❌ |
| 发任务 (send_task) | ✅ | ✅ | ✅ | ❌ |
| 回复任务 (send_reply) | ✅ | ✅ | ✅ | ❌ |
| 取消/重试任务 | ✅ | ✅ | ✅ | ❌ |
| 查看 agent 状态 | ✅ | ✅ | ✅ | ✅ |
| 查看任务列表 | ✅ | ✅ | ✅ | ✅ |
| 查看审计日志 | ✅ | ✅ | ❌ | ❌ |

## 2. 网络加入方式

### 2.1 方式一：邀请码（推荐）

```
Owner/Admin 操作：
  anet network invite dev --role member
  → 生成邀请码: inv_abc123 (一次性或多次使用)

被邀请人操作：
  anet network join inv_abc123
  → 加入 "dev" 网络，角色 = member
  → 自动创建绑定该网络的 token
```

### 2.2 方式二：Token 分发

```
Owner 操作：
  anet network use dev
  anet node create agent-token
  → .anet/nodes/agent-token/config.json 内写入 ntok_...

把节点配置给对方：
  对方复制 .anet/nodes/agent-token/config.json 到运行机器
  → agent-node 启动时自动绑定到 dev 网络
  → 但对方没有 Dashboard 登录能力（只有 agent 权限）
```

### 2.3 方式三：公开网络

```
Owner 操作：
  anet network set-visibility dev --public
  → 网络变为公开

任何登录用户：
  anet network join dev
  → 自动以 viewer 角色加入
  → 可以看状态，不能发任务
  
  anet network join dev --request-member
  → 申请 member 权限（owner 审批）
```

## 3. 数据库变更

### 3.1 新增 network_members 表

```sql
CREATE TABLE IF NOT EXISTS network_members (
  network_id  TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',  -- owner/admin/member/viewer
  invited_by  TEXT,                            -- 谁邀请的
  joined_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (network_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_netmem_user ON network_members(user_id);
CREATE INDEX IF NOT EXISTS idx_netmem_network ON network_members(network_id);
```

### 3.2 新增 network_invites 表

```sql
CREATE TABLE IF NOT EXISTS network_invites (
  invite_code TEXT PRIMARY KEY,
  network_id  TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  created_by  TEXT NOT NULL,
  max_uses    INTEGER DEFAULT 1,    -- -1 = 无限
  used_count  INTEGER DEFAULT 0,
  expires_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 3.3 networks 表新增字段

```sql
ALTER TABLE networks ADD COLUMN visibility TEXT DEFAULT 'private';  -- private/public
ALTER TABLE networks ADD COLUMN max_members INTEGER DEFAULT 50;
```

### 3.4 迁移兼容

现有 networks 表的 owner_id → 自动在 network_members 插入一条 role='owner' 记录。
向后兼容：如果 network_members 表不存在，fallback 到 owner_id 判断。

## 4. API 变更

### 4.1 新增 API

| 端点 | 方法 | 说明 | 权限 |
|------|------|------|------|
| `/api/networks/:id/members` | GET | 网络成员列表 | owner/admin |
| `/api/networks/:id/members` | POST | 添加成员 `{user_id, role}` | owner/admin |
| `/api/networks/:id/members/:uid` | PUT | 修改成员角色 | owner |
| `/api/networks/:id/members/:uid` | DELETE | 踢除成员 | owner/admin |
| `/api/networks/:id/invite` | POST | 创建邀请码 | owner/admin |
| `/api/networks/join` | POST | 用邀请码加入 `{invite_code}` | any user |

### 4.2 修改现有 API

| 端点 | 变更 |
|------|------|
| `GET /api/networks` | 返回用户作为成员的所有网络（不只是 owner） |
| `GET /api/auth/me` | 返回用户在各网络的角色 |
| MCP 写操作 | 检查 token 绑定的网络角色 ≥ member |
| MCP 读操作 | 检查 token 绑定的网络角色 ≥ viewer |

## 5. 用户体验流程

### 5.1 新手首次使用

```
npm i -g @sleep2agi/agent-network@preview
anet quickstart
  → 连接 hub (官方免费 / 自部署)
  → 注册账号 (第一个注册 → admin)
  → 自动创建 default 网络 (owner)
  → 创建第一个 agent
  → 完成！3 分钟上手
```

### 5.2 被邀请加入团队网络

```
收到邀请码 inv_abc123
anet login                    # 先登录（或注册）
anet network join inv_abc123  # 加入网络
anet network use prod         # 切换到该网络
anet node create my-agent     # 创建 agent（自动绑定当前网络）
anet node start my-agent      # 启动
```

### 5.3 Dashboard 体验

```
登录 → 左侧网络列表：
  ⭐ dev (owner)           ← 自己创建的
  👤 prod (member)         ← 被邀请的
  👁 开源demo (viewer)     ← 公开只读

点击网络 → 看到该网络的 agent / 任务 / 日志
权限不同 → UI 按钮自动隐藏（viewer 看不到"发任务"按钮）
```

## 6. 账号配额（Plan）

不同级别的用户有不同的配额限制：

| 配额项 | Free (试用) | Pro (付费) | Admin (管理员) |
|--------|------------|-----------|---------------|
| 创建网络数 | 2 | 10 | 无限 |
| 加入网络数 | 3 | 20 | 无限 |
| 每网络 Agent 数 | 5 | 50 | 无限 |
| 每天任务数 | 100 | 5000 | 无限 |
| Token 数 | 3 | 20 | 无限 |
| 网络最大成员 | 5 | 50 | 无限 |
| 试用期 | 14 天 | 无限 | 无限 |

### 实现方式

```sql
-- users 表新增字段
ALTER TABLE users ADD COLUMN plan TEXT DEFAULT 'free';  -- free/pro/admin

-- 或关联 licenses 表（已有）
-- licenses.type = 'trial' → free 配额
-- licenses.type = 'pro'   → pro 配额
```

```typescript
// 配额检查（在创建网络 / 加入网络 / 发任务前）
const QUOTAS = {
  free:  { max_networks_owned: 2, max_networks_joined: 3, max_agents_per_net: 5, max_tasks_day: 100, max_tokens: 3 },
  pro:   { max_networks_owned: 10, max_networks_joined: 20, max_agents_per_net: 50, max_tasks_day: 5000, max_tokens: 20 },
  admin: { max_networks_owned: Infinity, max_networks_joined: Infinity, max_agents_per_net: Infinity, max_tasks_day: Infinity, max_tokens: Infinity },
};
```

### 超配额提示

```
anet network create third-net
→ ❌ Free plan: 最多创建 2 个网络。升级: anet activate <key>

anet network join inv_xxx
→ ❌ Free plan: 最多加入 3 个网络。升级: anet activate <key>
```

## 7. Token 设计

### 6.1 Token 类型

| scope | 能做什么 | 谁用 |
|-------|---------|------|
| **full** | 读+写+管理（等同用户本人） | Dashboard 登录、CLI |
| **agent** | 读+写（MCP 工具） | agent-node 连接 |
| **readonly** | 只读（REST API） | 监控、嵌入 |

### 6.2 Token 绑定规则

- 每个 token 绑定一个 user + 一个 network
- Token 的有效权限 = min(token scope, 用户在该网络的角色)
  - 例：用户是 viewer + token scope=full → 实际只有 viewer 权限
  - 例：用户是 owner + token scope=readonly → 实际只有 readonly 权限
- agent-node 用 token 启动 → 自动绑定到 token 的网络

### 6.3 创建流程

```bash
# CLI 创建（推荐）
anet node create my-bot
→ 节点 config 内写入 ntok_xxx... (bound to current network)

# Dashboard 创建
Settings → Token Management → Create Token
→ 选 scope + 选网络 → 生成 token → 复制

# 把 token 给 agent-node
COMMHUB_TOKEN=atok_xxx agent-node --alias my-bot
```

## 8. 实施计划

### Phase 1 (V3.13) — 网络成员 + 邀请码
- [ ] network_members 表 + 迁移（owner_id → member role=owner）
- [ ] network_invites 表
- [ ] `GET /api/networks` 返回所有成员网络
- [ ] `POST /api/networks/:id/invite` 创建邀请码
- [ ] `POST /api/networks/join` 加入网络
- [ ] `anet network invite` + `anet network join` CLI
- [ ] 第一个注册用户自动 admin
- [ ] E2E 测试

### Phase 2 (V3.14) — 权限检查 + Token scope
- [ ] MCP 写操作检查 member 角色
- [ ] MCP 读操作检查 viewer 角色
- [ ] Token scope (full/agent/readonly) 实现
- [ ] Dashboard 按角色隐藏按钮

### Phase 3 (V3.15) — 公开网络 + 审批
- [ ] networks.visibility = public/private
- [ ] 公开网络自动 viewer 加入
- [ ] member 申请 + owner 审批流

---

*通信龙 2026-04-11 V2 设计，待 Vincent review*
