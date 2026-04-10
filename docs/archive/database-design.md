# CommHub 数据库层设计 — SQLite + PostgreSQL

## 目标

CommHub Server 支持两种数据库，启动时选择：

```bash
anet server start                                          # 默认 SQLite
anet server start --db-type pg --db-url postgres://...     # PostgreSQL
```

## 当前状态

`server/src/db.ts` 直接用 `bun:sqlite`，SQL 查询散落在 `tools.ts` 和 `index.ts` 里。

## 设计方案

### 数据库抽象层

```
server/src/
├── db/
│   ├── interface.ts     ← 统一接口
│   ├── sqlite.ts        ← SQLite 实现（bun:sqlite）
│   └── pg.ts            ← PostgreSQL 实现（postgres.js）
├── tools.ts             ← 通过接口调用，不直接写 SQL
└── index.ts
```

### 接口定义（interface.ts）

```typescript
export interface CommHubDB {
  // Sessions
  upsertSession(data: SessionData): Promise<void>;
  getSession(alias: string): Promise<Session | null>;
  getAllSessions(): Promise<Session[]>;
  updateSessionStatus(alias: string, status: string): Promise<void>;
  markOfflineSessions(cutoffMinutes: number): Promise<void>;
  deleteOldSessions(days: number): Promise<void>;

  // Inbox
  insertInbox(msg: InboxMessage): Promise<string>;  // returns id
  getInbox(alias: string, limit: number): Promise<InboxMessage[]>;
  ackInbox(alias: string, messageId: string): Promise<void>;
  getInboxCount(alias: string): Promise<number>;

  // Completions
  insertCompletion(data: CompletionData): Promise<void>;
  getCompletions(since: string, limit: number): Promise<Completion[]>;

  // Lifecycle
  close(): Promise<void>;
}
```

### SQLite 实现（sqlite.ts）

基本不改，把当前 db.ts 的代码包装成 class：

```typescript
import { Database } from "bun:sqlite";

export class SQLiteDB implements CommHubDB {
  private db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.migrate();
  }

  private migrate() {
    // 现有建表 SQL
  }

  async upsertSession(data: SessionData) {
    this.db.run(`INSERT OR REPLACE INTO sessions ...`, [...]);
  }
  // ...
}
```

### PostgreSQL 实现（pg.ts）

```typescript
import postgres from "postgres";

export class PostgresDB implements CommHubDB {
  private sql: postgres.Sql;

  constructor(url: string) {
    this.sql = postgres(url);
  }

  async upsertSession(data: SessionData) {
    await this.sql`
      INSERT INTO sessions (resume_id, alias, status, ...)
      VALUES (${data.resumeId}, ${data.alias}, ${data.status}, ...)
      ON CONFLICT (resume_id) DO UPDATE SET ...
    `;
  }
  // ...
}
```

### SQL 差异处理

| 功能 | SQLite | PostgreSQL |
|------|--------|-----------|
| UPSERT | `INSERT OR REPLACE` | `INSERT ... ON CONFLICT DO UPDATE` |
| 时间 | `datetime('now')` | `NOW()` |
| 自增 | `INTEGER PRIMARY KEY` | `SERIAL` |
| JSON | 文本存储 | `JSONB` |
| 全文搜索 | FTS5 | `tsvector` |

大部分 SQL 兼容，少数用条件判断。

### 初始化（db/index.ts）

```typescript
export function createDB(type: string, url?: string): CommHubDB {
  if (type === "pg" && url) {
    return new PostgresDB(url);
  }
  return new SQLiteDB(url || `${HOME}/.commhub/commhub.db`);
}
```

### 环境变量 / CLI 参数

| 参数 | 环境变量 | 默认值 |
|------|---------|--------|
| `--db-type` | `COMMHUB_DB_TYPE` | `sqlite` |
| `--db-url` | `COMMHUB_DB_URL` / `DATABASE_URL` | `~/.commhub/commhub.db` |

PostgreSQL 也兼容 Vercel/Railway 等平台的 `DATABASE_URL` 环境变量。

## 表结构（PostgreSQL 版）

```sql
CREATE TABLE IF NOT EXISTS sessions (
  resume_id     TEXT PRIMARY KEY,
  alias         TEXT UNIQUE,
  tmux_name     TEXT,
  server        TEXT DEFAULT 'unknown',
  ip            TEXT,
  hostname      TEXT,
  agent         TEXT,
  project_dir   TEXT,
  version       TEXT,
  status        TEXT DEFAULT 'offline',
  task          TEXT,
  output        TEXT,
  progress      INTEGER DEFAULT 0,
  score         REAL,
  registered_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inbox (
  id            TEXT PRIMARY KEY,
  session_name  TEXT NOT NULL,
  type          TEXT DEFAULT 'task',
  priority      TEXT DEFAULT 'normal',
  content       TEXT NOT NULL,
  context       TEXT,
  from_session  TEXT DEFAULT 'hub',
  acked         INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbox_pending
  ON inbox(session_name, acked) WHERE acked = 0;

CREATE TABLE IF NOT EXISTS completions (
  id               TEXT PRIMARY KEY,
  session_name     TEXT NOT NULL,
  task             TEXT NOT NULL,
  result           TEXT NOT NULL,
  artifacts        TEXT,
  score            REAL,
  duration_minutes REAL,
  completed_at     TIMESTAMPTZ DEFAULT NOW()
);
```

## 迁移策略

1. 新建 `db/` 目录，写接口 + 两个实现
2. `tools.ts` 和 `index.ts` 改为调接口方法（不直接写 SQL）
3. 启动时根据 `--db-type` 选择实现
4. SQLite 行为完全不变（向后兼容）
5. PostgreSQL 新增，需要用户自己建库

## 依赖

| 包 | 用途 | 大小 |
|---|------|------|
| postgres | PostgreSQL 驱动（postgres.js） | ~50KB |

只在 `--db-type pg` 时动态 import，SQLite 用户不增加依赖。

## 工作量估算

| 步骤 | 工作量 |
|------|--------|
| interface.ts | 30min |
| sqlite.ts（重构现有代码） | 1h |
| pg.ts | 1h |
| tools.ts 改调接口 | 1h |
| index.ts 改调接口 | 30min |
| 测试 | 1h |
| **总计** | **~5h** |

## /api/messages 端点

REST API 新增 `/api/messages` 端点，用于 Dashboard 和外部系统查询 inbox 消息。

### 请求

```
GET /api/messages?alias=指挥室&limit=50&acked=0
```

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| alias | string | （必填） | 按 session alias 过滤 |
| limit | number | 50 | 返回条数 |
| acked | 0/1 | 不限 | 0=未确认，1=已确认，不传=全部 |
| since | string | 不限 | 起始时间（ISO 8601） |

### 响应

```json
{
  "ok": true,
  "messages": [
    {
      "id": "msg_xxx",
      "session_name": "指挥室",
      "type": "task",
      "priority": "normal",
      "content": "报告当前状态",
      "from_session": "hub",
      "acked": 0,
      "created_at": "2026-04-08T10:00:00Z"
    }
  ],
  "total": 3
}
```

### 对应 SQL 查询

```sql
-- SQLite
SELECT * FROM inbox
WHERE session_name = ?
  AND (? IS NULL OR acked = ?)
  AND (? IS NULL OR created_at >= ?)
ORDER BY created_at DESC
LIMIT ?;

-- PostgreSQL
SELECT * FROM inbox
WHERE session_name = $1
  AND ($2::int IS NULL OR acked = $2)
  AND ($3::timestamptz IS NULL OR created_at >= $3)
ORDER BY created_at DESC
LIMIT $4;
```

## 后续可选

- Vercel 部署支持（用 Neon/Supabase PostgreSQL）
- 数据库迁移工具（SQLite → PostgreSQL）
- 连接池配置
- 读写分离
