# 更新日志

## v1.0.0-preview.25 (2026-04-11)

### PostgreSQL + Adapter Architecture

**新功能**：
- **PostgreSQL 支持**：`DATABASE_URL=postgres://...` 启用 PostgreSQL（SQLite 仍为默认）
- **DbAdapter 接口**：统一数据库抽象层（SQLiteAdapter + PgAdapter）
- **SQL 自动翻译器**：`sqliteToPostgres()` 处理 datetime->NOW、?N->$N、AUTOINCREMENT->SERIAL
- **34 个 CLI 命令**：新增 passwd、token (create/ls/revoke)、network (info/rename/delete)、demo、config、license、activate、hub start
- **17 个 REST 端点**：新增 PUT /api/networks/:id、DELETE /api/networks/:id、POST /api/auth/password、token CRUD
- **一键 Demo**：`bash examples/demo-one-click.sh` -- 60 秒自动化演示
- **createAdapter() 工厂**：环境驱动的数据库选择

**架构改进**：
- 全部 85+ 个 `db.query()` 调用迁移到 adapter 方法（`db.get()`、`db.all()`、`db.run()`）
- 全部 7 个手动 `BEGIN/COMMIT/ROLLBACK` 事务转换为 `db.transaction()`
- 零原始数据库访问 -- 所有代码通过 `DbAdapter` 接口
- SQL 翻译器处理 4 个源文件中的 161 个 SQL 片段

**测试**：
- 200 个 Docker E2E 测试（137 基础 + 25 认证 + 22 网络 + 16 配置）
- 19 个 adapter 专项 E2E 测试
- 10 个 SQL 翻译器单元测试

---

## v1.0.0-preview (2026-04-10)

### Agent Network V3 -- Multi-Network + Commercial Ready

**新功能**：
- **多网络支持**：创建隔离的网络，每个有独立的 nodes/tasks/sessions
- **用户系统**：用户名+密码注册/登录、API Token 认证
- **试用授权**：14 天免费试用，授权码激活 Pro
- **39 个 CLI 命令**：quickstart、login、register、passwd、token、network (create/ls/use/info/rename/delete)、status、tasks、doctor、info、logs、demo、config、license、activate、hub start...
- **18 个 MCP 工具**：send_task、send_reply、retry_task、cancel_task、reassign_task、list_tasks、get_task...
- **17 个 REST 端点**：/api/auth/*、/api/networks/*、/api/tasks、/api/nodes、/api/stats、/api/audit-log、/api/license...
- **2 种 AI Runtime**：codex-sdk (GPT-5.5)、claude-agent-sdk (Claude / MiniMax / OpenAI 兼容)
- **审计日志**：所有用户操作 + 任务状态变更记录
- **速率限制**：注册 30/min、登录 10/min per IP

**安全**：
- MCP/SSE/WebSocket 认证
- Server 端强制 network_id（token 绑定，客户端不可覆盖）
- SQL 注入修复（全部参数化查询）
- 网络所有权检查（跨用户访问 403）
- 密码哈希（SHA-256）
- localhost 免速率限制（开发/测试）

**数据库（13 张表）**：
sessions、inbox、tasks、nodes、completions、task_events、users、networks、api_tokens、audit_log、licenses、network_members、network_invites

**测试（200 个回归测试）**：
- 基础 E2E：137 个测试（节点生命周期、消息生命周期、认证、授权、SSE、并发）
- 认证套件：25 个测试（注册、登录、token、profile、密码、审计、速率限制）
- 网络套件：22 个测试（CRUD、隔离、所有权、重命名、删除、跨用户）
- 配置优先级：16 个测试（CLI > env > project > global）
- 真实 AI：Codex GPT-5.5 + MiniMax (Anthropic API) 验证
- 10-agent 成语接龙（混合 codex + minimax）

**npm 包**：
- @sleep2agi/agent-network (anet CLI)
- @sleep2agi/agent-node (Agent 运行时)
- @sleep2agi/commhub-server (通信中枢)

---

## v0.x (2026-03 ~ 2026-04-09) -- Pre-V3

### 核心功能建设

- **CommHub Server**：基于 MCP + SSE 的通信中枢
- **agent-node**：双引擎 Runtime（Claude + Codex）
- **anet CLI**：create / start / resume / channel 等基础命令
- **Dashboard**：基础版本
- **消息类型**：task / reply / message / ack 四种类型区分
- **Channel 插件**：Claude Code 接入 CommHub

### 早期里程碑

| 版本 | 日期 | 内容 |
|------|------|------|
| v0.1 | 2026-03 初 | 基础 CommHub + SSE |
| v0.3 | 2026-03 中 | agent-node 双引擎 |
| v0.5 | 2026-03 末 | anet CLI + Channel |
| v0.7 | 2026-04 初 | Dashboard + 消息类型 |
| v0.9 | 2026-04-09 | 多模型支持（MiniMax、书生） |

---

## 未来规划

### V3.14 -- 权限增强
- MCP 写操作检查网络角色
- Token scope (full/agent/readonly) 完整实现
- Dashboard 按角色控制按钮可见性

### V3.15 -- 公开网络
- 网络 visibility 设置
- 公开网络自动 viewer 加入
- member 申请 + owner 审批流

### V4.0 -- 企业功能
- bcrypt 密码哈希
- 可选 PostgreSQL 后端（已支持）
- SSO 集成
- Webhook 回调
- 任务调度（定时任务）
