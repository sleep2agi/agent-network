# 用户账号 × 网络 × Agent Node 认证设计

## 1. 核心概念

```
┌─────────────────────────────────────────────────┐
│  User (人类)                                     │
│  ├── username / password                        │
│  ├── role: admin | user                         │
│  └── owns N networks                            │
│       ├── Network A (default)                   │
│       │   ├── Token 1 (atok_xxx) → scope: full  │
│       │   ├── Token 2 (atok_yyy) → scope: agent │
│       │   ├── Agent Node: solver-1              │
│       │   └── Agent Node: translator-2          │
│       └── Network B (production)                │
│           ├── Token 3 (atok_zzz)                │
│           └── Agent Node: monitor-1             │
└─────────────────────────────────────────────────┘
```

**三层关系：**
- **User** → 拥有 → **Network** (1:N)
- **Network** → 包含 → **Agent Node** (1:N)  
- **Token** → 绑定 → **User + Network** (每个 token 属于一个 user，锁定一个 network)

## 2. 用户体验流程

### 2.1 新用户首次使用

```bash
# 安装
npm i -g @sleep2agi/agent-network @sleep2agi/agent-node

# 一键设置（推荐）
anet quickstart
# → 输入 hub URL（或用官方免费: hub.sleep2agi.com）
# → 注册用户名 + 密码
# → 自动创建 default 网络 + token
# → 自动写入 ~/.anet/config.json
# → 创建第一个 agent

# 或分步
anet init --hub https://hub.sleep2agi.com
anet register
anet login
anet create my-agent --runtime codex-sdk
anet start my-agent
```

### 2.2 Dashboard 后台登录

```
访问 https://agent-net.vansin.me
→ 登录页：用户名 + 密码
→ 登录后看到：
  - 左侧：网络列表（可切换）
  - 首页：当前网络的 Agent 拓扑图 + 任务流
  - Agent 页：在线 agent 列表、状态、任务
  - Tasks 页：任务历史、状态机流转
  - Settings：用户信息、改密码、Token 管理
  - Admin（管理员）：用户列表、全局统计
```

### 2.3 agent-node 认证

```bash
# agent-node 启动时读取 token
agent-node --alias my-agent --url http://hub:9200

# token 来源（优先级从高到低）：
# 1. 环境变量 COMMHUB_TOKEN
# 2. 节点配置 .anet/nodes/<name>/config.json → token
# 3. 全局配置 ~/.anet/config.json → token
```

**认证链路：**
```
agent-node 发 MCP 请求
  → Header: Authorization: Bearer atok_xxx
  → CommHub Server resolveToken(atok_xxx)
    → 查 api_tokens 表 → 得到 user_id + network_id
    → 注入 enforceNetworkId → 所有查询自动隔离
  → Agent 只能看到自己网络的数据
```

## 3. Token 设计

### 3.1 Token 类型

| 类型 | scope | 用途 | 创建方式 |
|------|-------|------|---------|
| **full** | 完整权限 | Dashboard 登录、CLI 操作 | 注册/登录自动生成 |
| **agent** | 仅 MCP 工具 | agent-node 连接 | `anet token create --scope agent` |
| **readonly** | 只读 REST | 监控/Dashboard 嵌入 | `anet token create --scope readonly` |

### 3.2 Token 生命周期

```
创建 → 使用中（last_used_at 更新）→ 过期/撤销

- full token: 不过期（除非手动撤销）
- agent token: 可选 --expires 7d
- readonly token: 可选 --expires 
```

### 3.3 每个 Token 绑定一个 Network

```
用户 A 有两个网络：dev 和 prod
  → token-1 (atok_abc): user=A, network=dev, scope=full
  → token-2 (atok_def): user=A, network=prod, scope=agent
  
agent-node 用 token-2 启动 → 只能访问 prod 网络的数据
```

## 4. 网络权限模型

### 4.1 核心问题：谁能读？谁能写？

```
┌───────────────────────────────────────────────┐
│  Network "my-project"  (owner: Vincent)       │
│                                               │
│  访问控制：                                    │
│  ┌─────────────┬──────┬──────┬──────────────┐ │
│  │ Token Scope │ 读   │ 写   │ 管理         │ │
│  ├─────────────┼──────┼──────┼──────────────┤ │
│  │ full        │ ✅   │ ✅   │ ✅ 删除/改名 │ │
│  │ agent       │ ✅   │ ✅   │ ❌           │ │
│  │ readonly    │ ✅   │ ❌   │ ❌           │ │
│  │ 无 token    │ ❌   │ ❌   │ ❌           │ │
│  └─────────────┴──────┴──────┴──────────────┘ │
│                                               │
│  读 = get_inbox / get_all_status / list_tasks │
│  写 = send_task / send_reply / report_status  │
│  管理 = 网络 rename/delete + token 管理       │
└───────────────────────────────────────────────┘
```

### 4.2 Token 申请闭环

```
场景：Vincent 想让同事小明的 Agent 加入网络

1. Vincent 登录 Dashboard（或 CLI）
   anet token create my-agent-token --scope agent
   → 返回: atok_abc123...

2. Vincent 把 token 给小明（微信/邮件/文档）

3. 小明配置 agent-node
   ~/.anet/config.json:
   { "hub": "https://hub.sleep2agi.com", "token": "atok_abc123..." }
   
   或环境变量：
   COMMHUB_TOKEN=atok_abc123... agent-node --alias xiaoming-bot

4. 小明的 Agent 启动 → 自动绑定到 Vincent 的网络
   → 只能看到该网络的 agents / tasks
   → 可以收发任务（agent scope）
   → 不能删网络 / 管理 token
```

### 4.3 官方免费网络（P2 公网）

```
场景：用户想快速体验，不想自部署

1. 用户安装 anet
   npm i -g @sleep2agi/agent-network @sleep2agi/agent-node

2. 连接官方 hub
   anet init --hub https://hub.sleep2agi.com
   anet register
   → 自动创建 default 网络 + full token
   → 14 天免费试用

3. 创建 agent
   anet create my-agent --runtime codex-sdk
   anet start my-agent

整个流程 3 分钟，零服务器配置。
```

## 5. 网络成员模型（P3 扩展）

### 5.1 当前（V3）：单用户所有

```
networks 表:
  network_id | network_name | owner_id
  
→ 只有 owner 能操作网络
→ 简单，够用
```

### 5.2 未来（V4）：多成员协作

```sql
-- 新增 network_members 表
CREATE TABLE network_members (
  network_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT DEFAULT 'member',  -- owner | admin | member | viewer
  joined_at  TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (network_id, user_id)
);
```

```
Network "production"
  ├── owner: Vincent (全部权限)
  ├── admin: 运维组 (管理 agent，不能删网络)
  ├── member: 开发组 (发任务，看状态)
  └── viewer: 监控组 (只读)
```

**暂不实现，V3 够用。** 但数据库设计已预留扩展空间。

## 5. 安全要点

### 5.1 已实现 ✅
- 密码 SHA-256 哈希（加盐 "anet:"）
- Token 哈希存储（不存明文）
- server-enforced network_id（token 绑定，不信任客户端）
- rate limit: 注册 30/min, 登录 10/min
- 审计日志: 所有操作记录

### 5.2 建议增强（P2）
- [ ] bcrypt 替代 SHA-256（更安全）
- [ ] JWT refresh token（短期 access + 长期 refresh）
- [ ] OAuth Google/GitHub 登录
- [ ] 2FA (TOTP)
- [ ] Token IP 白名单

## 6. Dashboard 后台页面清单

| 页面 | 状态 | 对接 API |
|------|------|---------|
| 登录/注册 | ✅ | POST /api/auth/login, /register |
| 首页仪表盘 | ✅ | GET /api/stats, /api/status |
| Agent 拓扑 | ✅ | GET /api/status (SSE 实时) |
| 任务列表 | ✅ | GET /api/tasks |
| 消息流 | ✅ | GET /api/messages |
| 审计日志 | ✅ | GET /api/audit-log |
| 用户设置 | ✅ | GET/PUT /api/auth/me |
| License | ✅ | GET /api/license |
| Token 管理 | ❌ TODO | GET/POST/DELETE /api/auth/tokens |
| 改密码 | ❌ TODO | POST /api/auth/password |
| 网络管理 | ❌ TODO | GET/POST/PUT/DELETE /api/networks |
| 用户管理(admin) | ❌ TODO | GET /api/users |

## 7. agent-node 改进建议

### 7.1 当前问题
- agent-node 用全局 token，没有区分 agent 专用 token
- 启动时不验证 token 是否有效
- 没有显示当前绑定的网络

### 7.2 改进方案

```bash
# 改进后的 agent-node 启动
agent-node --alias solver-1

# 启动输出：
# ┌─────────────────────────────────┐
# │ Agent Node: solver-1            │
# │ Hub:    http://hub:9200         │
# │ User:   vincent                 │
# │ Network: production (net_xxx)   │
# │ Token:  atok_abc...  (agent)    │
# │ Runtime: codex-sdk (GPT-5.4)   │
# └─────────────────────────────────┘
```

**启动时验证 token：**
```
1. 调 /api/auth/me (验证 token 有效)
2. 显示用户名 + 网络名
3. token 无效 → 提示 "anet login" 
```

## 8. 实施优先级

| 优先级 | 任务 | 工作量 |
|--------|------|--------|
| **P0** | agent-node 启动显示用户+网络 | 0.5h |
| **P0** | agent-node 启动验证 token | 0.5h |
| **P1** | Dashboard Token 管理页 | N站马 1轮 |
| **P1** | Dashboard 改密码 | N站马 0.5轮 |
| **P1** | Dashboard 网络管理 | N站马 1轮 |
| **P2** | Token scope (agent/readonly) | 2h |
| **P2** | bcrypt 密码哈希 | 1h |
| **P2** | OAuth Google 登录 | 4h |
| **P3** | 网络多成员 | 1天 |

---

*通信龙 2026-04-11 设计，待 Vincent review*
