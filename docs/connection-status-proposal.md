# Agent 连接状态准确展示方案

> 日期: 2026-04-03
> 状态: 待 Vincent 确认后实施

---

## 1. 现状问题

读完 server 全部源码（index.ts / db.ts / push.ts / tools.ts），核心矛盾：**两套状态系统互不知道对方存在。**

| 系统 | 存储 | 数据 | 问题 |
|------|------|------|------|
| sessions 表 | SQLite | status/updated_at（agent 主动 report） | 10分钟超时才标 offline，滞后严重 |
| SSE clients Map | 内存 | alias → SSEClient[]（连接级） | 只有 /health 暴露，Dashboard 不用 |

具体场景：

1. **假在线**：Agent SSE 断了但 10 分钟内 → sessions 表仍显示 working
2. **状态矛盾**：Agent SSE 连着但没 report_status → /health 有连接但 sessions 表可能 offline
3. **幽灵 session**：改名后旧 alias 残留在 sessions 表，Dashboard 显示不存在的 agent

---

## 2. 三层状态模型

状态分为三个独立层次，各自有不同的检测手段和含义：

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: 服务器连接状态 (Infrastructure)                  │
│  SSH 能不能连上？能连上 = 能 tmux 兜底                       │
│                                                          │
│  ┌───────────────────────────────────────────────────┐   │
│  │  Layer 2: CommHub 通信状态 (Communication)          │   │
│  │  Agent ↔ CommHub 消息通道是否通                      │   │
│  │                                                    │   │
│  │  ┌─────────────────────────────────────────────┐  │   │
│  │  │  Layer 3: Agent Session 状态 (Application)   │  │   │
│  │  │  AI 进程是否在跑、在干什么                      │  │   │
│  │  └─────────────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

### Layer 1：服务器连接状态（SSH 可达性）

**检测方式**：CommHub Server 定期 SSH ping 各服务器

```typescript
// 每 60 秒检测一次
const SERVERS = [
  { name: "central",  host: "127.0.0.1",    port: 22 },
  { name: "mac-mini", host: "192.168.1.100", port: 22 },
  { name: "96gb",     host: "8.141.8.23",    port: 6002 },
  { name: "paper",    host: "paper.server",   port: 22 },
];

async function checkServers() {
  for (const srv of SERVERS) {
    const start = Date.now();
    try {
      // TCP 连接测试（不需要真正 SSH 认证）
      await tcpPing(srv.host, srv.port, 5000); // 5s timeout
      db.run(`UPDATE servers SET status = 'online', latency_ms = ?1, checked_at = datetime('now')
              WHERE name = ?2`, [Date.now() - start, srv.name]);
    } catch {
      db.run(`UPDATE servers SET status = 'offline', checked_at = datetime('now')
              WHERE name = ?1`, [srv.name]);
    }
  }
}
setInterval(checkServers, 60_000);
```

**新增 servers 表**：
```sql
CREATE TABLE IF NOT EXISTS servers (
  name       TEXT PRIMARY KEY,
  host       TEXT NOT NULL,
  port       INTEGER DEFAULT 22,
  status     TEXT DEFAULT 'unknown',  -- online / offline / unknown
  latency_ms INTEGER,
  checked_at TEXT
);
```

**含义**：
- `online` → SSH 可达，出问题可以 tmux 兜底
- `offline` → SSH 不通，该服务器上所有 Agent 失联，红色告警

### Layer 2：CommHub 通信状态（消息通道）

**检测方式**：三个信号综合判定

| 信号 | 来源 | 说明 |
|------|------|------|
| SSE 连接 | `/health` 的 `sse_sessions` | Channel 模式实时连接 |
| MCP 工具可用 | 最后一次成功的 MCP 调用时间 | Agent 能不能调 CommHub 工具 |
| 心跳 | `last_heartbeat` 字段 | 60s 定期上报 |

**判定逻辑**：

| SSE 连接 | 心跳(<2min) | → 通信状态 | 含义 |
|---------|------------|-----------|------|
| Yes | Yes | **connected** | Channel 实时通信正常 |
| Yes | No | **degraded** | SSE 在但 Agent 可能卡住 |
| No | Yes | **polling** | Poller 模式，消息可达但有延迟 |
| No | No | **disconnected** | 通信断开，需要 SSH 兜底 |

### Layer 3：Agent Session 状态（进程级）

**检测方式**：Agent 主动上报 + tmux 兜底探测

| 信号 | 来源 | 说明 |
|------|------|------|
| `report_status` | Agent 主动调 MCP | 自报状态：working/idle/blocked/error |
| tmux session | SSH + `tmux has-session` | 进程是否存在 |
| 最后活动 | `updated_at` 字段 | 最后一次上报时间 |

**状态值**：

| Agent 状态 | 含义 |
|-----------|------|
| **working** | 正在执行任务 |
| **idle** | 空闲等待任务 |
| **blocked** | 被阻塞（等待输入/权限/资源） |
| **error** | 出错 |
| **offline** | 进程不存在或超时无响应 |

---

## 3. Dashboard 拓扑图三层可视化

### 3.1 视觉映射

```
┌─────────────────────────────────────────────┐
│  🟢 Central Server (SSH: 3ms)    ← Layer 1  │
│  ┌─────────────┐  ┌─────────────┐           │
│  │ 🟢 指挥室    │──│ 🟡 通信龙   │  ← Layer 3 │
│  │ working     │  │ idle        │           │
│  └──────┬──────┘  └──────┬──────┘           │
│         │ 实线           │ 实线    ← Layer 2  │
└─────────┼────────────────┼──────────────────┘
          │                │
    ┌─────┴────────────────┴─────┐
    │     CommHub Server (:9200)  │
    └─────┬────────────────┬─────┘
          │                │
┌─────────┼────────────────┼──────────────────┐
│  🟢 96GB Server (SSH: 45ms)     ← Layer 1   │
│  ┌─────────────┐  ┌─────────────┐           │
│  │ 🔵 大猫     │╌╌│ ⚪ P站姐    │  ← Layer 3 │
│  │ working     │  │ offline     │           │
│  └──────┬──────┘  └─────────────┘           │
│         │ 虚线(Poller)   (无连线)  ← Layer 2  │
└─────────┼───────────────────────────────────┘
          │
    ┌─────┴──────────────────────┐
    │     CommHub Server (:9200)  │
    └────────────────────────────┘
```

### 3.2 三层颜色规则

**Layer 1 — 服务器框边框**：

| 状态 | 边框颜色 | 背景 |
|------|---------|------|
| SSH online | 绿色 #22C55E | 浅绿 #F0FDF4 |
| SSH offline | 红色 #EF4444 | 浅红 #FEF2F2 |
| SSH unknown | 灰色 #9CA3AF | 浅灰 #F9FAFB |

**Layer 2 — 连线样式**：

| 通信状态 | 线型 | 颜色 |
|---------|------|------|
| connected (Channel SSE) | 实线 ── | 绿色 #22C55E |
| polling (SSE Poller) | 虚线 ╌╌ | 蓝色 #3B82F6 |
| degraded | 虚线 ╌╌ | 黄色 #EAB308 |
| disconnected | 不画线 | — |

**Layer 3 — Agent 节点**：

| Agent 状态 | 圆点颜色 | 样式 |
|-----------|---------|------|
| working | 绿色 #22C55E | 实心 + 脉冲动画 |
| idle | 黄色 #EAB308 | 实心 |
| blocked | 橙色 #F97316 | 实心 + 感叹号 |
| error | 红色 #EF4444 | 实心 + 叉号 |
| offline | 灰色 #9CA3AF | 空心 |

### 3.3 节点 Tooltip 三层信息

```
[🟢 指挥室]                        ← Agent 名称 + Layer 3 颜色
├─ Agent: working (task: "调度任务") ← Layer 3
├─ CommHub: connected (SSE x1)      ← Layer 2
├─ Heartbeat: 15s ago               ← Layer 2
├─ Server: central (SSH: 3ms)       ← Layer 1
└─ Uptime: 4h 32m
```

### 3.4 告警规则

| 条件 | 告警级别 | 说明 |
|------|---------|------|
| Layer 1 offline | **红色告警** | 服务器不可达，所有 Agent 失联 |
| Layer 2 disconnected + Layer 1 online | **橙色警告** | SSH 通但 CommHub 断，需要 tmux 兜底 |
| Layer 3 error/blocked | **黄色提示** | Agent 有问题但通信正常 |
| Layer 3 offline + Layer 2 connected | **橙色警告** | 通信通但 Agent 进程挂了 |

---

## 4. Server 端改动

### 4.1 SSE 连接同步 DB（解决假在线）

### 4.1 SSE 连接同步 DB（解决假在线）

**改 push.ts**：SSE 连接/断开时自动更新 sessions 表

```typescript
// SSE 连接建立时
function addClient(alias, client) {
  clients.get(alias)?.push(client) || clients.set(alias, [client]);
  db.run(`UPDATE sessions SET connected = 1, connected_at = datetime('now') WHERE alias = ?`, [alias]);
}

// SSE 连接断开时
function removeClient(alias, client) {
  // ... existing cleanup ...
  if (getClientCount(alias) === 0) {
    db.run(`UPDATE sessions SET connected = 0, disconnected_at = datetime('now') WHERE alias = ?`, [alias]);
  }
}
```

### 4.2 sessions 表加列

```sql
ALTER TABLE sessions ADD COLUMN connected INTEGER DEFAULT 0;  -- SSE 是否连着
ALTER TABLE sessions ADD COLUMN last_heartbeat TEXT;           -- 最后心跳时间
ALTER TABLE sessions ADD COLUMN server_name TEXT;              -- 所属服务器（关联 servers 表）
```

### 4.3 心跳机制

**改 commhub-channel.ts**：每 60 秒自动发心跳

```typescript
setInterval(() => {
  callCommHub("report_status", {
    resume_id: RESUME_ID,
    alias: ALIAS,
    status: currentStatus,
    heartbeat: true
  });
}, 60_000);
```

**改 commhub-sse-poller.sh**：Poller 也定期上报心跳

```bash
while true; do
  curl -s "$COMMHUB_URL/api/heartbeat/$ALIAS"
  sleep 60
done &
```

**Server 新增轻量心跳端点**：

```typescript
app.get("/api/heartbeat/:alias", (req, res) => {
  db.run(`UPDATE sessions SET last_heartbeat = datetime('now') WHERE alias = ?`, [req.params.alias]);
  res.json({ ok: true });
});
```

### 4.4 统一 Topology 端点

**新增 `/api/commhub/topology`**，一次返回三层状态：

```typescript
app.get("/api/commhub/topology", (req, res) => {
  const now = Date.now();

  // Layer 1: 服务器状态
  const servers = db.query("SELECT * FROM servers").all().map(srv => ({
    name: srv.name,
    host: srv.host,
    port: srv.port,
    ssh_status: srv.status,           // online / offline / unknown
    ssh_latency_ms: srv.latency_ms,
    ssh_checked_at: srv.checked_at,
  }));

  // Layer 2 + 3: Agent 状态
  const sessions = db.query("SELECT * FROM sessions ORDER BY updated_at DESC").all();
  const sseStats = getSSEStats();

  const agents = sessions.map(s => {
    const hasSSE = (sseStats.sessions[s.alias] || 0) > 0;
    const heartbeatAge = s.last_heartbeat
      ? (now - new Date(s.last_heartbeat).getTime()) / 1000
      : Infinity;

    // Layer 2: 通信状态判定
    let comm_state;
    if (hasSSE && heartbeatAge < 120) {
      comm_state = "connected";        // Channel SSE 正常
    } else if (hasSSE && heartbeatAge >= 120) {
      comm_state = "degraded";         // SSE 在但可能卡住
    } else if (!hasSSE && heartbeatAge < 120) {
      comm_state = "polling";          // Poller 模式
    } else {
      comm_state = "disconnected";     // 通信断开
    }

    return {
      alias: s.alias,
      server_name: s.server_name,      // 关联到哪个服务器
      // Layer 2
      comm_state,
      comm_type: hasSSE ? "channel" : (heartbeatAge < 120 ? "poller" : "none"),
      sse_connections: sseStats.sessions[s.alias] || 0,
      heartbeat_ago: Math.round(heartbeatAge),
      // Layer 3
      agent_status: s.status,          // working / idle / blocked / error / offline
      agent_type: s.agent,             // claude-code / codex / minimax
      task: s.task,
      progress: s.progress,
      updated_at: s.updated_at,
    };
  });

  res.json({ ok: true, servers, agents });
});
```

---

## 5. Dashboard 拓扑图双线设计

### 5.1 两条线独立展示

拓扑图中每个 Agent 到中心有**两条独立的线**：

```
                        CommHub Server
                        ┌──────────┐
                        │  :9200   │
                        └────┬─┬───┘
                  粗线 ──────┘ └────── 细线
                  (SSH)              (CommHub)
                    │                   │
┌───────────────────┼───────────────────┼──────────────┐
│  Central Server   │                   │              │
│  ┌────────────────┼───────────────────┼───────────┐  │
│  │   [🟢 指挥室]  ════════════════════ ──────────  │  │
│  │   [🟡 通信龙]  ════════════════════ ──────────  │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────┐
│  96GB Server                                          │
│  ┌────────────────────────────────────────────────┐  │
│  │   [🔵 大猫]   ════════════════════ ╌╌╌╌╌╌╌╌╌  │  │
│  │   [⚪ P站姐]  ════════════════════             │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘

═══ 粗线 = SSH 连接（服务器级）
─── 细线 = CommHub Channel/MCP 连接（Agent 级）
╌╌╌ 细虚线 = CommHub Poller 模式
```

### 5.2 粗线（SSH 服务器连接）

从指挥室到每个服务器的 SSH 可达性。**一条粗线代表整个服务器**。

| SSH 状态 | 粗线颜色 | 含义 |
|---------|---------|------|
| online | 绿色 #22C55E | SSH 通，可 tmux 兜底 |
| offline | 红色 #EF4444 | SSH 断，该服务器完全失联 |
| unknown | 灰色 #9CA3AF | 未检测 |

### 5.3 细线（CommHub Agent 连接）

从每个 Agent 到 CommHub Server 的消息通道。**每个 Agent 独立一条细线**。

| 通信状态 | 细线样式 | 颜色 | 含义 |
|---------|---------|------|------|
| connected (Channel SSE) | 实线 ── | 蓝色 #3B82F6 | Channel 实时推送 |
| polling (SSE Poller) | 虚线 ╌╌ | 蓝色 #3B82F6 | Poller 模式，有延迟 |
| degraded | 虚线 ╌╌ | 黄色 #EAB308 | SSE 在但心跳超时 |
| disconnected | 不画线 | — | 通信断开 |

### 5.4 一眼诊断矩阵

| 粗线(SSH) | 细线(CommHub) | 含义 | 操作 |
|----------|-------------|------|------|
| 🟢 绿 | 🔵 实线 | **完全正常** | 无需干预 |
| 🟢 绿 | 🔵 虚线 | **Poller 模式** | 正常，有轻微延迟 |
| 🟢 绿 | 无线 | **CommHub 断** | 可 tmux 兜底，需修复 CommHub |
| 🔴 红 | 🔵 实线 | **SSH 断但 CommHub 通** | CommHub 能用，但无法 tmux 兜底 |
| 🔴 红 | 无线 | **完全失联** | 紧急！检查服务器 |

---

## 6. 旧记录自动清理

**Server 定时任务（每小时）**：

```typescript
setInterval(() => {
  // 超过 24 小时无心跳 + 无 SSE → 标记 offline
  db.run(`UPDATE sessions SET status = 'offline'
          WHERE last_heartbeat < datetime('now', '-24 hours')
          AND connected = 0 AND status != 'offline'`);

  // 超过 7 天无任何活动 → 删除
  db.run(`DELETE FROM sessions
          WHERE updated_at < datetime('now', '-7 days')
          AND connected = 0`);
}, 3600_000);
```

**改名时**：alias 有 UNIQUE 约束，UPDATE 自然覆盖旧记录。无需手动 DELETE。

---

## 7. 实施计划

| 步骤 | 改动文件 | 内容 | 工作量 | 效果 |
|------|---------|------|--------|------|
| 1 | db.ts | 新增 servers 表 + sessions 表加列 | 15min | 三层数据基础 |
| 2 | index.ts | SSH ping 定时检测 (Layer 1) | 30min | 服务器可达性 |
| 3 | push.ts | SSE 连接/断开同步写 DB (Layer 2) | 20min | 解决假在线 |
| 4 | index.ts | /api/heartbeat/:alias 端点 | 10min | 心跳支持 |
| 5 | commhub-channel.ts | 心跳 60s 定时器 | 10min | CC 心跳 |
| 6 | commhub-sse-poller.sh | Poller 心跳 | 10min | 非 CC 心跳 |
| 7 | index.ts | /api/commhub/topology 三层统一端点 | 30min | 统一状态源 |
| 8 | Dashboard page.tsx | 三层拓扑图 + 双线设计 | 2h | 可视化 |
| 9 | index.ts | 旧记录自动清理定时器 | 10min | 清理幽灵 |

**总计约 4 小时。** 步骤 1-4 最关键（Layer 1+2 基础），做完即解决"假在线"和"服务器失联不知道"两大问题。

---

## 8. 风险与备选

- **心跳频率**：60s 平衡了准确性和开销。可改 120s，代价是 degraded 检测延迟。
- **SSH ping 方式**：TCP connect 不需要 SSH 认证，仅检测端口可达。如需更深检测可改为 `ssh -o ConnectTimeout=5 user@host true`。
- **向后兼容**：`/api/status` 保留不删，`/api/commhub/topology` 作为新端点。Dashboard 灰度切换。
- **Poller 心跳失败**：curl 超时不影响 Poller 主功能（推消息），心跳只是附加。
- **DB 写入频率**：心跳每 60s + SSH ping 每 60s，SQLite WAL 模式完全扛得住。
- **servers 表维护**：服务器列表初期手动配置，后续可做 Dashboard 管理界面。
