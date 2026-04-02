# 跨服务器 Agent Session 通信方案

> 版本: v1.0
> 状态: 待落地执行
> 目标: 30+ Session 跨 4 台服务器的结构化通信

---

## 目录

1. [现状分析](#1-现状分析)
2. [目标架构](#2-目标架构)
3. [协议选型](#3-协议选型)
4. [Commander MCP Server 详细设计](#4-commander-mcp-server-详细设计)
5. [Dashboard 设计](#5-dashboard-设计)
6. [迁移路径](#6-迁移路径)
7. [tmux + Dashboard + Commander 配合](#7-三者配合)

---

## 1. 现状分析

### 1.1 规模

| 维度 | 数量 |
|------|------|
| 服务器 | 4 台（中心云服务器、Mac Mini、本地大内存机、项目专用机） |
| Claude Code Session | ~25 个 |
| Codex Session | ~5 个 |
| 模型种类 | 4 种（Claude Opus 4.6、MiniMax M2.7、Qwen 3.6、Codex GPT-5.4） |
| 通信方式 | tmux send-keys + capture-pane（SSH 嵌套） |

### 1.2 tmux 管理的痛点

经过 48 小时连续运维，确认以下致命问题：

| 痛点 | 严重程度 | 详情 |
|------|---------|------|
| **Shell/Agent 界面混淆** | 致命 | `$` 或 `>` 无法区分是 Shell 还是 Claude Code，发错命令可能执行危险 Shell 命令 |
| **send-keys 漏 Enter** | 高 | 命令打出来但没执行，最常见的操作失误 |
| **capture-pane 乱码** | 高 | ANSI 转义码 + Unicode + 进度条混在一起，正则解析极度脆弱 |
| **SSH 嵌套超时** | 高 | 跨服务器 SSH → tmux send-keys 链路长、超时频繁 |
| **无消息队列** | 中 | Agent 忙时发的命令直接丢失 |
| **无状态感知** | 中 | 只能靠截屏猜 Agent 当前状态 |
| **僵尸 Shell 堆积** | 中 | 过夜运行后堆积 60+ 个 Shell 窗口 |
| **FRP 隧道凌晨断连** | 中 | 2-4 点高频断连，Agent 失联 |

**实测可靠性：~20%。每 5 次操作约 4 次需要人工干预。**

### 1.3 效率对比数据

| 操作 | tmux 方式 | MCP 方式 |
|------|----------|---------|
| 下发一个代码审查任务 | 3-5 分钟（SSH + 判断窗口状态 + send-keys + 等 + capture-pane + 解析） | 30 秒（一次 MCP Tool 调用） |
| 查看 Agent 状态 | 1-2 分钟（SSH + capture-pane + 肉眼判断） | 即时（`get_all_status()` 返回 JSON） |
| 跨服务器派任务 | 5+ 分钟（SSH 嵌套 + 超时重试） | 即时（`send_task()` 通过 Commander 中转） |
| 批量通知所有 Agent | 不可能（逐个 send-keys） | 1 秒（`broadcast()`） |

---

## 2. 目标架构

### 2.1 架构全景

```
┌─────────────────────────────────────────────────────────────┐
│                     操作员（人）                              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ Hub Session  │  │  Dashboard   │  │  REST API / curl   │ │
│  │ (Claude Opus)│  │  (Web UI)    │  │  (脚本/自动化)     │ │
│  └──────┬───────┘  └──────┬───────┘  └─────────┬──────────┘ │
└─────────┼─────────────────┼────────────────────┼────────────┘
          │ MCP SSE         │ HTTP REST          │ HTTP REST
          │                 │                    │
     ┌────▼─────────────────▼────────────────────▼────┐
     │           Commander MCP Server                  │
     │           your-server:9200                      │
     │                                                 │
     │  ┌───────────┐  ┌─────────────┐  ┌──────────┐ │
     │  │  MCP SSE  │  │  HTTP REST  │  │  SQLite  │ │
     │  │  /sse     │  │  /api/*     │  │  (WAL)   │ │
     │  └─────┬─────┘  └─────────────┘  └──────────┘ │
     └────────┼───────────────────────────────────────┘
              │  30 条 SSE 持久连接
    ┌─────────┼─────────┬─────────┬─────────┐
    │         │         │         │         │
┌───▼───┐ ┌──▼────┐ ┌──▼────┐ ┌──▼────┐ ┌──▼────┐
│Claude │ │Claude │ │Claude │ │Codex  │ │Codex  │
│Code×9 │ │Code×6 │ │Code×4 │ │CLI×2  │ │CLI×1  │
│服务器A │ │服务器B │ │服务器C │ │服务器A │ │服务器B │
└───────┘ └───────┘ └───────┘ └───────┘ └───────┘
   │         │         │
   │ tmux    │ tmux    │ tmux   ← tmux 仍用于进程持久化
   │         │         │           不再用于通信
```

### 2.2 三层通信

| 层 | 用途 | 协议 |
|----|------|------|
| **MCP SSE** | Agent ↔ Commander 结构化通信 | MCP over SSE (持久连接) |
| **HTTP REST** | Dashboard + 脚本 ↔ Commander | 标准 HTTP JSON |
| **tmux** | 进程持久化 + 最后手段 fallback | tmux send-keys (仅限紧急) |

### 2.3 角色分工

| 角色 | 职责 | 通信方式 |
|------|------|---------|
| **Hub Session** | 指挥调度（只派活不干活） | MCP SSE 连 Commander |
| **子 Agent Session** | 执行具体任务 | MCP SSE 连 Commander |
| **Dashboard** | 可视化状态 + 交互控制 | HTTP REST 查 Commander |
| **操作员** | 最终决策 + 人工抽检 | 通过 Hub / Dashboard / curl |

---

## 3. 协议选型

### 3.1 候选协议

| 协议 | 提出者 | 定位 | 传输 |
|------|--------|------|------|
| **MCP** (Model Context Protocol) | Anthropic | LLM ↔ 工具 | stdio / Streamable HTTP / SSE |
| **A2A** (Agent-to-Agent Protocol) | Google | Agent ↔ Agent | JSON-RPC 2.0 + HTTP + SSE |
| **ACP** (Agent Communication Protocol) | BeeAI / IBM | 多 Agent 编排 | HTTP REST + SSE |

### 3.2 对比矩阵

| 维度 | MCP | A2A | ACP |
|------|-----|-----|-----|
| Claude Code 原生支持 | **原生** | 无 | 无 |
| Codex 原生支持 | **原生** | 无 | 无 |
| Agent 发现机制 | 手动配 URL | Agent Card (自动) | 注册中心 |
| 任务生命周期 | 无（同步调用） | 有 (submitted→done) | 有 (Run 状态机) |
| 生态成熟度 | 数千个 Server | 50+ 支持者 | 早期 |
| 我们需要适配 | **零成本** | 需自建客户端 | 需自建客户端 |

### 3.3 结论：纯 MCP

**用 MCP，不用 A2A，不用 ACP。**

原因：
1. **Claude Code 和 Codex 原生支持 MCP**——零适配，`settings.json` 加一行 URL 就连上
2. **我们的 30 个 Session 都是自己的**——不需要 A2A 的"Agent 发现"机制
3. **A2A 的任务生命周期确实更优雅**，但引入 A2A 意味着多一层协议、多一层 debug
4. **ACP 太早期**，社区和生态都不成熟

**等 Claude Code 原生支持 A2A 时再考虑升级。**

### 3.4 协议层次关系

```
应用层：Commander 调度逻辑
     │
协议层：MCP（工具调用 + 状态汇报）    ← 我们在这层
     │
传输层：SSE（持久连接）+ HTTP REST
     │
网络层：TCP/IP
```

A2A 和 ACP 是与 MCP 平行的协议层，解决不同问题。MCP 管"LLM 怎么调工具"，A2A 管"Agent 怎么互相找到对方"。我们的场景不需要"找"——地址写死就行。

---

## 4. Commander MCP Server 详细设计

### 4.1 技术栈

| 组件 | 选型 | 理由 |
|------|------|------|
| 运行时 | Bun 1.2+ | 原生 SQLite、TypeScript 直接运行、性能优秀 |
| 语言 | TypeScript | 类型安全、MCP SDK 原生支持 |
| MCP SDK | `@modelcontextprotocol/sdk` ^1.12 | 官方 SDK，SSE Transport 内置 |
| 数据库 | SQLite (`bun:sqlite`, WAL) | 单文件零配置、Bun 原生支持、30 Session 吞吐量绰绰有余 |
| 进程管理 | systemd | 崩溃自动重启、日志管理 |

### 4.2 项目结构

```
server/
├── src/
│   ├── index.ts              # 入口：Bun HTTP Server + MCP SSE
│   ├── tools.ts              # 9 个 MCP Tool 定义
│   └── db.ts                 # SQLite Schema + 辅助函数
├── package.json
├── tsconfig.json
└── CLAUDE.md                 # 项目说明
```

### 4.3 MCP Tools 完整 API

#### 子 Agent 工具（4 个）

**`report_status`** — 状态汇报（核心心跳）

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_name | string | 是 | Session 标识 |
| status | enum | 是 | `working` / `idle` / `blocked` / `error` / `waiting_input` |
| task | string | 否 | 当前任务描述 |
| output | string | 否 | 最近输出（最大 4000 字符） |
| score | number | 否 | 自评分 1-10 |
| progress | number | 否 | 进度 0-100 |
| server | string | 否 | 服务器标识（首次汇报时设置） |

返回：`{ ok, session_name, inbox_count }`

> 设计要点：返回 `inbox_count`，让 Agent 在汇报状态的同时知道有没有新任务。"汇报即拉取"模式。

**`report_completion`** — 任务完成汇报

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_name | string | 是 | Session 标识 |
| task | string | 是 | 完成的任务描述 |
| result | string | 是 | 结果摘要 |
| artifacts | string[] | 否 | 产出物链接（URL、文件路径） |
| score | number | 否 | 自评分 1-10 |
| duration_minutes | number | 否 | 耗时（分钟） |

**`get_inbox`** — 获取待办命令

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_name | string | 是 | Session 标识 |
| limit | number | 否 | 最多返回条数（默认 10） |

返回按优先级排序：high → normal → low。

**`ack_inbox`** — 确认收到命令

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_name | string | 是 | Session 标识 |
| message_id | string | 是 | 消息 ID |
| response | string | 否 | 回复内容 |

#### Hub 指挥工具（5 个）

**`get_all_status`** — 全局状态面板

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| filter_status | string | 否 | 按状态过滤 |
| filter_server | string | 否 | 按服务器过滤 |

返回所有 Session + 按状态分组汇总。10 分钟无心跳自动标记 `offline`。

**`get_session_status`** — 单 Session 详情

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_name | string | 是 | Session 标识 |

返回 Session 信息 + inbox 待办数 + 最近 5 条完成记录。

**`send_task`** — 下发任务

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| session_name | string | 是 | 目标 Session |
| task | string | 是 | 任务内容 |
| priority | enum | 否 | `high` / `normal`（默认）/ `low` |
| context | string | 否 | 附加上下文 |
| from_session | string | 否 | 来源 Session（默认 hub） |

返回 `session_status` + `message_id`。

**`broadcast`** — 群发消息

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message | string | 是 | 消息内容 |
| filter_server | string | 否 | 只发给特定服务器 |
| filter_status | string | 否 | 只发给特定状态的 Session |

**`get_completions`** — 获取完成记录

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| since | string | 否 | 起始时间（ISO 8601，默认 24 小时内） |
| session_name | string | 否 | 按 Session 过滤 |
| limit | number | 否 | 最大条数（默认 50） |

### 4.4 HTTP REST API

除 MCP SSE 外，Commander 同时暴露 HTTP REST 接口供 Dashboard 和脚本使用：

| 端点 | 方法 | 用途 |
|------|------|------|
| `/sse` | GET | MCP SSE 连接端点（Claude Code / Codex 用） |
| `/health` | GET | 健康检查（session 数、连接数、运行时长） |
| `/api/status` | GET | 所有 Session 状态（JSON） |
| `/api/task` | POST | 通过 REST 下发任务（JSON body: `{session_name, task, priority}`) |
| `/api/completions` | GET | 完成记录（支持 `?since=` 参数） |

REST API 让 Dashboard 无需 MCP 客户端就能查询和操控。

### 4.5 数据库 Schema

SQLite 文件位置：`~/.commander/commander.db`（WAL 模式）

```sql
-- Session 状态表（主表）
CREATE TABLE sessions (
  name          TEXT PRIMARY KEY,       -- Session 标识（如 "frontend-dev"）
  server        TEXT DEFAULT 'unknown', -- 服务器标识（如 "server-a"）
  status        TEXT DEFAULT 'offline', -- working/idle/blocked/error/offline
  task          TEXT,                   -- 当前任务描述
  output        TEXT,                   -- 最近输出（最大 4000 字符）
  progress      INTEGER DEFAULT 0,     -- 进度 0-100
  score         REAL,                  -- 自评分 1-10
  registered_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 消息收件箱（任务队列）
CREATE TABLE inbox (
  id            TEXT PRIMARY KEY,       -- UUID
  session_name  TEXT NOT NULL,          -- 目标 Session
  type          TEXT DEFAULT 'task',    -- task / broadcast
  priority      TEXT DEFAULT 'normal',  -- high / normal / low
  content       TEXT NOT NULL,          -- 任务内容
  context       TEXT,                   -- 附加上下文
  from_session  TEXT DEFAULT 'hub',     -- 来源
  acked         INTEGER DEFAULT 0,     -- 是否已确认
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_inbox_pending ON inbox(session_name, acked) WHERE acked = 0;

-- 任务完成记录
CREATE TABLE completions (
  id               TEXT PRIMARY KEY,    -- UUID
  session_name     TEXT NOT NULL,
  task             TEXT NOT NULL,       -- 完成的任务
  result           TEXT NOT NULL,       -- 结果摘要
  artifacts        TEXT,               -- JSON 数组：产出物链接
  score            REAL,               -- 自评分
  duration_minutes REAL,               -- 耗时
  completed_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### 4.6 部署方案

**步骤 1：安装 Bun**
```bash
curl -fsSL https://bun.sh/install | bash
```

**步骤 2：启动 Commander**
```bash
cd agent-orchestra/server
bun install
bun run start
# 输出：Commander MCP Server v0.1.0 running on port 9200
```

**步骤 3：systemd 持久化**
```ini
# /etc/systemd/system/commander.service
[Unit]
Description=Commander MCP Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/agent-orchestra/server
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=5
Environment=PORT=9200

[Install]
WantedBy=multi-user.target
```

```bash
systemctl enable --now commander
```

**步骤 4：防火墙**
```bash
# 只允许你的 Agent 服务器
iptables -A INPUT -p tcp --dport 9200 -s SERVER_A_IP -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -s SERVER_B_IP -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -s SERVER_C_IP -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -s SERVER_D_IP -j ACCEPT
iptables -A INPUT -p tcp --dport 9200 -j DROP
```

---

## 5. Dashboard 设计

### 5.1 定位

Dashboard 是 Commander 的可视化前端，操作员通过它查看全局状态和手动控制 Agent。

### 5.2 技术方案

| 选项 | 方案 | 优缺点 |
|------|------|--------|
| A | 静态 HTML + fetch 轮询 | 最简单，几个小时搞定，够用 |
| B | React + WebSocket | 实时性好，开发成本中等 |
| C | Grafana + SQLite 数据源 | 零代码，但定制性差 |

**推荐方案 A**（MVP 阶段）：一个 HTML 文件，每 5 秒 fetch `/api/status`，足够了。

### 5.3 Dashboard 页面设计

```
┌─────────────────────────────────────────────────────────┐
│  Commander Dashboard                    连接数: 28/30   │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌─ 服务器 A ──────────────────────────────────────────┐ │
│  │ ● hub         working  "巡查所有 session"   进度 60% │ │
│  │ ● frontend    idle                                   │ │
│  │ ● backend     working  "修复 API Bug"      进度 30% │ │
│  │ ● codex-1     working  "审查 PR #42"       进度 80% │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ 服务器 B ──────────────────────────────────────────┐ │
│  │ ● video-gen   working  "渲染第 12 集"      进度 45% │ │
│  │ ● ppt-gen     idle                                   │ │
│  │ ○ research    offline  (12 分钟无心跳)               │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ 快速操作 ──────────────────────────────────────────┐ │
│  │ Session: [frontend ▼]  任务: [___________] [派发]    │ │
│  │ 广播: [_____________________________] [发送]         │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌─ 最近完成 ──────────────────────────────────────────┐ │
│  │ 14:30 backend   "修复登录 Bug"          ✓ 用时 25m  │ │
│  │ 14:15 codex-1   "审查 PR #41"           ✓ 用时 2m   │ │
│  │ 13:50 video-gen "渲染第 11 集"          ✓ 用时 45m  │ │
│  └──────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 5.4 状态颜色

| 状态 | 颜色 | 含义 |
|------|------|------|
| `working` | 绿色 ● | 正在执行任务 |
| `idle` | 蓝色 ● | 空闲，可接任务 |
| `blocked` | 黄色 ● | 被阻塞，需要干预 |
| `error` | 红色 ● | 出错 |
| `offline` | 灰色 ○ | 10 分钟无心跳 |

### 5.5 交互操作

Dashboard 通过 REST API 实现交互：

```javascript
// 派发任务
fetch('/api/task', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    session_name: 'frontend',
    task: '修复登录页 CSS Bug',
    priority: 'high'
  })
});

// 查看状态
const res = await fetch('/api/status');
const { sessions } = await res.json();
```

---

## 6. 迁移路径

### Phase 1：今天（0 成本）

**目标**：本地工具用起来。

| 步骤 | 操作 | 耗时 |
|------|------|------|
| 1.1 | 确认 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` 已启用 | 1 分钟 |
| 1.2 | 代码审查改用 `/codex:review` 替代 tmux 派发 | 立即 |
| 1.3 | 高风险改动用 `/codex:adversarial-review` | 立即 |
| 1.4 | 本地并行任务用 Agent Teams（`--teammate-mode in-process`） | 立即 |

**验收标准**：本地代码审查不再用 tmux send-keys。

### Phase 2：本周（1-2 天）

**目标**：Commander 上线，30 个 Session 全部连上。

| 步骤 | 操作 | 耗时 |
|------|------|------|
| 2.1 | 在中心服务器部署 Commander：`cd server && bun install && bun run start` | 5 分钟 |
| 2.2 | 配置 systemd 持久化 | 10 分钟 |
| 2.3 | 配置防火墙（只允许 4 台服务器的 IP） | 5 分钟 |
| 2.4 | 服务器 A 的所有 Session `settings.json` 加 Commander URL | 10 分钟 |
| 2.5 | 服务器 B/C/D 的所有 Session 同样配置 | 20 分钟 |
| 2.6 | 每个项目的 CLAUDE.md 加入 Commander 通信规则 | 30 分钟 |
| 2.7 | Hub Session 测试：`get_all_status()` → `send_task()` → `get_completions()` | 15 分钟 |
| 2.8 | 端到端验证：Hub 派任务 → Agent 接收 → 执行 → 汇报完成 → Hub 查看结果 | 15 分钟 |

**验收标准**：`curl /health` 返回 `connections >= 20`，`get_all_status()` 能看到所有 Session。

### Phase 3：下周

**目标**：Dashboard 上线，完全退役 tmux 通信。

| 步骤 | 操作 | 耗时 |
|------|------|------|
| 3.1 | 开发 Dashboard 静态页（一个 HTML + CSS + JS） | 2 小时 |
| 3.2 | 部署 Dashboard（Commander 同域或 Nginx 反代） | 30 分钟 |
| 3.3 | Hub Session 巡查循环改用 Commander 工具（不再 tmux capture-pane） | 1 小时 |
| 3.4 | 移除所有 CLAUDE.md 中的 tmux send-keys 相关规则 | 30 分钟 |
| 3.5 | tmux 仅保留为进程持久化基础设施，不再用于通信 | - |

**验收标准**：连续运行 24 小时，零次 tmux send-keys 通信，所有任务通过 Commander 调度。

---

## 7. 三者配合

### 7.1 tmux 的新定位

tmux **不再用于通信**，仅用于：
- **进程持久化**：Claude Code 进程跑在 tmux 里，SSH 断开不丢失
- **紧急 fallback**：Commander 挂了时的最后手段
- **本地监控**：`tmux attach` 看实时输出

### 7.2 三者关系

```
┌────────────────────────────────────────────────┐
│ tmux                                            │
│ ┌──────────────────────────────────────────┐   │
│ │ Claude Code Session                       │   │
│ │                                           │   │
│ │ ┌─────────────────────────────────────┐   │   │
│ │ │ MCP SSE 连接到 Commander            │   │   │
│ │ │ - report_status (每个重要步骤后)     │   │   │
│ │ │ - get_inbox (有新任务时)             │   │   │
│ │ │ - report_completion (任务完成时)      │   │   │
│ │ └─────────────────────────────────────┘   │   │
│ └──────────────────────────────────────────┘   │
│                                                 │
│ tmux 只提供进程容器，不参与通信                    │
└────────────────────────────────────────────────┘

┌────────────────────────────────────────────────┐
│ Dashboard (Web UI)                              │
│                                                 │
│ 每 5 秒 fetch /api/status                       │
│ 操作员点击"派任务" → POST /api/task              │
│ 操作员看"完成记录" → GET /api/completions        │
│                                                 │
│ Dashboard 只读 + 简单写入，不参与 MCP 通信        │
└────────────────────────────────────────────────┘

┌────────────────────────────────────────────────┐
│ Commander MCP Server                            │
│                                                 │
│ 核心通信中枢：                                    │
│ - 接收 30 条 SSE 连接                            │
│ - 管理 sessions / inbox / completions           │
│ - MCP SSE 给 Agent 用                            │
│ - HTTP REST 给 Dashboard 和脚本用                │
│                                                 │
│ Commander 是唯一的通信枢纽                        │
└────────────────────────────────────────────────┘
```

### 7.3 操作场景示例

**场景 1：给某个 Session 派任务**

| 方式 | 操作 |
|------|------|
| Hub Session | `send_task(session_name="frontend", task="修 Bug", priority="high")` |
| Dashboard | 在界面选 session → 输入任务 → 点"派发" |
| curl 脚本 | `curl -X POST /api/task -d '{"session_name":"frontend","task":"修 Bug"}'` |
| tmux (紧急) | `tmux send-keys -t frontend "请修复登录 Bug" Enter`（不推荐） |

**场景 2：查看所有 Session 状态**

| 方式 | 操作 |
|------|------|
| Hub Session | `get_all_status()` |
| Dashboard | 打开网页，自动刷新 |
| curl | `curl /api/status \| jq` |
| tmux (旧方式) | 逐个 `tmux capture-pane`（不推荐，耗时 15+ 分钟） |

**场景 3：Commander 挂了**

1. systemd 5 秒后自动重启
2. 重启期间：Agent 的 SSE 连接断开，MCP 工具暂不可用
3. 重启后：Agent 重新连接，调 `report_status()` 恢复在线
4. 极端情况：回退到 tmux send-keys（最后手段）

---

## 附录：风险和缓解

| 风险 | 概率 | 缓解 |
|------|------|------|
| Commander 单点故障 | 中 | systemd 自动重启 + SQLite 崩溃安全 |
| SSE 连接断开 | 中 | Agent 侧自动重连（MCP SDK 内置） |
| SQLite 写竞争 | 低 | WAL 模式 + busy_timeout=5000ms |
| 网络分区 | 低 | 10 分钟离线检测 + 告警 |
| 中间人攻击 | 低 | 防火墙 IP 白名单（MVP），后续加 Token |
