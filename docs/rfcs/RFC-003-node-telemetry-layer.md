# RFC-003：Agent Node 遥测层 — 把 SDK 进度信号统一推到 Dashboard / SaaS Client

| 字段     | 内容                                                                                   |
| -------- | -------------------------------------------------------------------------------------- |
| 状态     | **草案**（等 Vincent / 通信龙 / N站马 review）                                          |
| 提出     | 2026-05-12                                                                             |
| 作者     | 通信SDK马                                                                              |
| 关联 issue | [#18](https://github.com/sleep2agi/agent-network/issues/18)                          |
| 关联 RFC | RFC-004（anet node chat REPL，独立 PR）                                                |
| 目标版本 | agent-node v2.4 / commhub-server v0.9 / dashboard v0.5                                 |
| 实施人   | 通信牛（commhub schema + agent-node 翻译层）/ N站马（dashboard UI）/ 通信SDK马（文档） |

## 摘要

`agent-node` 把 `claude-agent-sdk` / `codex-sdk` 的 streaming 事件流封装成统一的 `NodeEvent` schema，通过新增 `commhub_report_progress` MCP method 推到 commhub-server，在 SQLite 落 `progress_events` 表，最终经 SSE `progress` 事件类型派发给 Dashboard `<TaskChatPanel>` 和未来的 SaaS API client。

目标：**把当前 "派单后静默 5 分钟" 缩成 "实时看得到 agent 在做什么 / 卡在哪 / 怎么失败"**。

## 动机

### 现状 — 派单后静默

`agent-node/src/cli.ts:805-819` `processTask` 全流程：

```ts
await reportStatus("working", task.slice(0, 200)).catch(() => {});  // ← 进任务前推 1 次
let text = await think(task, from, taskId);                          // ← 这里 30s–10min 全静默
await reportStatus("idle").catch(() => {});                          // ← 出任务后推 1 次
```

`think()` 内部对两个 SDK 的 streaming 事件流**只消费 2/24（claude）/ 1/7（codex）**，其余 26+ 种进度/状态/错误事件全部丢进 `console.log`，不推 commhub，dashboard 看不到。

具体痛点（issue #18 Round 1-5 已记）：

1. **长任务静默**：dashboard chat 5 分钟内只看到 `status=working` + 200 字 task 预览，看不到 agent 在 read / edit / bash / 调 MCP / 等回包
2. **失败不结构化**：失败到了 dashboard 只是 `status=failed` + `result` 里的 raw error text，没有 error_code，没有 retryable 标记，没有 recovery 引导
3. **进度无可见**：subagent / todo_list / 工具调用 / 历史压缩等 in-flight 状态全是黑盒
4. **rate limit / quota 警告无感**：`SDKRateLimitEvent` 等明确事件 anet 当前丢弃
5. **SSE 故障静默**：（通信牛 log 实证 49 次 SSE 401）agent 看似 idle，inbox 堆积无人处理

### 实测痛点量化（2026-05-12 Vincent 反馈）

> **派活成功率并成功返回的成功率大概 60%**（Vincent 实测体感）

按 40% 失败率拆分，结合上面 5 条静默路径 + issue #18 Round 5 §A 的 6 大根因，这 40% 极可能由以下混合构成：

- SSE 401 + 无 poll fallback → inbox 堆积（A1）
- `thinkQueue` 死锁（A2）
- 8 条 silent skip 路径无感吞消息（A3）
- Codex thread 重建丢历史 + 降级返回 \"（无回复）\"（A4）
- `sendReply` 重试耗尽 catch 吞错（A5）
- Codex auth/升级提示卡 stdin（A6）

**关键观察**：当前**没有任何遥测能区分这 6 类失败**。RFC-003 落地后，`progress_events` 表的 `error_code` 字段第一次让 \"60% 是 anecdote\" 变成 \"按 error_code 分布的可度量数字\"。

> ⚠️ 60% 也是 **SaaS-mode 的硬阻塞**：客户不可能基于 60% 成功率的后端做产品。RFC-003 既是 SaaS 前置依赖，也是把它从 60% 推到 95%+ 的诊断起点。

### 现状 — SDK 暴露面被丢弃的事件清单

#### claude-agent-sdk

`SDKMessage` union 24 个变体，anet 当前消费 2 个：

| 类别 | 消费率 | 关键漏掉的事件 |
|---|---|---|
| 核心 (system/result) | 2/2 ✅ | — |
| Streaming text | 0/2 | `SDKAssistantMessage` / `SDKPartialAssistantMessage` |
| 工具调用 | 0/2 | `SDKToolProgressMessage` / `SDKToolUseSummaryMessage` |
| Task / Subagent | 0/3 | `SDKTaskStartedMessage` / `SDKTaskProgressMessage` / `SDKTaskNotificationMessage` |
| 状态变化 | 0/3 | `SDKStatusMessage` / `SDKSessionStateChangedMessage` / `SDKAuthStatusMessage` |
| Rate limit / retry | 0/2 | `SDKRateLimitEvent` / `SDKAPIRetryMessage` |
| Hook 周期 | 0/3 | `SDKHookStartedMessage` / `SDKHookProgressMessage` / `SDKHookResponseMessage` |
| Compaction | 0/1 | `SDKCompactBoundaryMessage` |
| 文件 checkpoint | 0/1 | `SDKFilesPersistedEvent` |
| MCP / 命令 | 0/2 | `SDKElicitationCompleteMessage` / `SDKLocalCommandOutputMessage` |
| Prompt UX | 0/1 | `SDKPromptSuggestionMessage` |

`HookEvent` 27 种，anet 当前用 1 个（`PreToolUse` 只打 log），其余 26 个未注册。关键未用：`PostToolUse` / `PostToolUseFailure` / `PreCompact` / `PostCompact` / `TaskCreated` / `TaskCompleted` / `SubagentStart` / `SubagentStop` / `Stop` / `StopFailure` / `Notification` / `PermissionDenied`。

#### codex-sdk

`ThreadEvent.item` 8 种类型，anet 结构化消费 1 种：

| item.type | anet 当前处理 |
|---|---|
| `agent_message` | ✅ 当 finalResponse |
| `command_execution` | 🟡 debug log only |
| `reasoning` | 🟡 debug log only |
| `mcp_tool_call` | 🟡 debug log only |
| `file_change` | ❌ |
| `web_search` | ❌ |
| `todo_list` | ❌（**关键漏失**：codex 原生 to-do plan） |
| `error` | ❌（非 fatal） |

## 设计

### 1. NodeEvent — agent-node 内部抽象

新文件 `agent-node/src/events.ts`：

```ts
export type ProgressKind =
  | 'turn_start'
  | 'thinking'              // claude SDKStatusMessage 'compacting' / partial assistant
  | 'tool_start'
  | 'tool_end'
  | 'todo_update'           // codex todo_list / claude TodoWrite hook
  | 'subagent_start'        // claude SDKTaskStartedMessage
  | 'subagent_end'          // claude SDKTaskNotificationMessage
  | 'rate_limit'            // claude SDKRateLimitEvent
  | 'compact'               // claude SDKCompactBoundaryMessage / codex auto-compact
  | 'error'
  | 'turn_end';

export type SubState =
  | 'planning'              // todo_list 刚生成或 reasoning 占主导
  | 'tool_running'
  | 'tool_waiting_io'       // 长跑命令 stdout 久无输出（>5s）
  | 'mcp_call'
  | 'compacting'
  | 'rate_limited'
  | 'idle';

export type ErrorCode =
  | 'sse_token_expired'     // A1 in issue #18 Round 5
  | 'task_timeout'          // A2
  | 'message_skipped'       // A3（带 reason）
  | 'thread_reset_lost'     // A4（codex 重建丢历史）
  | 'commhub_unreachable'   // A5
  | 'codex_stdin_hung'      // A6
  | 'rate_limit'
  | 'max_turns'
  | 'auth_failed'
  | 'tool_error';

export type ProgressPayload =
  | { kind: 'tool_start'; tool_name: string; tool_use_id: string; args_preview: string }
  | { kind: 'tool_end';   tool_use_id: string; ok: boolean; duration_ms: number; output_preview?: string; exit_code?: number }
  | { kind: 'todo_update'; items: { text: string; completed: boolean }[]; from: 'codex_native' | 'claude_todowrite' }
  | { kind: 'subagent_start'; sub_task_id: string; description: string; task_type?: string }
  | { kind: 'subagent_end';   sub_task_id: string; status: 'completed' | 'failed' | 'stopped'; summary: string }
  | { kind: 'rate_limit'; resets_at_ms: number; limit_type: string; utilization?: number }
  | { kind: 'compact'; phase: 'pre' | 'post'; tokens_before?: number; tokens_after?: number }
  | { kind: 'thinking'; preview?: string }
  | { kind: 'turn_start' | 'turn_end'; tokens_in?: number; tokens_out?: number; cost_usd?: number };

export interface NodeEvent {
  alias: string;
  task_id: string;
  parent_progress_id?: string;        // claude subagent 嵌套时引用父 progress.id
  origin: 'claude_sdk' | 'codex_sdk' | 'http_api' | 'claude_cli';
  kind: ProgressKind;
  substate?: SubState;
  ts_ms: number;
  payload?: ProgressPayload;
  error?: { code: ErrorCode; message: string; retryable: boolean };
}
```

### 2. 两个 adapter — 把 SDK 事件流翻译成 NodeEvent

`agent-node/src/adapters/claude-adapter.ts`：消费 `SDKMessage` + `HookEvent` → NodeEvent stream。

```ts
// 概念示意（不含完整实现）
for await (const m of query({ prompt, options: { hooks: { ... } } })) {
  switch (m.type) {
    case 'system':
      if (m.subtype === 'task_started') emit({ kind: 'subagent_start', /* ... */ });
      break;
    case 'tool_progress':
      emit({ kind: 'tool_start', substate: 'tool_running', /* ... */ });
      break;
    case 'rate_limit_event':
      emit({ kind: 'rate_limit', substate: 'rate_limited', /* ... */ });
      break;
    // ... 24 个 SDKMessage 分支 + 27 个 hook event 分支
  }
}
```

`agent-node/src/adapters/codex-adapter.ts`：消费 `ThreadEvent` → NodeEvent stream。

```ts
for await (const ev of events) {
  if (ev.type === 'item.started') {
    const it = ev.item;
    if (it.type === 'command_execution') emit({ kind: 'tool_start',  /* ... */ });
    if (it.type === 'todo_list')         emit({ kind: 'todo_update', payload: { items: it.items, from: 'codex_native' } });
    // ... 7 个 item type 分支
  }
  if (ev.type === 'item.completed') { /* tool_end / subagent_end / ... */ }
  if (ev.type === 'turn.failed')    emit({ kind: 'error', error: { code: 'tool_error', message: ev.error.message, retryable: true } });
}
```

### 3. commhub MCP — 新增 `report_progress` method

`commhub-server/src/mcp.ts`：在现有 `report_status` / `send_task` / `get_inbox` 旁加 `report_progress`。

请求 schema：

```ts
interface ReportProgressArgs {
  alias: string;
  task_id: string;
  parent_progress_id?: string;
  origin: string;                       // NodeEvent.origin
  kind: string;                         // NodeEvent.kind
  substate?: string;
  ts_ms: number;
  payload?: Record<string, unknown>;    // 任意 JSON，schema 由 kind 决定
  error_code?: string;
  error_message?: string;
  retryable?: boolean;
}
```

Server 行为：

1. 鉴权同 `report_status`（要求 `ntok_` 节点 token + network 校验）
2. INSERT 进 `progress_events` 表
3. 通过 SSE 把事件转发给 `/events/:alias` 订阅者（含 dashboard 和未来的 SaaS API client）
4. 不阻塞调用方 —— 即使转发失败也 200，progress 是 best-effort

### 4. SQLite schema — 新表 `progress_events`

```sql
CREATE TABLE progress_events (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id             TEXT NOT NULL,         -- 关联 messages.id
  alias               TEXT NOT NULL,
  network_id          TEXT,                  -- 多租户隔离
  parent_progress_id  TEXT,                  -- 嵌套（subagent）
  origin              TEXT NOT NULL,         -- claude_sdk / codex_sdk / ...
  kind                TEXT NOT NULL,         -- ProgressKind
  substate            TEXT,                  -- SubState
  ts_ms               INTEGER NOT NULL,
  payload             TEXT,                  -- JSON
  error_code          TEXT,
  error_message       TEXT,
  retryable           INTEGER,               -- 0/1
  created_at          TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_progress_task   ON progress_events(task_id, ts_ms);
CREATE INDEX idx_progress_alias  ON progress_events(alias, ts_ms);
CREATE INDEX idx_progress_kind   ON progress_events(kind);
```

存储估算：每个 task 平均产生 20–50 条 progress events × ~300 字节 = 6–15 KB/任务。**SQLite-only** 部署完全够用（每 10 万任务 ~1 GB，可用 cron job 按 task_id age 归档）。

### 5. SSE 多路 — `/events/:alias` 加 `progress` event type

现有 SSE 推三类：`new_task` / `broadcast` / `new_reply`。新增第 4 类：`progress`：

```
event: progress
data: {"alias":"通信牛","task_id":"...","kind":"tool_start","payload":{"tool_name":"Bash","args_preview":"grep -r ..."},"ts_ms":1715432100000}

event: progress
data: {"alias":"通信牛","task_id":"...","kind":"tool_end","payload":{"tool_use_id":"...","ok":true,"duration_ms":1200}}

event: progress
data: {"alias":"通信牛","task_id":"...","kind":"error","error":{"code":"rate_limit","message":"...","retryable":true}}
```

Dashboard `eventSource.addEventListener('progress', ...)` 监听。

### 6. Dashboard UI — `<ProgressTimeline>`

挂载在 `<TaskChatPanel>` 内（N站马 已确认 `<TaskChatPanel>` 在 `/node` 和 dispatch 抽屉），布局：

```
┌─ TaskChatPanel ──────────────────────────────────┐
│ User: 帮我把 docs 改成中文，先列计划                │
│                                                  │
│ 🤖 Agent (claude-agent-sdk):                      │
│   ⏳ planning...   [Task: docs-translator]   ← parent
│       └─ ⏳ tool: Read docs/zh/intro.md     [tool] ← child
│       └─ ✅ tool: Edit docs/zh/intro.md  (1.2s)
│       └─ ⏳ tool: Read docs/zh/cli.md  (8s)         ← substate='tool_running'
│   ✅ subagent docs-translator: 3 files edited      ← turn_end summary 折叠
│                                                  │
│   final: 已完成 docs/zh/{intro,cli,faq}.md 中文化…  ← reply 主体
└──────────────────────────────────────────────────┘
```

关键交互：

- subagent 进行中：父行 spinner，子行实时刷 substate
- subagent 结束：父子全部折叠为一行 `✅ subagent <name>: <summary>`，点击可展开
- turn 结束：整个 timeline 自动折叠为一行 `⏱ 3 subagents · 12 tools · 47s · $0.0234`
- 失败：错误 banner（红 / 黄 / 灰按 error_code 区分），retryable=true 时显示重试按钮

### 7. SaaS API 视角 — 给固定 skills 的 client 看的 job status API

SaaS client 通过 commhub REST 派任务后，可用以下 endpoint 拿进度：

```
GET /api/jobs/:task_id/progress
  → SSE stream of progress events（server forward progress_events 表的实时插入）

GET /api/jobs/:task_id/timeline
  → JSON array of all events to-date（for late subscribers）

GET /api/jobs/:task_id/result
  → final reply（existing /api/hub/tasks reply）
```

SaaS 模式典型用法（详见 [docs/saas-skills-mode.md](../saas-skills-mode.md)）：

```bash
curl -X POST https://hub.example/api/jobs \
  -H "Authorization: Bearer utok_..." \
  -d '{ "skill": "translate-en-zh", "input": { ... } }'
# → { "task_id": "job_abc123" }

curl https://hub.example/api/jobs/job_abc123/progress
# → SSE stream:
#   event: progress
#   data: {"kind":"tool_start","payload":{"tool_name":"Read",...}}
#   ...
#   event: progress
#   data: {"kind":"turn_end","payload":{"cost_usd":0.0234,...}}
```

## 实施步骤（Phase 编排）

| Phase | 内容 | 谁 | 风险 |
|---|---|---|---|
| **P0** | `agent-node` 在 claude 的 `PreToolUse` hook 和 codex 的 `item.started` 分支加 `throttledReport()`（2s 节流），复用现有 `report_status.task` 字段推工具进度文字。dashboard 不改 schema 只触发 re-render。"30 行代码立刻把静默缩成 2s 刷新" | 通信牛 / 通信SDK马 | 低，复用现有 schema，回滚容易 |
| **P1a** | commhub schema：新建 `progress_events` 表 + 加 `report_progress` MCP method + SSE `progress` event 派发 | 通信牛 | 中，DB schema 变更 |
| **P1b** | agent-node 翻译层：`events.ts` + `claude-adapter.ts` + `codex-adapter.ts` 替换 P0 临时方案 | 通信SDK马 / 通信牛 | 中 |
| **P1c** | dashboard：`<ProgressTimeline>` 组件 + SSE 订阅 | N站马（r48 后） | 中 |
| **P2** | 结构化错误：`error_code` + `error_message` + `retryable` 三段在 dashboard 渲染不同 banner + 重试按钮 | 全员 | 低，schema 已加 |
| **P3** | SaaS API endpoints：`/api/jobs/:id/progress` 等给 SaaS client 用 | 通信牛 | 中（依赖 P1a） |

## 影响面

- `agent-node` v2.4：新增 `src/events.ts` + `src/adapters/`，cli.ts 替换 `processWithClaude` / `processWithCodex` 主循环（保留原逻辑作 fallback flag）
- `commhub-server` v0.9：新表 + 新 method + SSE 多路；现有 `report_status` 行为不变
- `agent-network-dashboard` v0.5：新组件 + SSE 订阅；现有 `<TaskChatPanel>` 不动主结构
- `@sleep2agi/agent-network` CLI：不变（除非加 `anet jobs progress <task_id>` 命令，见 RFC-004 一并设计）

## 风险与回滚

1. **SDK schema 漂移**：claude-agent-sdk 0.x 仍在迭代，新 SDKMessage 变体可能被加入。adapter 用 default branch 兼容未知 kind（emit `kind: 'unknown'`），避免 crash。
2. **progress 推送 spam**：长任务一秒可产生几十个 SDKMessage，单 task 一万条 progress 撑爆 SQLite。**强制 2s throttle + 客户端可订阅特定 kind 子集**（`/api/jobs/:id/progress?kinds=tool_start,error`）。
3. **多租户串频道**：commhub SSE 默认按 alias 隔离，但 SaaS 场景需按 network_id 进一步隔离 —— `report_progress` 必须校验 caller `ntok_` 的 network。
4. **回滚**：P0 完全独立可关；P1a 起的 schema 变更需要标准 migration（参考 [docs/v3-postgresql-design.md](../v3-postgresql-design.md) 的迁移路径，但 SQLite-only 路径简单：新表加索引，旧版客户端忽略）。

## 测试

沿用 issue #18 Round 1.5 提出的 25 条 Dashboard chat 测试矩阵 + Round 4 / Round 5 增补，关键：

- L1.4 "长任务 >30s 看得到进度" — P0 后转 ⚠️（粗），P1 后 ✅
- L1.5 "多步推理 todo / tool 可见" — P1c 后 ✅
- L2.5 "claude subagent 嵌套渲染" — P1c 后 ✅
- L5.1 "rate_limit AlertBanner" — P2 后 ✅
- L5.5 "max_turns 结构化" — P2 后 ✅
- L5.6 "codex thread reset 可见" — P2 后 ✅
- L7.4 "SSE 401 失效时仍能用 anet node chat" — RFC-004 范畴

## 关联

- 派生 issue：[#18](https://github.com/sleep2agi/agent-network/issues/18) 的 Round 1-5 评论是本 RFC 的研究素材池
- [docs/saas-skills-mode.md](../saas-skills-mode.md)：SaaS 化方向 sketch，本 RFC 是其前置依赖
- RFC-004：anet node chat REPL，独立 PR
- RFC-001 已采纳的 `ntok_` 鉴权体系：`report_progress` 复用同一鉴权路径

## 状态变更

- 2026-05-12：草案提出（通信SDK马），等 Vincent / 通信龙 / N站马 review
