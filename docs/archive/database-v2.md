# V2 数据库表设计

> 状态：草稿 | 日期：2026-04-10 | 作者：SDK马

---

## 现有表（V1）

```
sessions    (16 列) — node 注册 + 状态 + 当前任务
inbox       (9 列)  — 消息队列
completions (7 列)  — 任务完成记录
```

## V2 表一览

| 表 | 优先级 | 说明 |
|----|--------|------|
| nodes | P0 | 节点注册（替代 sessions 的注册部分） |
| sessions | P0 | 运行时会话（关联 node） |
| tasks | P0 | 任务（替代 inbox 的 task 部分） |
| task_events | P1 | 任务状态变更日志 |
| messages | P0 | 非任务消息（替代 inbox 的 message 部分） |
| users | P1 | 用户账号 |
| projects | P1 | 项目/工作区 |

---

## P0 表设计

### nodes

节点的持久身份。一个 node 可以多次启停（多个 session）。

```sql
CREATE TABLE nodes (
  node_id       TEXT PRIMARY KEY,          -- 'n_xxxxxxxx'，不可变
  node_name     TEXT NOT NULL UNIQUE,       -- 显示名 / CommHub alias
  runtime       TEXT NOT NULL DEFAULT 'claude-code-cli',
                                           -- claude-code-cli / codex-sdk / claude-agent-sdk
  model         TEXT,                       -- gpt-5.4 / MiniMax-M2.7 / claude-sonnet-4-6
  project_dir   TEXT,                       -- 工作目录
  server        TEXT,                       -- 机器 hostname
  config_path   TEXT,                       -- .anet/nodes/<id>/config.json 路径
  channels      TEXT,                       -- JSON: ["server:commhub", "telegram"]
  status        TEXT NOT NULL DEFAULT 'offline',
                                           -- created / online / offline
  last_seen_at  TEXT,                       -- 最后心跳时间
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_nodes_name ON nodes(node_name);
CREATE INDEX idx_nodes_status ON nodes(status);
CREATE INDEX idx_nodes_server ON nodes(server);
```

**和旧 sessions 表的映射**:
| V1 sessions | V2 nodes |
|-------------|----------|
| resume_id | node_id（改用 sdk-${node_id}） |
| alias | node_name |
| agent | runtime |
| project_dir | project_dir |
| server + hostname | server |
| status | status |
| registered_at | created_at |
| updated_at | last_seen_at / updated_at |
| tmux_name / ip / version | 去掉或移到 sessions |

### sessions

每次启动的运行时会话。一个 node 可以有多个 session（历史）。

```sql
CREATE TABLE sessions (
  session_id    TEXT PRIMARY KEY,          -- Claude session UUID / Codex thread ID
  node_id       TEXT NOT NULL REFERENCES nodes(node_id),
  runtime       TEXT NOT NULL,             -- 冗余，方便查询
  status        TEXT NOT NULL DEFAULT 'active',
                                           -- active / ended / crashed
  tmux_name     TEXT,                      -- tmux session 名
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT,
  metadata      TEXT                       -- JSON: { model, tools, ... }
);

CREATE INDEX idx_sessions_node ON sessions(node_id);
CREATE INDEX idx_sessions_status ON sessions(status);
```

**和旧表的关系**: 旧 sessions 表拆成 nodes + sessions 两张表。

### tasks

正式任务，有完整生命周期。

```sql
CREATE TABLE tasks (
  task_id         TEXT PRIMARY KEY,        -- 't_xxxxxxxx' 或 UUID
  from_node_id    TEXT,                    -- 发送方 node_id（NULL = 外部/API）
  from_name       TEXT NOT NULL,           -- 发送方显示名
  to_node_id      TEXT,                    -- 接收方 node_id
  to_name         TEXT NOT NULL,           -- 接收方显示名
  priority        TEXT NOT NULL DEFAULT 'normal',
                                           -- high / normal / low
  status          TEXT NOT NULL DEFAULT 'created',
                                           -- created / delivered / acked / running / replied / closed / timeout / failed
  content         TEXT NOT NULL,            -- 任务内容
  result          TEXT,                     -- 回复内容
  reply_to        TEXT,                     -- 关联的上游 task_id（子任务）
  requires_response TEXT DEFAULT 'reply',   -- none / ack / reply
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at    TEXT,
  started_at      TEXT,
  completed_at    TEXT,
  expires_at      TEXT                      -- 自动过期时间
);

CREATE INDEX idx_tasks_to ON tasks(to_name);
CREATE INDEX idx_tasks_from ON tasks(from_name);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_created ON tasks(created_at);
```

**和旧 inbox 表的映射（type=task 部分）**:
| V1 inbox | V2 tasks |
|----------|----------|
| id | task_id |
| session_name | to_name |
| from_session | from_name |
| content | content |
| priority | priority |
| acked | status (delivered → acked) |
| created_at | created_at |
| — | result（旧 completions.result） |
| — | status 状态机 |

### messages

非任务消息（聊天/通知/回复），不触发 think。

```sql
CREATE TABLE messages (
  message_id    TEXT PRIMARY KEY,          -- UUID
  type          TEXT NOT NULL DEFAULT 'message',
                                           -- message / reply / ack / broadcast
  from_node_id  TEXT,
  from_name     TEXT NOT NULL,
  to_node_id    TEXT,
  to_name       TEXT NOT NULL,
  content       TEXT NOT NULL,
  in_reply_to   TEXT,                      -- 关联的 task_id 或 message_id
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_messages_to ON messages(to_name);
CREATE INDEX idx_messages_type ON messages(type);
CREATE INDEX idx_messages_reply ON messages(in_reply_to);
```

**和旧 inbox 表的映射（type=message 部分）**:
| V1 inbox | V2 messages |
|----------|-------------|
| id | message_id |
| session_name | to_name |
| from_session | from_name |
| type (message/broadcast) | type |
| content | content |

---

## P1 表设计

### task_events

任务状态变更审计日志。

```sql
CREATE TABLE task_events (
  event_id      TEXT PRIMARY KEY,          -- UUID
  task_id       TEXT NOT NULL REFERENCES tasks(task_id),
  event_type    TEXT NOT NULL,             -- created / delivered / acked / started / replied / closed / failed / timeout
  actor         TEXT,                      -- 谁触发的（node_name 或 system）
  detail        TEXT,                      -- JSON: 附加信息
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_task_events_task ON task_events(task_id);
CREATE INDEX idx_task_events_type ON task_events(event_type);
```

### users

```sql
CREATE TABLE users (
  user_id       TEXT PRIMARY KEY,          -- UUID
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'viewer',
                                           -- admin / operator / viewer
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### projects

```sql
CREATE TABLE projects (
  project_id    TEXT PRIMARY KEY,          -- UUID
  name          TEXT NOT NULL UNIQUE,
  owner_id      TEXT REFERENCES users(user_id),
  hub_url       TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- nodes 加 project_id 外键（ALTER TABLE）
-- tasks/messages 加 project_id（可选，按需）
```

---

## 迁移方案

### 阶段 1：加列不加表（P0 过渡）

不建表，在现有三张表上加列：

```sql
-- sessions 表加列
ALTER TABLE sessions ADD COLUMN node_id TEXT;
ALTER TABLE sessions ADD COLUMN session_id TEXT;
ALTER TABLE sessions ADD COLUMN config_path TEXT;
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;

-- inbox 表加列
ALTER TABLE inbox ADD COLUMN in_reply_to TEXT;
ALTER TABLE inbox ADD COLUMN requires_response TEXT DEFAULT 'reply';
ALTER TABLE inbox ADD COLUMN expires_at TEXT;
ALTER TABLE inbox ADD COLUMN result TEXT;

-- 索引
CREATE INDEX IF NOT EXISTS idx_inbox_type ON inbox(type);
CREATE INDEX IF NOT EXISTS idx_inbox_from ON inbox(from_session);
```

**好处**: 不改表名，现有代码全部兼容。新字段可选，旧代码不写也不报错。

### 阶段 2：新旧表并存（P1）

创建 V2 新表，写入时双写（旧表 + 新表），读取逐步切到新表。

```
写: report_status → 写 sessions（旧）+ 写 nodes（新）
写: send_task → 写 inbox（旧）+ 写 tasks（新）
读: get_inbox → 从 inbox（旧）读
读: get_tasks → 从 tasks（新）读（Dashboard 用）
```

### 阶段 3：旧表只读（P2）

新代码全部读新表，旧表保留只读用于回溯。

### 阶段 4：删旧表（P3）

确认无依赖后删除 sessions / inbox / completions。

---

## 迁移脚本

```sql
-- 阶段 1 迁移脚本
-- 从 sessions 补 node_id（基于 alias 生成）

UPDATE sessions SET node_id = 'n_' || substr(hex(randomblob(4)), 1, 8)
WHERE node_id IS NULL;

-- 从 inbox 补 in_reply_to / requires_response
-- 旧数据 type=task → requires_response='reply'
-- 旧数据 type=message → requires_response='none'
UPDATE inbox SET requires_response = CASE
  WHEN type = 'task' THEN 'reply'
  ELSE 'none'
END WHERE requires_response IS NULL;
```

---

## 数据量估算

基于当前数据：
| 表 | 当前行数 | 增长速率 | 1 年后 |
|----|---------|---------|--------|
| nodes | 54 | ~2/周 | ~150 |
| sessions | — | ~10/天 | ~3600 |
| tasks | 2596 (inbox) | ~50/天 | ~20000 |
| messages | — | ~100/天 | ~36000 |
| task_events | — | ~200/天 | ~73000 |

SQLite 完全能撑，不需要换数据库。超过 100 万行再考虑分表或 PostgreSQL。

---

## 决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | P0 加列不加表 | 最小改动，兼容现有代码 |
| 2 | P1 双写并存 | 渐进迁移，不停机 |
| 3 | node_id 关联统一 | tasks/messages 用 node_id 而非 alias |
| 4 | tasks 和 messages 分表 | 语义不同，行为不同，分开管理 |
| 5 | completions 合入 tasks.result | 不再单独存 |
| 6 | task_events 审计 | P1 再加，P0 不需要 |
| 7 | SQLite 足够 | 当前数据量 + 1 年增长都在 SQLite 能力范围内 |

---

**请通信牛 review。文件路径: ~/agent-orchestra/docs/database-v2.md**
