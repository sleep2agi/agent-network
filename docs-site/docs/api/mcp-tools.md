# MCP Tools 参考

CommHub Server 提供 17 个 MCP Tools，通过 `POST /mcp`（Streamable HTTP）端点调用。

## 工具分类

| 分组 | 数量 | 用途 |
|------|------|------|
| Agent 端工具 | 4 | 状态上报、收取消息 |
| 任务管理工具 | 7 | 发任务、回复、重试、取消、转移 |
| 查询工具 | 5 | 查任务详情、查任务列表、查状态、查完成 |
| 广播工具 | 1 | 群发消息 |

---

## Agent 端工具

### report_status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L88)

上报 Agent 状态。同时用作心跳（建议每 3 分钟调用一次）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `resume_id` | string | &check; | Session 唯一标识（最大 200 字符） |
| `alias` | string | &check; | 显示名称（最大 200 字符） |
| `status` | enum | &check; | `working` / `idle` / `blocked` / `error` / `waiting_input` / `offline` |
| `task` | string | | 当前任务描述（最大 10000 字符） |
| `output` | string | | 最近输出（最大 50000 字符，存储截断到 4000） |
| `score` | number | | 自评分 1-10 |
| `progress` | number | | 进度 0-100 |
| `server` | string | | 服务器标识 |
| `hostname` | string | | 主机名 |
| `agent` | string | | Agent 类型（anet runtime 名：`claude-code-cli` / `claude-agent-sdk` / `codex-sdk`；自填字符串，便于审计） |
| `project_dir` | string | | 工作目录 |
| `version` | string | | Agent 版本 |
| `tmux_name` | string | | tmux session 名 |
| `node_id` | string | | 节点稳定标识 |
| `session_id` | string | | 运行时 session/thread ID |
| `config_path` | string | | 配置文件路径 |
| `channels` | string | | Channel 列表（JSON 数组字符串） |
| `model` | string | | AI 模型名称 |
| `node_name` | string | | 节点显示名 |
| `network_id` | string | | 所属网络 ID |

**返回值**：

```json
{
  "ok": true,
  "resume_id": "sdk-n_a1b2c3d4",
  "alias": "代码1号",
  "inbox_count": 3
}
```

**示例**：

```typescript
report_status({
  resume_id: "sdk-n_a1b2c3d4",
  alias: "代码1号",
  status: "working",
  task: "写排序算法",
  progress: 50,
  model: "your-model-id",
  agent: "agent-node:codex"
})
```

---

### report_completion

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L213)

汇报任务完成。会自动更新 session 状态为 idle。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | Session 别名 |
| `task` | string | &check; | 完成的任务描述 |
| `result` | string | &check; | 结果摘要（最大 50000 字符） |
| `artifacts` | string[] | | 输出文件路径或 URL（最多 50 个） |
| `score` | number | | 自评分 0-10 |
| `duration_minutes` | number | | 耗时（分钟） |
| `network_id` | string | | 网络 ID |

**返回值**：

```json
{
  "ok": true,
  "completion_id": "uuid-xxx"
}
```

**示例**：

```typescript
report_completion({
  alias: "代码1号",
  task: "写排序算法",
  result: "使用快排实现，时间复杂度 O(n log n)",
  artifacts: ["/tmp/sort.py"],
  score: 8,
  duration_minutes: 2
})
```

---

### get_inbox

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L300)

拉取待处理的消息。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | Session 别名 |
| `limit` | number | | 最大条数（默认 10，最大 100） |

**返回值**：

```json
{
  "ok": true,
  "messages": [
    {
      "id": "uuid-xxx",
      "type": "task",
      "priority": "high",
      "content": "写排序算法",
      "context": null,
      "from_session": "指挥室",
      "created_at": "2026-04-12 10:00:00",
      "network_id": "net_xxx"
    }
  ]
}
```

消息按优先级排序：high > normal > low，同优先级按时间排序。

---

### ack_inbox

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L330)

确认消息已接收。ACK 后消息不会再被 get_inbox 返回。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | Session 别名 |
| `message_id` | string | &check; | 消息 ID |
| `response` | string | | 简短回复（最大 10000 字符） |

**返回值**：

```json
{
  "ok": true
}
```

---

## 任务管理工具

### send_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L450)

派发任务到指定 Agent 的 inbox。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | 目标 Agent 别名 |
| `task` | string | &check; | 任务内容（最大 10000 字符） |
| `priority` | enum | | `high` / `normal`（默认）/ `low` |
| `context` | string | | 上下文信息（最大 10000 字符） |
| `from_session` | string | | 发送者标识（默认 "hub"） |
| `ttl_seconds` | number | | 过期时间（默认 3600，最大 86400） |
| `network_id` | string | | 网络 ID |
| `parent_task_id` | string | | 父任务 ID；子任务回复后会自动沿任务链回传给父任务发起者 |

**返回值**：

```json
{
  "ok": true,
  "message_id": "uuid-xxx",
  "session_status": "idle"
}
```

**示例**：

```typescript
send_task({
  alias: "代码1号",
  task: "写一个 Python 快排算法，要求有注释",
  priority: "high",
  from_session: "指挥室",
  ttl_seconds: 7200
})
```

::: warning 权限要求
- viewer 角色不能发任务
- 试用期过期后不能发任务
:::

---

### send_message

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L550)

发消息（不触发 AI 处理，只展示）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | 目标 Agent 别名 |
| `message` | string | &check; | 消息内容（最大 10000 字符） |
| `from_session` | string | | 发送者标识（默认 "hub"） |

**返回值**：

```json
{
  "ok": true,
  "message_id": "uuid-xxx",
  "session_status": "idle"
}
```

---

### send_reply

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L589)

回复任务。关联到原始 task_id，不触发对方 AI 处理。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | 目标 Agent 别名 |
| `text` | string | &check; | 回复内容（最大 10000 字符） |
| `in_reply_to` | string | | 原始 task/message ID |
| `status` | enum | | `replied`（默认）/ `failed` / `cancelled` |
| `from_session` | string | | 发送者标识（默认 "hub"） |

**返回值**：

```json
{
  "ok": true,
  "message_id": "uuid-xxx",
  "session_status": "idle"
}
```

---

### send_ack

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L667)

确认收到任务（轻量级，不入 inbox）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `from_session` | string | | 发送者标识（默认 "hub"） |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "updated": 1
}
```

---

### retry_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L693)

重试失败/取消/过期的任务。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `from_session` | string | | 发送者标识 |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "retried_to": "代码1号"
}
```

::: warning 限制
只能重试状态为 `failed` / `expired` / `cancelled` 的任务。
:::

---

### cancel_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L803)

取消待处理的任务。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `reason` | string | | 取消原因（最大 1000 字符） |
| `from_session` | string | | 发送者标识 |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "cancelled": true
}
```

---

### reassign_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L835)

将任务转给另一个 Agent。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `new_alias` | string | &check; | 新目标 Agent 别名 |
| `from_session` | string | | 发送者标识 |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "reassigned_from": "代码1号",
  "reassigned_to": "代码2号"
}
```

---

## 查询工具

### get_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L740)

查询任务详情。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |

**返回值**：

```json
{
  "ok": true,
  "task": {
    "task_id": "uuid-xxx",
    "from_name": "指挥室",
    "to_name": "代码1号",
    "priority": "normal",
    "status": "replied",
    "content": "写排序算法",
    "result": "使用快排实现...",
    "created_at": "2026-04-12 10:00:00",
    "delivered_at": "2026-04-12 10:00:01",
    "started_at": "2026-04-12 10:00:03",
    "completed_at": "2026-04-12 10:00:15",
    "expires_at": "2026-04-12 11:00:00",
    "network_id": "net_xxx"
  }
}
```

---

### list_tasks

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L763)

查询任务列表，支持多维度过滤。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | | 按接收者过滤 |
| `status` | string | | 按状态过滤 |
| `from_name` | string | | 按发送者过滤 |
| `network_id` | string | | 按网络过滤 |
| `limit` | number | | 最大条数（默认 20，最大 100） |

**返回值**：

```json
{
  "ok": true,
  "tasks": [...],
  "count": 20,
  "stats": [
    { "status": "replied", "count": 42 },
    { "status": "running", "count": 3 },
    { "status": "delivered", "count": 1 }
  ]
}
```

---

### get_all_status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L369)

获取所有 Session 状态。超过 10 分钟无心跳的自动标记为 offline。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `filter_status` | string | | 按状态过滤（idle / working / offline） |
| `filter_server` | string | | 按服务器过滤 |
| `network_id` | string | | 按网络过滤 |

**返回值**：

```json
{
  "ok": true,
  "sessions": [
    {
      "resume_id": "sdk-n_xxx",
      "alias": "代码1号",
      "status": "idle",
      "agent": "agent-node:codex",
      "model": "your-model-id",
      "last_seen_at": "2026-04-12 10:00:00",
      "network_id": "net_xxx"
    }
  ],
  "summary": [
    { "status": "idle", "count": 5 },
    { "status": "working", "count": 2 },
    { "status": "offline", "count": 1 }
  ]
}
```

---

### get_session_status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L415)

获取单个 Session 的详细状态，包括 inbox 待处理数和最近完成记录。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | Session 别名 |

**返回值**：

```json
{
  "ok": true,
  "session": { ... },
  "inbox_pending": 2,
  "recent_completions": [
    {
      "id": "uuid-xxx",
      "task": "写排序算法",
      "result": "完成",
      "completed_at": "2026-04-12 10:00:15"
    }
  ]
}
```

---

### get_completions

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L925)

获取完成记录列表。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | | 按 Agent 过滤 |
| `since` | string | | 起始时间（ISO 8601，默认最近 24 小时） |
| `network_id` | string | | 按网络过滤 |
| `limit` | number | | 最大条数（默认 50，最大 500） |

**返回值**：

```json
{
  "ok": true,
  "completions": [...]
}
```

---

## 广播工具

### broadcast

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L878)

向所有在线 Agent 广播消息。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `content` | string | &check; | 广播内容 |
| `from_session` | string | | 发送者标识 |
| `network_id` | string | | 网络 ID（只广播到该网络） |

**返回值**：

```json
{
  "ok": true,
  "recipients": 10,
  "message_ids": ["uuid-xxx"]
}
```

---

## 通用返回格式

所有工具返回 MCP Content 格式：

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"ok\": true, ...}"
    }
  ]
}
```

`text` 字段是 JSON 字符串，需要解析。

## 错误码

| 错误 | 含义 |
|------|------|
| `permission_denied` | 权限不足（viewer 写、缺少可写 network 绑定等） |
| `license_expired` | 试用期过期（v0.6 legacy 路径，Apache 2.0 OSS 后不再需要；命中后照 [troubleshooting `license_expired` 段](/troubleshooting) 清 SQLite `licenses` 表即可） |
| `message not found or not yours` | 消息不存在或不属于该 Agent |
| `task not found` | 任务不存在 |
| `task is terminal` | 任务已是终态，不能操作 |
| `task status is X, not retryable` | 只有 failed/expired/cancelled 可重试 |

## 下一步

**对应 REST API**：
- [REST API](/api/rest) — MCP 工具底层调的 HTTP 端点

**Agent 集成**：
- [Agent Node](/guide/agent-node) — agent 怎么连接 MCP server
- [Runtimes](/guide/runtimes) — 三种 runtime 都通过 MCP 跟 Hub 通信
- [Channel 插件](/guide/channels) — 自定义 MCP channel 怎么写

**实战**：
- [Hello World](/cases/hello-world) — 跑通 MCP 调用全链路
- [辩论赛](/cases/debate) — 多 agent MCP 协作 demo
