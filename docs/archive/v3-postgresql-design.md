# V3 PostgreSQL + SQLite Dual Support Design（已搁置）

> **⚠️ 本设计已搁置（2026-05-12 更新）**
>
> 本文写于 V3 早期（2026-03 ~ 04），目标是 CommHub Server 同时支持 SQLite 和 PostgreSQL，配合"官方托管"场景。**自从 2026-04 产品方向转向"纯本地 + SQLite only + 不做官方托管"以来，PostgreSQL 支持已从 v0.8/v0.9 路线图中移除。**
>
> **当前状态**：
> - SQLite WAL 模式是**唯一**支持的存储后端（v0.8.2）
> - `db-adapter.ts` 接口和 PG adapter 代码已存在但未启用
> - 没有计划在未来短期内 ship PostgreSQL；如有强需求，开 GitHub Issue 讨论
>
> 本文保留为**历史归档**，方便理解 codebase 中 adapter 接口的设计意图。**新用户和绝大多数自部署场景请用默认的 SQLite。**

## 目标（历史，已搁置）

CommHub Server 同时支持 SQLite (开发/自部署) 和 PostgreSQL (生产/托管)。

## Adapter 模式

```typescript
// db-adapter.ts
export interface DbAdapter {
  run(sql: string, params?: any[]): { changes: number };
  get<T>(sql: string, ...params: any[]): T | null;
  all<T>(sql: string, ...params: any[]): T[];
  exec(sql: string): void;
  transaction<T>(fn: () => T): T;
  close(): void;
}
```

## 选择逻辑

```
COMMHUB_DB=sqlite:~/.commhub/commhub.db   (默认，零配置)
COMMHUB_DB=postgres://user:pass@host:5432/commhub
```

解析 URL scheme 选择 adapter:
- `sqlite:` 或无前缀 → SqliteAdapter (bun:sqlite)
- `postgres://` → PgAdapter (postgres.js 或 bun:sql)

## SQL 兼容性

两种数据库的 SQL 差异需要处理:

| Feature | SQLite | PostgreSQL |
|---------|--------|-----------|
| Auto increment | INTEGER PRIMARY KEY AUTOINCREMENT | SERIAL / GENERATED |
| Datetime | datetime('now') | NOW() |
| Datetime add | datetime('now', '+1 hour') | NOW() + INTERVAL '1 hour' |
| Boolean | INTEGER 0/1 | BOOLEAN |
| UPSERT | INSERT ... ON CONFLICT DO UPDATE | INSERT ... ON CONFLICT DO UPDATE (相同) |
| WAL | PRAGMA journal_mode=WAL | 不需要 |
| Busy timeout | PRAGMA busy_timeout | 连接池处理 |

### 策略: SQL Template

```typescript
const sql = {
  now: adapter === 'pg' ? 'NOW()' : "datetime('now')",
  addSeconds: (col: string, seconds: number) =>
    adapter === 'pg'
      ? `${col} + INTERVAL '${seconds} seconds'`
      : `datetime(${col}, '+${seconds} seconds')`,
  autoId: adapter === 'pg' ? 'SERIAL PRIMARY KEY' : 'INTEGER PRIMARY KEY AUTOINCREMENT',
};
```

## 实施计划

### Phase 1: 抽象层 (本轮)
1. 创建 `db-adapter.ts` 接口
2. 实现 `SqliteAdapter` (包装现有 bun:sqlite)
3. 用现有代码验证接口正确
4. 不改任何功能，纯重构

### Phase 2: PostgreSQL (下轮)
1. 实现 `PgAdapter` (用 postgres.js)
2. Schema 迁移脚本 (CREATE TABLE IF NOT EXISTS)
3. Docker Compose: server + postgres
4. 双数据库 E2E 测试

### Phase 3: 切换 (再下轮)
1. 官方托管网络用 PostgreSQL
2. 用户自部署默认 SQLite
3. 数据迁移工具 (sqlite → pg)

## 风险

1. **SQL 差异**: datetime 函数是最大差异点，需要 template
2. **事务语义**: SQLite 是文件锁，PG 是行级锁，并发行为不同
3. **测试覆盖**: 需要两套 E2E，Docker Compose 测 PG
4. **Bun 兼容**: bun:sql 对 PG 的支持可能有限，可能需要 postgres.js

## 不做

- 不做 ORM (太重)
- 不做自动迁移 (手动 CREATE TABLE IF NOT EXISTS)
- 不支持 MySQL (没需求)
