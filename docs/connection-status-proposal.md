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

## 2. 方案：三层状态合并

### 第一层：连接状态（Server 端实时，不依赖 Agent 上报）

**改 push.ts**：SSE 连接/断开时自动更新 sessions 表

```typescript
// SSE 连接建立时
function addClient(alias, client) {
  clients.get(alias)?.push(client) || clients.set(alias, [client]);
  // 新增：同步到 DB
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

**sessions 表加两列**：
```sql
ALTER TABLE sessions ADD COLUMN connected INTEGER DEFAULT 0;  -- SSE 是否连着
ALTER TABLE sessions ADD COLUMN last_heartbeat TEXT;           -- 最后心跳时间
```

### 第二层：心跳机制（区分"连着但空闲"vs"真正活跃"）

**改 commhub-channel.ts**：每 60 秒自动发心跳

```typescript
setInterval(() => {
  callCommHub("report_status", {
    resume_id: RESUME_ID,
    alias: ALIAS,
    status: currentStatus,  // 保持当前状态不变
    heartbeat: true
  });
}, 60_000);
```

**改 commhub-sse-poller.sh**：Poller 也定期上报心跳

```bash
# 每 60 秒调一次轻量心跳端点
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

### 第三层：状态判定逻辑（Server 端统一）

**新增 `/api/commhub/topology` 端点**，替代当前 `/api/status`：

```typescript
app.get("/api/commhub/topology", (req, res) => {
  const now = Date.now();
  const sessions = db.query("SELECT * FROM sessions ORDER BY updated_at DESC").all();
  const sseStats = getSSEStats();

  const result = sessions.map(s => {
    const hasSSE = (sseStats.sessions[s.alias] || 0) > 0;
    const heartbeatAge = s.last_heartbeat
      ? (now - new Date(s.last_heartbeat).getTime()) / 1000
      : Infinity;
    const reportAge = s.updated_at
      ? (now - new Date(s.updated_at).getTime()) / 1000
      : Infinity;

    // 三级判定
    let connection_state;
    if (hasSSE && heartbeatAge < 120) {
      connection_state = "online";        // SSE 连着 + 心跳正常
    } else if (hasSSE && heartbeatAge >= 120) {
      connection_state = "connected";     // SSE 连着但心跳超时（可能卡住）
    } else if (!hasSSE && heartbeatAge < 120) {
      connection_state = "polling";       // 无 SSE 但有心跳（Poller 模式）
    } else if (!hasSSE && reportAge < 600) {
      connection_state = "stale";         // 无连接，10分钟内有过上报
    } else {
      connection_state = "offline";       // 彻底离线
    }

    return {
      alias: s.alias,
      status: s.status,                   // agent 自报状态
      connection_state,                   // 服务端判定的连接状态
      sse_connections: sseStats.sessions[s.alias] || 0,
      heartbeat_ago: Math.round(heartbeatAge),
      report_ago: Math.round(reportAge),
      task: s.task,
      progress: s.progress,
      agent: s.agent,
      server: s.server,
    };
  });

  res.json({ ok: true, sessions: result });
});
```

---

## 3. 状态判定矩阵

| SSE连接 | 心跳(<2min) | report(<10min) | connection_state | 含义 |
|---------|------------|----------------|-----------------|------|
| Yes | Yes | Yes | **online** | 完全正常 |
| Yes | No | Yes | **connected** | SSE 在但可能卡住 |
| No | Yes | Yes | **polling** | Poller 模式正常 |
| No | No | Yes | **stale** | 刚断，可能恢复 |
| No | No | No | **offline** | 彻底离线 |

---

## 4. Dashboard 拓扑图改动

**数据源**：从 `/api/status` 切换到 `/api/commhub/topology`

**节点颜色（5 态）**：

| connection_state | 颜色 | 样式 | 文字 |
|-----------------|------|------|------|
| online | 绿色 #22C55E | 实心圆点 | 在线 |
| connected | 黄色 #EAB308 | 实心圆点 | 已连接(无心跳) |
| polling | 蓝色 #3B82F6 | 实心圆点 | 轮询模式 |
| stale | 橙色 #F97316 | 空心圆点 | 可能掉线 |
| offline | 灰色 #9CA3AF | 空心圆点 | 离线 |

**连线样式**：
- SSE 连接 → 实线（实时推送）
- Poller 模式 → 虚线（轮询）
- 无连接 → 不画线

**节点 tooltip 信息**：
```
[绿色] 通信龙
  status: working
  task: "reviewing code..."
  heartbeat: 15s ago
  SSE: 1 connection
```

---

## 5. 旧记录自动清理

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

## 6. 实施计划

| 步骤 | 改动文件 | 内容 | 工作量 | 效果 |
|------|---------|------|--------|------|
| 1 | db.ts | sessions 表加 connected + last_heartbeat 列 | 10min | 基础设施 |
| 2 | push.ts | SSE 连接/断开同步写 DB | 20min | 解决假在线 |
| 3 | index.ts | /api/heartbeat/:alias 轻量端点 | 10min | 区分活跃/空闲 |
| 4 | commhub-channel.ts | 心跳 60s 定时器 | 10min | CC 心跳 |
| 5 | commhub-sse-poller.sh | Poller 心跳 | 10min | 非 CC 心跳 |
| 6 | index.ts | /api/commhub/topology 新端点 | 30min | 统一状态源 |
| 7 | Dashboard page.tsx | 切换数据源 + 5态颜色 | 1h | 可视化 |
| 8 | index.ts | 旧记录自动清理定时器 | 10min | 清理幽灵 |

**总计约 2.5 小时。** 步骤 1-3 最关键，做完即解决"假在线"问题。

---

## 7. 风险与备选

- **心跳频率**：60s 选择平衡了准确性和开销。如果嫌太频繁可改 120s，代价是 stale 检测延迟。
- **向后兼容**：`/api/status` 保留不删，`/api/commhub/topology` 作为新端点。Dashboard 灰度切换。
- **Poller 心跳失败**：curl 超时不影响 Poller 主功能（推消息），心跳只是附加。
- **DB 写入频率**：心跳每 60s 写一次 UPDATE，SQLite 完全扛得住（远低于 WAL 模式瓶颈）。
