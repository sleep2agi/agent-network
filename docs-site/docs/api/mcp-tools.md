# MCP Tools 参考

CommHub Server 共注册约 40 个 MCP Tools；本页文档化其中 agent 日常协作最常用的 17 个核心工具（其余为节点管理、供应商配置等运维类工具）。全部通过 `POST /mcp`（Streamable HTTP）端点调用。

## 工具分类

| 分组 | 数量 | 用途 |
|------|------|------|
| Agent 端工具 | 4 | 状态上报、收取消息 |
| 任务管理工具 | 7 | 发任务、回复、重试、取消、转移 |
| 查询工具 | 5 | 查任务详情、查任务列表、查状态、查完成 |
| 广播工具 | 1 | 群发消息 |

> **运维类 MCP 工具（本页不展开）**：除上述 17 个协作工具外，Hub 还注册了约 22 个运维类工具，**由 `anet` CLI / Dashboard 调用，普通 agent 用不到**：
> - 节点生命周期：`create_node` / `delete_node` / `restart_node` / `stop_node` / `update_node_config`
> - 供应商与密钥（OWNER / admin）：`upsert_provider` / `update_provider` / `list_providers` / `probe_provider_model` / `upsert_network_secret` / `list_network_secrets`
> - 主机 daemon 协议（内部）：`list_host_supervisors` / `list_my_children` / `get_*_request` / `ack_*_request` 等

---

## Agent 端工具

### report_status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"report_status"`（注册点在 `server/src/tools.ts`，全仓唯一）

上报 Agent 状态。同时用作心跳（建议每 3 分钟调用一次）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `resume_id` | string | &check; | Session 唯一标识（最大 200 字符） |
| `alias` | string | &check; | 显示名称（最大 200 字符） |
| `status` | enum | &check; | `working` / `idle` / `blocked` / `error` / `waiting_input` / `offline` |
| `task` | string | | 当前任务描述（最大 10000 字符） |
| `output` | string | | 最近输出（最大 50000 字符，存储截断到 4000） |
| `score` | number | | 自评分 **0-10**（doc 之前写 1-10，schema 实际 `.min(0).max(10)`） |
| `progress` | number | | 进度 0-100 |
| `server` | string | | 服务器标识 |
| `hostname` | string | | 主机名 |
| `agent` | string | | Agent 类型（自填字符串，便于审计；agent-node 实际发 `agent-node:<runtime>`，如 `agent-node:claude-agent-sdk` / `agent-node:codex-sdk` / `agent-node:claude-code-cli`；Claude Code MCP wrapper 发 `claude-code`；其他客户端自由填） |
| `project_dir` | string | | 工作目录 |
| `version` | string | | Agent 版本 |
| `tmux_name` | string | | tmux session 名 |
| `node_id` | string | | 节点稳定标识。**注意**：传了 `node_id` 才会把 `model` / `node_name` / `runtime`（从 `agent` 字段拆）upsert 到 `nodes` 表（[`tools.ts:168-188`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L168)）。`model` 参数本身**不依赖 `node_id`** —— `report_status` 的 `sessions` upsert 无条件写 `sessions.model = COALESCE(model, 旧值)`（[`tools.ts:129` INSERT + `tools.ts:141` ON CONFLICT](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L129)）；只有 `node_name` 没有 `sessions` 列、必须靠 `node_id` 走 `nodes` 表 |
| `session_id` | string | | 运行时 session/thread ID |
| `config_path` | string | | 配置文件路径 |
| `channels` | string | | Channel 列表（JSON 数组字符串） |
| `model` | string | | AI 模型名称（仅当 `node_id` 也传时写入 `nodes.model`） |
| `node_name` | string | | 节点显示名（仅当 `node_id` 也传时写入 `nodes.node_name`） |
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

::: warning 认证要求
该 tool 只接受 **`ntok_`（network-scoped）token**。用 `utok_`（user-scoped）调用会返回 `{ok: false, error: "network_token_required"}`（[`tools.ts:116-118`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L116)）。这是 v0.8 RFC-001 之后的硬约束 — agent 心跳必须绑定 network。

副作用：除了写 `sessions` 表，还会:
- 自动**删除同 network、同 alias、不同 resume_id** 的旧 session row（[`tools.ts:127`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L127)；用于 agent 重启时清理孤儿）
- 当 `status="working"` 且有 `task` 时，触发 `tasks` 表 `delivered/acked → running` 状态切换（[`tools.ts:150-153`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L150)；详见 [Task 生命周期](/concepts/task-lifecycle#状态机)）
- 当 `node_id` 传入时 upsert `nodes` 表（含 `model` / `node_name` / `runtime`，详见 `node_id` 参数行）
:::

---

### report_completion

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"report_completion"`（注册点在 `server/src/tools.ts`，全仓唯一）

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

::: tip 副作用（除了 completions 表 INSERT）
- **session 状态切换**：[`tools.ts:239-242`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L239) `UPDATE sessions SET status='idle', task=NULL, progress=0` (按 alias)
- **任务状态切换**：[`tools.ts:244-266`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L244) 把 `tasks` 行从 `delivered`/`acked`/`running` 切到 `replied`。先按 `task_id = <task 参数>` 匹配；不命中再 fallback 用 `to_name=<alias> AND content=<task 参数>` 找最近一条 — 所以 `task` 参数实际可填**真实 task_id**（推荐）或**任务描述字符串**（fallback）
- **`result` 截断**：写 `tasks.result` 时只取前 4000 字符（[`tools.ts:246`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L246)），但完整 `result` 会进 `completions.result`
- **chained_reply 自动传播**：如果该任务有 `parent_task_id`，会给父任务发起者 SSE 推 `chained_reply` event（[`tools.ts:271-291`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L271)；用于子任务回 → 链式通知父任务发起者，详见 [`task-lifecycle` 双写机制](/concepts/task-lifecycle#双写机制)）
- **`task_events` log**：记录一条 `replied` event（[`tools.ts:270`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L270)）

跟 [`send_reply`](#send-reply) 比较：`send_reply` 是 hub 工具，需要显式 `task_id` 参数；`report_completion` 是 agent 工具，可 fallback by content。
:::

---

### get_inbox

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"get_inbox"`（注册点在 `server/src/tools.ts`，全仓唯一）

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
      "task_id": "task-uuid-xxx",
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

任务消息的 `id` 是本次 inbox 投递行 ID；`task_id` 是跨重试/转派保持不变的逻辑任务 ID。旧数据没有独立 `task_id` 时，Hub 会回退为 `task_id = id`。处理任务时应把返回的 `task_id` 传给 `ack_inbox.message_id`；非任务消息继续传 `id`。

消息按优先级排序：high > normal > low，同优先级按时间排序。

---

### ack_inbox

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"ack_inbox"`（注册点在 `server/src/tools.ts`，全仓唯一）

确认消息已接收。ACK 后消息不会再被 `get_inbox` 返回。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | Session 别名 |
| `message_id` | string | &check; | inbox 投递行 `id`，或任务消息的逻辑 `task_id`。任务消费者应优先传 `get_inbox` 返回的 `task_id`；非任务消息传 `id` |
| `response` | string | | **当前 no-op**：handler 接受这个参数但不写库（[`tools.ts:872-924`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L872) 没有读取 `response`）。schema 保留是为了 forward-compat / 不破坏现有调用方；想真正回复用 [`send_reply`](#send-reply) |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

**返回值**：

```json
{ "ok": true }
```

**错误**：找不到属于该 alias 的待确认投递 → `message not found or already acknowledged`；投递在查询后不再可写 → `message not found or not yours`。

::: tip 副作用：tasks 表状态机
Hub 先用 `id = message_id`，或对任务消息用 `task_id = message_id`，解析出当前未确认的 inbox 行并只 ACK 那一行。若它是任务消息，再用该行解析出的稳定逻辑 `task_id` 把 `tasks` 从 `status='delivered'` UPDATE 到 `'acked'`（[`tools.ts:884-920`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L884)）。因此 retry/reassign 产生新 inbox `id` 后，仍能 ACK 原任务；旧消费者继续传 inbox `id` 也兼容。任务状态**仅**从 `delivered` 起跳，跟 hub 端 [`send_ack`](#send-ack)（接受 `created` / `delivered`）不同 —— 详见 [Task 生命周期 — `created` 状态](/concepts/task-lifecycle#状态机)。
:::

---

## 任务管理工具

### send_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"send_task"`（注册点在 `server/src/tools.ts`，全仓唯一）

派发任务到指定 Agent 的 inbox。**`send_task` 会触发收件方 AI 处理**（跟 [`broadcast`](#broadcast) 同款；`send_message` / `send_reply` / `send_ack` 不触发，详见 [Task 生命周期 — 消息类型](/concepts/task-lifecycle#消息类型)）。

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
| `meta` | object | | 结构化任务元数据；主要用于附件 `{ attachments: [{ type, path, url, mime, name, size }] }`，写入 task 的 `meta_json` 列 |

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"send_message"`（注册点在 `server/src/tools.ts`，全仓唯一）

发消息（不触发 AI 处理，只展示）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | 目标 Agent 别名 |
| `message` | string | &check; | 消息内容（最大 10000 字符） |
| `from_session` | string | | 发送者标识（默认 "hub"） |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"send_reply"`（注册点在 `server/src/tools.ts`，全仓唯一）

回复任务。关联到原始 task_id，不触发对方 AI 处理。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | 目标 Agent 别名 |
| `text` | string | &check; | 回复内容（最大 10000 字符） |
| `in_reply_to` | string | | 原始 task/message ID |
| `status` | enum | | `replied`（默认）/ `failed` / `cancelled` |
| `from_session` | string | | 发送者标识（默认 "hub"） |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"send_ack"`（注册点在 `server/src/tools.ts`，全仓唯一）

确认收到任务（轻量级，不入 inbox）。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `from_session` | string | | 发送者标识（默认 "hub"） |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

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

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"retry_task"`（注册点在 `server/src/tools.ts`，全仓唯一）

重试失败/取消/过期的任务。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `from_session` | string | | 发送者标识 |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "retried_to": "代码1号"
}
```

::: warning 限制
- 只能重试状态为 `failed` / `expired` / `cancelled` 的任务（verify [`tools.ts:713`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L713)），其他状态返回 `{ok: false, error: "task status is <X>, not retryable"}`
- 重试会**固定**给一个新的 `+1 小时` TTL（[`tools.ts:718`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L718) 硬编码），**不沿用原任务**的 `ttl_seconds`
- `task_id` 不变；inbox 里会插入一条新 `id` 的 row（新 UUID），并 SSE 推 `new_task` 给目标 alias
:::

---

### cancel_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"cancel_task"`（注册点在 `server/src/tools.ts`，全仓唯一）

取消待处理的任务。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `reason` | string | | 取消原因（最大 1000 字符） |
| `from_session` | string | | 发送者标识 |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "cancelled": true
}
```

::: warning 限制
只能取消状态为 `created` / `delivered` / `acked` / `running` 的任务（4 个 cancellable 源状态，verify [`tools.ts:817`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L817) WHERE 子句）。终态 `replied` / `failed` / `cancelled` / `expired` 上调用此 tool 会返回 `{ok: false, cancelled: false}`。

`created` 实际只是 DB 默认值，正常 API 路径不会观察到（详见 [Task 生命周期 — `created` 状态](/concepts/task-lifecycle#状态机)）。
:::

---

### reassign_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"reassign_task"`（注册点在 `server/src/tools.ts`，全仓唯一）

将任务转给另一个 Agent。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `task_id` | string | &check; | 任务 ID |
| `new_alias` | string | &check; | 新目标 Agent 别名 |
| `from_session` | string | | 发送者标识 |
| `network_id` | string | | Network 范围。utok_ 恰好 1 个成员网络时自动解析，可省略；跨多网络必须显式传（#517） |

**返回值**：

```json
{
  "ok": true,
  "task_id": "uuid-xxx",
  "reassigned_from": "代码1号",
  "reassigned_to": "代码2号"
}
```

::: warning 限制
- 只能 reassign **非终态**任务：`created` / `delivered` / `acked` / `running`（[`tools.ts:853`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L853) 反向拒掉 `replied` / `failed` / `cancelled` / `expired`，返回 `{ok: false, error: "task is terminal (<status>)"}`）
- 旧 alias 的 inbox row 被 `acked=1`（[`tools.ts:858`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L858)），原 agent 不会再 pick up
- 任务 status reset 到 `delivered`，`started_at` 清空，`delivered_at` 刷新到当前 time（[`tools.ts:863`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L863)）—— 正在 `running` 的任务会被中断
- TTL（`expires_at`）**不改**（跟 [`retry_task`](#retry-task) 的「固定 +1h」不同）；用原任务剩余时间
- 新 alias 拿到新 UUID 的 inbox row + `new_task` SSE 事件
:::

---

## 查询工具

### get_task

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"get_task"`（注册点在 `server/src/tools.ts`，全仓唯一）

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

`get_task` 走 `SELECT * FROM tasks`（[`tools.ts:749`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L749)），返回**完整行**（上面只是示例字段，实际还含 `requires_response` / `parent_task_id` 等所有列）。任务不存在时返回 `{ok: false, error: "task not found"}`。

---

### list_tasks

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"list_tasks"`（注册点在 `server/src/tools.ts`，全仓唯一）

查询任务列表，支持多维度过滤。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | | 按接收者过滤 |
| `status` | string | | 按状态过滤 |
| `from_name` | string | | 按发送者过滤 |
| `from_node_id` | string | | 按发送者 `node_id` 过滤（不可变 ID，比 `from_name` 更精确） |
| `network_id` | string | | 按网络过滤 |
| `limit` | number | | 最大条数（默认 20，最大 100） |

**返回值**：

```json
{
  "ok": true,
  "tasks": [
    {
      "task_id": "uuid-xxx",
      "from_name": "指挥室",
      "to_name": "代码1号",
      "priority": "normal",
      "status": "replied",
      "content": "写排序算法",
      "result": "使用快排实现...",
    "created_at": "2026-04-12 10:00:00",
    "runtime_submitted_at": "2026-04-12 10:00:03",
    "consumed_at": "2026-04-12 10:00:04",
    "completed_at": "2026-04-12 10:00:15"
    }
  ],
  "count": 1,
  "stats": [
    { "status": "replied", "count": 42 },
    { "status": "running", "count": 3 },
    { "status": "delivered", "count": 1 }
  ]
}
```

::: tip `list_tasks` 的行是 `get_task` 的子集
`list_tasks` 每行包含任务身份、收发方、状态、内容/结果和时间摘要。`runtime_submitted_at` 表示正文已交给厂商 runtime；`consumed_at` 进一步表示已有可归因的 turn-start/活动证据。**不含** `delivered_at` / `started_at` / `expires_at` / `network_id` / `requires_response` / `parent_task_id` —— 要这些字段用 [`get_task`](#get-task)（`SELECT *`）。`count` 是本次返回的行数（≤ `limit`），`stats` 是**整个 scope 内**按 status 分组的计数（不受 filter 影响）。两级证据与旧字段的语义区别见 [Task 生命周期](/concepts/task-lifecycle#runtime_submitted_at-与-consumed_at两级运行时证据)。
:::

---

### get_all_status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"get_all_status"`（注册点在 `server/src/tools.ts`，全仓唯一）

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
      "node_id": "n_a1b2c3d4",
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

::: warning `sessions` 行**没有** `model` 字段
`get_all_status` 走 `SELECT * FROM sessions`（[`tools.ts:388`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L388)，无 JOIN）。`sessions` 表 schema（[`db.ts:7-26`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L7) + V2 migration [`db.ts:59-68`](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L59)）**有 `model` 列** —— V2 migration `ALTER TABLE sessions ADD COLUMN model`，且 `report_status` 的 `sessions` upsert 无条件写 `sessions.model = COALESCE(model, 旧值)`（[`tools.ts:129`/`141`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L129)）。所以 `get_all_status` 直接返回每个 session 的 `model`（agent 没传 `model` 参数时为 `null`）。`nodes` 表里也有一份 `model`（传 `node_id` 时由 `report_status` 同步），是更持久的来源。`summary` 是按 status 分组的全 scope 计数（同 `list_tasks` 的 `stats`）。
:::

---

### get_session_status

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"get_session_status"`（注册点在 `server/src/tools.ts`，全仓唯一）

获取单个 Session 的详细状态，包括 inbox 待处理数和最近完成记录。

**参数**：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `alias` | string | &check; | Session 别名 |

**返回值**：

```json
{
  "ok": true,
  "session": {
    "resume_id": "sdk-n_xxx", "alias": "代码1号", "status": "idle",
    "agent": "agent-node:codex", "node_id": "n_a1b2c3d4",
    "last_seen_at": "2026-04-12 10:00:00", "network_id": "net_xxx"
  },
  "inbox_pending": 2,
  "recent_completions": [
    {
      "id": "uuid-xxx",
      "session_name": "代码1号",
      "task": "写排序算法",
      "result": "完成",
      "artifacts": null,
      "score": 8,
      "duration_minutes": 2,
      "network_id": "net_xxx",
      "completed_at": "2026-04-12 10:00:15"
    }
  ]
}
```

::: tip 返回值形状
- `session` 走 `SELECT * FROM sessions`（[`tools.ts:423`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L423)），完整 sessions 行（同 [`get_all_status`](#get-all-status) 的 session 行，**含 `model` 列** —— 见 get_all_status 说明）；alias 不存在时 `session` 为 `null` 但 `ok` 仍为 `true`
- `recent_completions` 走 `SELECT * FROM completions ... LIMIT 5`（[`tools.ts:433-435`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L433)），完整 9 列 completion 行（`id` / `session_name` / `task` / `result` / `artifacts` / `score` / `duration_minutes` / `network_id` / `completed_at`），按 `completed_at` 倒序最多 5 条
:::

---

### get_completions

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"get_completions"`（注册点在 `server/src/tools.ts`，全仓唯一）

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
  "completions": [
    {
      "id": "uuid-xxx",
      "session_name": "代码1号",
      "task": "写排序算法",
      "result": "使用快排实现...",
      "artifacts": "[\"/tmp/sort.py\"]",
      "score": 8,
      "duration_minutes": 2,
      "network_id": "net_xxx",
      "completed_at": "2026-04-12 10:00:15"
    }
  ]
}
```

`completions` 走 `SELECT * FROM completions WHERE completed_at >= <cutoff>`（[`tools.ts:938`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L938)），完整 9 列行，按 `completed_at` 倒序。`artifacts` 是 JSON 数组**字符串**（不是已解析的数组 —— `report_completion` 入库时 `JSON.stringify` 过）。`since` 不传默认 cutoff = 24 小时前。

---

## 广播工具

### broadcast

> [源码 ↗](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts) —— 搜 `"broadcast"`（注册点在 `server/src/tools.ts`，全仓唯一）

向所有在线 Agent 广播消息。**broadcast 与 `task` 同样会触发收件方 AI 处理**（[`agent-node/src/cli.ts`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts) 只对 `task` 和 `broadcast` 类型 think；其余 `reply` / `message` / `ack` 只展示）；如果只是想群发通知不要求 AI 回复，用循环 `send_message` 替代。完整消息类型对照见 [Task 生命周期 — 消息类型](/concepts/task-lifecycle#消息类型)。

**参数**（verify [`server/src/tools.ts:880-885`](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L880)）：

| 参数 | 类型 | 必需 | 说明 |
|------|------|:----:|------|
| `message` | string | &check; | 广播内容（最大 10000 字符） |
| `filter_server` | string | | 只发给指定 `server` 字段的 session |
| `filter_status` | string | | 只发给指定 status 的 session（如 `idle` / `working`） |
| `network_id` | string | | 网络 ID（只广播到该网络；utok\_ 调用时可指定，ntok\_ 调用强制绑当前 binding） |

> 字段名是 `message` 不是 `content`；`from_session` 不是参数（server 端硬编码为 `'hub'`）。

**返回值**：

```json
{
  "ok": true,
  "recipients": 10,
  "message_ids": ["uuid-xxx-1", "uuid-xxx-2"]
}
```

`message_ids` 长度 = `recipients`，每个 target session 一个 inbox row。

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
| `network_id_required` | 写操作无法确定目标 network：utok_ 调用方有 **0 个或 ≥2 个** network 成员身份，且未显式传 `network_id`。恰好 1 个成员身份时 hub 会**自动解析**，无需传。`message` 会区分是「无成员身份」还是「跨多个 network 需显式指定」 |
| `access_denied` | 显式传入的 `network_id` 指向一个调用方**不是成员**的 network |
| `permission_denied` | **viewer 角色**尝试写操作（viewer 只能读；owner/admin/member 可写） |
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
- [Runtimes](/guide/runtimes) — 各 runtime 都通过 MCP 跟 Hub 通信
- [Channel 插件](/guide/channels) — 自定义 MCP channel 怎么写

**实战**：
