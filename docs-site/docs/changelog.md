# 更新日志

## 2026-05-03 — `anet demo` 子命令族 + 多个 bug 修复

**版本同步**：anet@2.0.3-preview.4 / agent-node@2.2.0-preview.1 / dashboard@0.2.1-preview.1 / commhub-server@0.5.3-preview.0

### 新功能

- **`anet demo ls`** — 列出可用 demo
- **`anet demo debate`** — 一键 6-agent 辩论赛（主持人/正反 4 辩/评委）
  - `--topic "议题"` 议题（默认交互输入）
  - `--key sk-cp-xxx` MiniMax API key（默认 `$MINIMAX_KEY`）
  - `--quick` 4 步简化版（默认 9 步完整版）
  - `--keep` 跑完保留 6 个临时 agent（默认清掉）
  - `--out path.md` 实录路径
  - 角色个性独立 systemPrompt，跑完输出 markdown 实录
- **`anet demo monitor`**（旧 `anet demo --live` 别名保留）

### Bug 修复

- **anet CLI**：`--runtime http-api` 在 `node start` 时错走 claude CLI 分支 → 改为 spawn agent-node 并显式传 `--runtime`
- **agent-node**：HTTP runtime 加读 `ANTHROPIC_AUTH_TOKEN` env（之前只读 `ANTHROPIC_API_KEY`，导致 MiniMax 配置无法工作）
- **dashboard**：`useSSE` 钩子的 `connect` callback 依赖 `onEvent`，调用方传内联函数导致每次 render 都 reconnect → 用 ref 包装 `onEvent`（修复了"hub 收 1500+ admin SSE"的死循环）
- **hub-only.sh** 一键脚本重写：自动加 4G swap、配 sudoers NOPASSWD、enable-linger、systemd --user 自启（`AUTOSTART=1` 启用）

---

## 2026-04-30 — Parent Task Lineage + Auto-Chain Reply

**commhub-server@0.5.3-preview.0**

修复多 agent 链式调用断链问题：admin → 指挥室 → 主编 时，指挥室 reply 后会话结束，主编返回结果时找不到 admin。

- `tasks` 表加 `parent_task_id` 列 + `chainReplyToParent()` helper
- `send_task` 接受 `parent_task_id`（缺失时根据 caller 最近一个 open task 推断）
- `send_reply` / `report_completion` 自动沿 parent 链向上转发结果
- agent-node 自动注入 `CURRENT_TASK_ID` env，prompt 提示 LLM 必须传 `parent_task_id`

---

## 2026-04-26 — Hub Server Logs Page + V2 Lineage Foundation

**commhub-server@0.5.2-preview.0 / dashboard@0.2.1-preview.0 / anet@2.0.3-preview.1**

- Dashboard 新页面 `/server-logs`：实时查看 hub stdout（最近 N 行 ring buffer）
- REST `GET /api/server-logs`（admin 鉴权）
- Hub banner & `/health` 显示真实 published 版本号

---

## 2026-04-15 — V3 Stable: Multi-Network + User System + Trial License

**Agent Network V3 — Multi-Network + Commercial Ready**（commhub-server 0.5.x、anet 2.0.x）

主要交付：
- **多网络支持**：每个网络隔离 nodes/tasks/sessions
- **用户系统**：用户名+密码注册/登录、JWT、双 Token 体系（utok_ + ntok_）
- **试用授权**：14 天免费试用，授权码激活 Pro
- **39 CLI 命令**：quickstart、login、register、passwd、token、network (CRUD)、status、tasks、doctor、info、logs、demo、config、license、activate、hub start...
- **18 MCP 工具**：send_task/send_reply/retry_task/cancel_task/reassign_task/list_tasks/get_task/...
- **17 REST 端点**：/api/auth/* + /api/networks/* + /api/tasks + /api/nodes + /api/stats + /api/audit-log + /api/license + ...
- **3 种 Runtime**：claude-agent-sdk、codex-sdk、http-api（OpenAI/MiniMax 兼容）
- **审计日志** + **速率限制** + **PostgreSQL 支持**（DbAdapter 接口）

测试：200+ Docker E2E 回归测试覆盖（认证、网络、隔离、token CRUD、SSE 并发、审计）。

---

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
