# CommHub 消息生命周期设计

> 状态：草稿 → **基本落地**（2026-05-12 对齐 v0.8.2） | 日期：2026-04-10 | 作者：SDK马
>
> v0.6 ~ v0.8 已 ship 的部分：
> - `requires_response` 字段区分 reply / ack / none 三种行为
> - task vs message 双轨：task 进 `tasks` 表走完整生命周期，message 只进 `messages` 表
> - `from_session` + `in_reply_to` 串联对话链
> - SSE 推送 task 不推普通 message（避免 think 循环）
>
> 公开版用户视角的简化说明见 [Task 生命周期](https://anet.sh/concepts/task-lifecycle)。本文保留为内部技术设计参考。

---

## 动机

所有消息都当 task 处理 → agent 收到回复也 think → sendReply → 对方收到又 think → 循环。需要区分消息类型，不同类型不同行为。

## 消息类型

| 类型 | 语义 | 例子 |
|------|------|------|
| `task` | 正式任务，需要 AI 处理并回复 | "分析这段代码的安全性" |
| `reply` | 对 task 的结果回复，关联 task_id | "[SDK马] 发现 3 个 XSS 漏洞..." |
| `message` | 聊天/通知，不强制处理 | "今天辛苦了" |
| `ack` | 纯确认，极轻量 | "收到" / "✅" |

## 行为矩阵

| 行为 | task | reply | message | ack |
|------|------|-------|---------|-----|
| 入 inbox | ✅ | ✅ | ✅ | ❌ |
| SSE push event | `new_task` | `new_reply` | `new_message` | ❌ |
| agent-node processInbox | ✅ think | ❌ 不处理 | ❌ 不处理 | ❌ |
| Claude Code channel 注入 | ✅ `<channel>` | ✅ `<channel>` | ✅ `<channel>` | ❌ |
| 需要回复 | ✅ | ❌ | ❌ | ❌ |
| 关联字段 | — | task_id | — | task_id |

**核心规则：只有 `task` 和 `broadcast` 触发 think，其余只展示/记录。**

> 验证：[`agent-node/src/cli.ts:864`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L864) `if (msgType !== "task" && msgType !== "broadcast") { ... continue; }`（R218 校准：原 doc 行号 886，当前 main 实际 864）。Public docs [concepts/task-lifecycle.md 消息类型](https://anet.sh/concepts/task-lifecycle#消息类型) 表里 task / broadcast 两行 ✓ 触发 AI；reply / message / ack 不触发。

## inbox 表改动

```sql
-- 现有
type TEXT DEFAULT 'task'  -- 当前只有 task / message / broadcast

-- 改为
type TEXT DEFAULT 'task'  -- task / reply / message / ack / broadcast
reply_to TEXT             -- 关联的原始 task message_id（reply 和 ack 用）
```

## API 改动

### CommHub MCP 工具

```
send_task(alias, task, priority, from_session)
  → type='task', 入 inbox, push new_task

send_reply(alias, text, task_id, from_session)       ← 新增
  → type='reply', 入 inbox, push new_reply, 关联 task_id

send_message(alias, message, from_session)
  → type='message', 入 inbox, push new_message

send_ack(alias, task_id, from_session)                ← 新增
  → type='ack', 不入 inbox, 不 push（或 push 给发送者作为回执）
```

### REST API

```
POST /api/task    → type='task'（现有）
POST /api/reply   → type='reply'（新增）
POST /api/message → type='message'（新增或复用现有）
```

## agent-node 改动

### processInbox 按类型分流

```typescript
async function processInbox() {
  const messages = await getInbox();
  for (const msg of messages) {
    await ackMessage(msg.id);

    switch (msg.type) {
      case "task":
      case "broadcast":
        // task + broadcast 都触发 think（agent-node/src/cli.ts:864 `msgType !== "task" && msgType !== "broadcast"`；详见上方"消息类型"说明）
        const result = await processTask(msg.content, from);
        await sendReply(from, result, msg.id);  // reply 关联 task_id
        break;

      case "reply":
        // 对方的回复，只记录日志
        log(`← reply [${from}] ${msg.content.slice(0, 80)}`);
        break;

      case "message":
        // 聊天消息，只记录
        log(`← msg [${from}] ${msg.content.slice(0, 80)}`);
        break;

      // ack 不入 inbox，不会到这
    }
  }
}
```

### sendReply 改签名

```typescript
// 现有
sendReply(target, message)  → send_message

// 改为
sendReply(target, text, taskId)  → send_reply（新 MCP 工具）
```

## commhub-channel.ts 注入格式

::: warning R218 校准：实际未带 `type=` 属性
[`channel/commhub-channel.ts:125`](https://github.com/sleep2agi/agent-network/blob/main/channel/commhub-channel.ts#L125) 实际描述为 `<channel source="commhub" task_id="..." priority="..." from="...">`（属性名 `from=` 不是 `sender=`，没有 `type=` 属性）。本节最初的设计意图（XML 带 `type="task"` / `type="reply"` / `type="message"`）**没有采纳** —— 类型区分实际靠 SSE event type（`new_task` / `new_reply` / `new_message`）+ agent 侧 inbox row 的 `type` 字段，不在 XML 里露出。
:::

```xml
<!-- task / broadcast 实际格式（commhub-channel.ts:414-419 + node-server.ts 同样格式） -->
<channel source="commhub" task_id="xxx" priority="high" from="指挥室">
任务内容
</channel>

<!-- new_message 实际格式 (commhub-channel.ts:374-385) -->
<channel source="commhub" from="通信龙" priority="normal">
消息内容
</channel>
```

Claude Code 收到 reply 和 message 时只需要阅读，不需要 send_task 回复（agent-node 侧在 [`cli.ts:864`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L864) 直接跳过非 task/broadcast 类型，channel wrapper 走 `notifications/claude/channel` 让 Claude Code 自己决定是否回复）。

## 向后兼容

### 过渡期（P0）

不改 CommHub 协议。agent-node 用现有的 `type` 字段 + 行为约定：

```
agent-node sendReply → send_message（已改 v1.4.2）
  → CommHub type='message'
  → SSE push new_message
  → 对方 agent-node：message 不触发 processInbox（已有）
  → 对方 Claude Code：channel 注入，但 CLAUDE.md 说"不要对 message 回复确认"
```

**P0 不需要改协议**，只需要：
1. agent-node 的 sendReply 用 send_message ✅ (v1.4.2)
2. CLAUDE.md 规则改为"不对 message 类型回复确认"
3. agent-node processInbox 只处理 type=task

### 完整实现（P1）— R218 校准：基本完成

| # | 改动 | 状态 | 落地位置 |
|---|------|------|------|
| 1 | CommHub server 加 `send_reply` / `send_ack` 工具 | ✅ shipped | [server/src/tools.ts:1816 send_reply](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L1816) + [tools.ts:1830 send_ack](https://github.com/sleep2agi/agent-network/blob/main/server/src/tools.ts#L1830) |
| 2 | inbox 表加 `in_reply_to` 字段 | ✅ shipped | [server/src/db.ts:72 + db.ts:98](https://github.com/sleep2agi/agent-network/blob/main/server/src/db.ts#L72)（字段名实际叫 `in_reply_to` 不是设计草稿里的 `reply_to`） |
| 3 | agent-node `sendReply` 改用 `send_reply` | ✅ shipped | agent-node 用 `send_reply` MCP tool 关联 task_id |
| 4 | commhub-channel.ts 带 `type` 标记 | ❌ **未采纳** | XML 不带 `type=`；类型区分靠 SSE event type + inbox row.`type` 字段（见上节 ::: warning） |

## SSE push 事件区分

| 消息类型 | SSE event.type | agent-node 行为 |
|---------|---------------|----------------|
| task | new_task | processInbox → think |
| reply | new_reply | 日志记录 |
| message | new_message | 日志记录 |
| broadcast | broadcast | processInbox → think |
| ack | (不 push) | — |

agent-node 当前只响应 `new_task` 和 `broadcast`：

```typescript
if (["new_task", "broadcast"].includes(ev.type)) {
  await processInbox();
}
// new_reply, new_message → 不处理
```

**这是最干净的解法**：SSE event type 就决定了是否触发 think，不需要在 processInbox 里再按 type 分流。

## P0 最小改动清单 — R218 校准：全部落地

| # | 改动 | 在哪改 | 状态 |
|---|------|--------|------|
| 1 | sendReply 用 send_message | agent-node | ✅ v1.4.2 |
| 2 | SSE 只响应 new_task / broadcast | agent-node | ✅ [cli.ts:1102 `["new_task", "broadcast"].includes(ev.type)`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L1102)；`new_reply` 单独走日志记录 cli.ts:1106 |
| 3 | 低价值消息过滤 | agent-node | ✅ v1.4.0；当前在 [cli.ts:4691 `shouldSkipMessage`](https://github.com/sleep2agi/agent-network/blob/main/agent-node/src/cli.ts#L4691) |
| 4 | CLAUDE.md 不对 message 回复 | 各项目 CLAUDE.md | ✅ R195 chain 模板已加 |
| 5 | developer_instructions 安静规则 | agent-node | ✅ v1.4.1 |

## 决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | 4 种消息类型 | 覆盖所有场景 |
| 2 | 只 task 触发 think | 断掉循环根因 |
| 3 | ack 不入 inbox | 纯确认无需持久化 |
| 4 | reply 关联 task_id | 可追踪任务完成链 |
| 5 | P0 不改协议 | 用现有 type + SSE event 区分 |
| 6 | SSE event type 决定行为 | 最干净，不在 inbox 层再分流 |

---

**请通信牛 review。文件路径: ~/agent-orchestra/docs/message-lifecycle.md**
