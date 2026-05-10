# V3 Multi-Network + User System Design

## 概念模型

```
User (人类用户)
├── 拥有多个 Network
│   ├── Network A "生产网络"
│   │   ├── Node: 指挥室 (claude-code)
│   │   ├── Node: SDK马 (codex-sdk)
│   │   └── Node: 通信牛 (codex-sdk)
│   │
│   └── Network B "测试网络"
│       ├── Node: test-agent-1
│       └── Node: test-agent-2
│
└── API Token (用于 CLI/Agent 认证)
```

## 命名: "网络" (Network)

> 不用"域"(domain) — 容易和 DNS/网络域名混淆
> 用 "Network" — 直觉上就是 Agent 组网

## 数据库 Schema (V3)

### users 表
```sql
CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,         -- u_xxxxxxxx
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email         TEXT,
  display_name  TEXT,
  role          TEXT DEFAULT 'user',       -- admin/user
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
```

### networks 表
```sql
CREATE TABLE networks (
  network_id    TEXT PRIMARY KEY,         -- net_xxxxxxxx
  network_name  TEXT NOT NULL,
  owner_id      TEXT NOT NULL REFERENCES users(user_id),
  description   TEXT,
  settings      TEXT,                     -- JSON: max_nodes, etc.
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(owner_id, network_name)
);
```

### api_tokens 表 (替代 COMMHUB_AUTH_TOKEN)
```sql
CREATE TABLE api_tokens (
  token_id      TEXT PRIMARY KEY,         -- tok_xxxxxxxx
  token_hash    TEXT NOT NULL,            -- SHA-256 of actual token
  user_id       TEXT NOT NULL REFERENCES users(user_id),
  network_id    TEXT REFERENCES networks(network_id),  -- NULL = all networks
  name          TEXT NOT NULL,            -- "CLI token" / "agent-node token"
  scope         TEXT DEFAULT 'full',      -- full/read/agent
  expires_at    TEXT,
  last_used_at  TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
```

### 现有表改造

**sessions**: 加 `network_id TEXT REFERENCES networks(network_id)`
**nodes**: 加 `network_id TEXT REFERENCES networks(network_id)`
**tasks**: 加 `network_id TEXT`
**inbox**: 加 `network_id TEXT`
**task_events**: 加 `network_id TEXT`

所有查询加 `WHERE network_id = ?` 过滤。

## API 认证改造

### 当前
```
Authorization: Bearer <COMMHUB_AUTH_TOKEN>
```

### V3
```
Authorization: Bearer <api_token>
```

Server 从 token → user_id → network_id 路由。

### CLI 登录
```bash
anet login                    # 交互式: username + password → 获取 token
anet login --token <token>    # 直接用 token
anet logout

# token 存在 ~/.anet/config.json 的 token 字段
```

### Dashboard 登录
```
POST /api/auth/login   { username, password } → { token, user }
POST /api/auth/register { username, password, email } → { user }
GET  /api/auth/me      Authorization: Bearer <token> → { user, networks }
```

## CLI 网络管理

```bash
anet network create "生产网络"           # 创建网络
anet network ls                          # 列出我的网络
anet network use "生产网络"              # 切换当前网络
anet network info                        # 当前网络详情
anet network delete "测试网络" --force   # 删除

# 网络 ID 存在 ~/.anet/config.json 的 network_id 字段
# 所有后续命令 (create/start/ls/tasks) 都在当前网络下操作
```

## REST API 改造

所有端点加 `/api/v3/` 前缀，保留 `/api/` 向后兼容。

```
POST /api/v3/auth/login
POST /api/v3/auth/register
GET  /api/v3/auth/me

GET  /api/v3/networks
POST /api/v3/networks
GET  /api/v3/networks/:id

GET  /api/v3/networks/:id/nodes
GET  /api/v3/networks/:id/tasks
GET  /api/v3/networks/:id/sessions
GET  /api/v3/networks/:id/stats
```

## PostgreSQL 支持

使用 adapter 模式:

```typescript
interface DbAdapter {
  run(sql: string, params?: any[]): { changes: number };
  query<T>(sql: string): { get(...params: any[]): T | null; all(...params: any[]): T[] };
  exec(sql: string): void;
}

// SQLite adapter (default, zero-config)
class SqliteAdapter implements DbAdapter { ... }

// PostgreSQL adapter (for production scale)
class PgAdapter implements DbAdapter { ... }

// 选择:
// COMMHUB_DB=sqlite:~/.commhub/commhub.db  (default)
// COMMHUB_DB=postgres://user:pass@host:5432/commhub
```

## 迭代计划

### V3.0: 用户系统 (Sprint 1)
1. users 表 + 注册/登录 API
2. api_tokens 表 + token 认证
3. anet login/logout CLI
4. Dashboard 登录页重写
5. Docker E2E 测试

### V3.1: 多网络 (Sprint 2)
1. networks 表 + CRUD API
2. 现有表加 network_id
3. anet network create/ls/use CLI
4. 查询全部加网络过滤
5. Dashboard 网络切换

### V3.2: PostgreSQL (Sprint 3)
1. DbAdapter 抽象层
2. PostgreSQL adapter
3. 迁移脚本
4. Docker Compose (server + pg)
5. 双数据库 E2E 测试

### V3.3: 代码质量 (Sprint 4)
1. 清理无用代码/文档
2. agent-node 模块拆分
3. 统一日志格式
4. README 对齐功能
5. 所有维度 ≥ 9 → 发 v1.0.0
