# Channel 通信方案调研：mcp-wechat-server + codex-plugin-cc + CommHub Channel

> 日期: 2026-04-02
> 方法: 源码级深入分析（clone 仓库 + 读本地 `~/.claude/plugins/` 代码）
> 目的: 找出可借鉴的设计模式，改进 CommHub Channel

---

## 调研对象

| 项目 | 仓库 | 定位 | 技术栈 |
|------|------|------|--------|
| **mcp-wechat-server** | [Howardzhangdqs/mcp-wechat-server](https://github.com/Howardzhangdqs/mcp-wechat-server) | WeChat iLink Bot 的 MCP Server | Bun + MCP SDK + stdio |
| **codex-plugin-cc** | [openai/codex-plugin-cc](https://github.com/openai/codex-plugin-cc) | Claude Code 内调用 Codex 的官方插件 | Node.js + JSON-RPC + app-server |
| **CommHub Channel** | 本仓库 `channel/commhub-channel.ts` | 跨服务器 Agent 编排通信 | Bun + MCP SDK + stdio + SSE |

> **注**: "cc-connect" 并非独立项目。实际的 Codex-Claude Code 连接器是 `openai/codex-plugin-cc`（Claude Code 插件）。

---

## 1. mcp-wechat-server 源码分析

### 1.1 架构

```
Claude Code / Claude Desktop
     │  stdio (MCP)
     ▼
mcp-wechat-server (MCP Server, StdioServerTransport)
     │  HTTP POST (long-poll)
     ▼
WeChat iLink Bot API (ilinkai.weixin.qq.com)
     │
     ▼
WeChat 用户
```

纯 MCP stdio server，6 个 tool。核心循环：LLM 调 `get_messages(wait=true)` → MCP server 内部 long-poll iLink API → 返回消息 → LLM 处理 → 调 `send_text_message` 回复。

### 1.2 消息获取：阻塞式 long-poll

**源码位置**: `src/tools/messages.ts:35-101`

```typescript
// 关键逻辑
const pollMs = input.wait ? LONG_POLL_MS : (input.timeout ?? 10000);  // 25s per round
const deadline = input.wait ? Date.now() + 7 * 24 * 3600_000 : 0;     // 7 天上限

while (true) {
  const resp = await getUpdates({ updatesBuf: state.updatesBuf, timeoutMs: pollMs });
  // ...filter and return if new messages found
  if (!input.wait) return { messages: [] };  // non-blocking mode returns immediately
}
```

**机制**：`get_messages` tool 调用本身会**阻塞**最长 7 天，内部 25 秒一轮 long-poll。这意味着 LLM 的 tool call 在等待期间不会返回——**LLM 被当作事件循环的驱动器**。

**致命依赖**: tool description 中写了详细的行为指令（何时调 typing indicator、超时设多长），完全依赖 LLM 遵守。如果 LLM 不调 `get_messages(wait=true)`，整个系统就停了。

### 1.3 消息去重：双层水位线

**源码位置**: `src/tools/messages.ts:59-69`

```typescript
// 第一层：服务端游标（opaque token）
if (resp.get_updates_buf) {
  state.updatesBuf = resp.get_updates_buf;  // 传给下一次 getUpdates
}

// 第二层：客户端消息 ID 水位线
const newMessages = resp.msgs?.filter(
  (m) => m.message_type === 1 && m.message_id && m.message_id > state.lastMessageId,
) ?? [];
```

- **第一层 `updatesBuf`**: iLink API 返回的 opaque cursor，传回去告诉服务端"这些我都看过了"
- **第二层 `lastMessageId`**: 单调递增 ID 水位线，客户端侧二次过滤，防止服务端 cursor 失效时重复
- **无 Set 去重**: 不维护"已处理消息 ID 集合"——水位线足够，因为 iLink message_id 保证单调递增

**对比 CommHub**: CommHub 用 `ack_inbox(message_id)` 标记已确认，是**显式 ACK** 模式。mcp-wechat-server 是**隐式水位线**模式。

### 1.4 状态持久化：JSON 文件

**源码位置**: `src/store/account.ts`

```typescript
export const DATA_DIR = path.join(os.homedir(), ".mcp-wechat-server");

// 同步读写，每次 getMessages 成功后立即 saveState
function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}
```

| 文件 | 内容 | 写入时机 |
|------|------|---------|
| `account.json` | botToken, botId, userId, baseUrl (chmod 600) | 登录成功 |
| `state.json` | updatesBuf (cursor), lastMessageId (水位线), contextTokens | 每次 getMessages 后 |
| `qr_login.json` | QR 码字符串 + URL + 创建时间 (5分钟 TTL) | 生成 QR 码时 |

**特点**: 全同步 I/O（`readFileSync`/`writeFileSync`），简单但会阻塞事件循环。对这个场景够用——消息量不大。

### 1.5 值得借鉴的设计

1. **chmod 600 保护凭证文件** — `account.json` 设置 `0o600` 权限
2. **QR 码 TTL 复用** — 5 分钟内重复调用不重新生成
3. **context_token 持久化** — 按 `botId:userId` 对存储对话上下文 token，重启不丢
4. **AbortError 优雅处理** — long-poll 超时返回空结果而非 throw

---

## 2. codex-plugin-cc 源码分析

### 2.1 架构

```
Claude Code
     │  Plugin System (slash commands + hooks)
     ▼
codex-companion.mjs (orchestrator)
     │  JSON-RPC over stdio 或 Unix socket
     ▼
app-server-broker.mjs (可选, 会话复用)
     │  JSON-RPC over stdio
     ▼
codex app-server (Codex agent engine)
     │
     ▼
OpenAI API (GPT-5.4)
```

**关键发现**: 这不是 MCP server，也不用 WebSocket/HTTP。它是 Claude Code **原生插件**，通过 Claude Code 的 slash command 系统集成，底层用 Codex 自己的 **JSON-RPC app-server 协议**。

### 2.2 通信协议：JSON-RPC over NDJL

**源码位置**: `plugins/codex/scripts/lib/app-server.mjs`

两种传输模式：

| 模式 | 类 | 传输 | 场景 |
|------|---|------|------|
| 直连 | `SpawnedCodexAppServerClient` | spawn 子进程，stdin/stdout pipe | 一次性任务 |
| Broker | `BrokerCodexAppServerClient` | Unix domain socket (`unix:/path/broker.sock`) | 会话持久化 |

消息格式：每行一条 JSON（NDJL = Newline Delimited JSON Lines），**省略 `"jsonrpc":"2.0"` 字段**。

### 2.3 Broker 模式：单 Codex 多客户端

**源码位置**: `plugins/codex/scripts/app-server-broker.mjs`

Broker 是这个插件最精妙的设计。它解决了一个关键问题：**多个 slash command 需要共享同一个 Codex app-server 进程**。

```
/codex:review ──┐
                │  Unix socket
/codex:rescue ──┼──▶ broker.mjs ──stdio──▶ codex app-server
                │
/codex:status ──┘
```

**独占访问机制**:
- 同一时间只有一个客户端可以发 request（`activeRequestSocket`）
- 第二个客户端连上时收到 `-32001 BROKER_BUSY`
- **例外**: `turn/interrupt` 可以被其他客户端发送（用于中断正在执行的任务）

**通知路由**:
- Broker 追踪 `activeStreamSocket`（当前 turn 的发起者）
- `turn/completed` 后释放 stream ownership
- 通知只发给发起者，不广播

**会话持久化**:
- Broker 进程信息（endpoint, PID, log path）保存到 `broker.json`
- Claude Code 退出时（`SessionEnd` hook）关闭 broker
- 下次启动 Claude Code 时（`SessionStart` hook）重新创建

### 2.4 Turn 捕获状态机

**源码位置**: `plugins/codex/scripts/lib/codex.mjs` — `captureTurn()`

这是最复杂的部分。Codex 可以 spawn 子 Agent（`collabAgentToolCall`），状态机需要追踪：

```typescript
// TurnCaptureState 追踪的状态
{
  rootThreadId,           // 主 thread
  spawnedThreadIds: Set,  // 子 agent 的 thread
  turnIds: Map,           // thread → turn ID 映射
  pendingCollabs: Map,    // 等待中的协作 tool call
  activeSubagentTurns: Set,  // 活跃的子 agent turn
  bufferedNotifications,  // 缓冲的通知
  reasoningSummaries,     // 推理摘要
  fileChanges,            // 文件变更
  commandExecutions,      // 命令执行
  finalAgentMessage,      // 最终回复
  reviewText,             // 审查文本
}
```

**完成推断**: 主 thread 的回复到了，但子 agent 还在跑 → 250ms 定时器检查 → 所有子 agent 完成 → 推断整体完成。

### 2.5 后台任务执行

**源码位置**: `plugins/codex/scripts/lib/codex.mjs` — `spawnDetachedTaskWorker()`

```
Claude Code ──spawn──▶ detached task-worker 进程
                            │
                            ├── 读取 job file
                            ├── 连接 app-server
                            ├── 执行 turn
                            ├── 写入 log file
                            └── 更新 job status
```

- Job 记录保存在 state 目录的 JSON 文件中
- `/codex:status` 读取 job 状态
- `/codex:result` 读取完成的 job 输出

### 2.6 Stop Review Gate

**源码位置**: `plugins/codex/scripts/stop-review-gate-hook.mjs`

Claude Code 的 `Stop` hook 拦截每次停止操作：
1. 读取 Claude 最后的 assistant message
2. 用 `stop-review-gate.md` 模板构建 prompt
3. 同步调用 Codex (`spawnSync`)
4. 解析输出第一行 `ALLOW:` 或 `BLOCK:`
5. 返回 `{ decision: "block", reason: "..." }` 阻止不当停止

### 2.7 核心问题：Codex 怎么和 Claude Code 连接的？

**Q1: 用什么协议连 Codex？**

JSON-RPC 2.0（省略 `jsonrpc` 字段），通过 NDJL (Newline Delimited JSON Lines) 传输。两种传输方式：

```
方式 1 (直连): Claude Code → spawn("codex", ["app-server"]) → stdin/stdout pipe
方式 2 (Broker): Claude Code → Unix socket → broker.mjs → stdin/stdout → codex app-server
```

源码位置: `~/.claude/plugins/marketplaces/openai-codex/plugins/codex/scripts/lib/app-server.mjs`

```javascript
// 直连模式 (SpawnedCodexAppServerClient)
this.proc = spawn("codex", ["app-server"], {
  cwd: this.cwd,
  stdio: ["pipe", "pipe", "pipe"]
});

// Broker 模式 (BrokerCodexAppServerClient)
this.socket = net.createConnection({ path: target.path }); // Unix domain socket
```

**Q2: Claude Code 怎么调起的？**

通过 Claude Code **原生插件系统**（不是 MCP Tool，不是 Channel）。插件注册 slash command：

- `/codex:review` → 标准代码审查
- `/codex:rescue` → 委托任务给 Codex
- `/codex:setup` → 配置
- `/codex:status` → 查看后台任务
- `/codex:result` → 获取任务结果

源码入口: `codex-companion.mjs` 接收 slash command 参数，分发到对应处理函数。

**Q3: Codex 结果怎么传回 Claude Code？**

通过 JSON-RPC 通知流式返回。关键通知类型：

| 通知 | 内容 |
|------|------|
| `item/agentMessage/delta` | Agent 文本流式片段 |
| `item/commandExecution/outputDelta` | 命令执行输出 |
| `item/fileChange/outputDelta` | 文件修改内容 |
| `turn/completed` | turn 结束，包含最终状态 |

`codex.mjs` 中的 `captureTurn()` 状态机收集所有通知，在 `turn/completed` 时聚合为最终结果，由 `render.mjs` 格式化为 Markdown 输出到 Claude Code。

**Q4: 代码位置？**

本地安装路径: `~/.claude/plugins/marketplaces/openai-codex/`
GitHub: `https://github.com/openai/codex-plugin-cc`

关键文件（按调用链）:
1. `plugins/codex/scripts/codex-companion.mjs` — 入口，slash command 分发
2. `plugins/codex/scripts/lib/app-server.mjs` — 连接层（spawn/broker）
3. `plugins/codex/scripts/lib/codex.mjs` — 业务层（turn 执行 + 状态机）
4. `plugins/codex/scripts/app-server-broker.mjs` — Broker 进程
5. `plugins/codex/scripts/lib/broker-lifecycle.mjs` — Broker 生命周期管理

### 2.8 值得借鉴的设计

1. **Broker 模式** — 单后端进程 + 多客户端 Unix socket，避免重复启动
2. **独占访问 + interrupt 例外** — 优雅的并发控制
3. **会话持久化 hook** — `SessionStart`/`SessionEnd` 自动管理 broker 生命周期
4. **后台任务 + detached worker** — 不阻塞 Claude Code 对话
5. **Turn 捕获状态机** — 多 agent 场景的完成推断
6. **Stop review gate** — 用 Codex 审查 Claude 的停止决策

---

## 3. CommHub Channel 当前实现

### 3.1 架构

```
Claude Code
     │  stdio (MCP Channel)
     ▼
commhub-channel.ts (MCP Server + SSE client)
     │  HTTP (MCP Streamable HTTP) + SSE
     ▼
CommHub Server (central hub)
     │  SQLite
     ▼
其他 30 个 Agent Sessions
```

### 3.2 消息获取：SSE 推送 + 拉取

```typescript
// SSE 监听 (push)
async function connectSSE() {
  const res = await fetch(`${COMMHUB_URL}/events/${ALIAS}`);
  // ...读取 SSE 流，收到 new_task 通知后调 get_inbox 拉取
}

// 拉取后注入对话
await mcp.notification({
  method: "notifications/claude/channel",
  params: { content: msg.content, meta },
});
```

**模式**: SSE 通知 → HTTP 拉取 → Channel 注入。不是纯 push（SSE 只是通知，消息体通过 `get_inbox` 拉取）。

### 3.3 去重：显式 ACK

```typescript
await callCommHub("ack_inbox", { alias: ALIAS, message_id: msg.id });
```

每条消息处理后调 `ack_inbox`。未 ACK 的消息在 SQLite inbox 中保留，重连后重新拉取。

### 3.4 状态持久化

Channel 本身无持久化——状态全在 CommHub Server 的 SQLite 中。Channel 进程是无状态的。

---

## 4. 三方对比

### 4.1 核心机制对比

| 维度 | mcp-wechat-server | codex-plugin-cc | CommHub Channel |
|------|-------------------|-----------------|-----------------|
| **消息获取** | LLM 驱动的阻塞 long-poll | JSON-RPC 请求-响应 | SSE 通知 + HTTP 拉取 |
| **推送延迟** | 0-25s (poll 周期) | 即时 (RPC 调用) | < 1s (SSE push) |
| **去重** | 服务端 cursor + 客户端 ID 水位线 | 无需（RPC 是请求-响应） | 显式 ACK |
| **持久化** | JSON 文件 (`~/.mcp-wechat-server/`) | JSON 文件 (workspace state dir) | CommHub SQLite (服务端) |
| **传输** | MCP stdio | JSON-RPC stdio / Unix socket | MCP stdio + SSE |
| **多客户端** | 不支持 | Broker 模式支持 | CommHub 中心化支持 |
| **通信方向** | LLM → WeChat (双向，LLM 驱动) | Claude → Codex (单向委托) | 任意 Agent ↔ Agent (双向) |
| **断线恢复** | cursor + watermark 从 state.json 恢复 | broker.json 恢复 | SQLite inbox 保留未 ACK 消息 |

### 4.2 设计决策对比

| 决策 | mcp-wechat-server | codex-plugin-cc | CommHub Channel |
|------|-------------------|-----------------|-----------------|
| **谁驱动循环** | LLM (tool call 阻塞) | Claude Code (slash command) | CommHub (SSE push) |
| **阻塞 tool call** | 是 (最长 7 天) | 是 (turn 执行期间) | 否 (SSE 异步) |
| **进程模型** | 单进程 | broker + worker 多进程 | 单进程 (channel) + 中心 server |
| **凭证安全** | chmod 600 | OS keychain | .env 文件 |
| **错误处理** | AbortError → 空结果 | Broker busy → 直连 fallback | SSE 断线 → 3s 重连 |

---

## 5. 可借鉴到 CommHub Channel 的设计

### 5.1 从 mcp-wechat-server 借鉴

| # | 设计 | 当前状态 | 建议 |
|---|------|---------|------|
| 1 | **凭证文件 chmod 600** | .env 文件无权限保护 | Channel 启动时对 `~/.claude/channels/commhub/.env` 设置 `0o600` |
| 2 | **双层去重（cursor + watermark）** | 仅用 ACK | 在 Channel 侧也记录 `lastMessageId` 水位线作为二次保障，防止 ACK 失败时重复处理 |
| 3 | **状态文件本地持久化** | Channel 完全无状态 | 考虑在 `~/.claude/channels/commhub/{project}/state.json` 保存 `lastMessageId`，断线重连时跳过已处理消息 |
| 4 | **AbortError 优雅处理** | SSE 断线只 log | 已有重连机制，可以增加 exponential backoff |

### 5.2 从 codex-plugin-cc 借鉴

| # | 设计 | 当前状态 | 建议 |
|---|------|---------|------|
| 5 | **Broker 模式（单后端+多客户端）** | 每个 Channel 独立连 CommHub | 同项目多 session 场景可考虑本地 broker 减少连接数，但目前 30 连接够用，优先级低 |
| 6 | **SessionStart/End hook 管理生命周期** | 手动启动/停止 | 可以在 Claude Code 的 hook 中自动启动/停止 Channel，减少手动操作 |
| 7 | **后台 detached worker** | Channel 内同步处理 | 对长任务场景，考虑 spawn detached worker 执行，避免阻塞 Channel 的 SSE 监听 |
| 8 | **Turn 完成推断（250ms 延迟）** | 无等价机制 | CommHub 的任务完成判定可以借鉴——等待所有子任务完成后再标记整体完成 |
| 9 | **独占访问 + interrupt 例外** | 无并发控制 | 对同一 session 的并发任务可以加队列，interrupt 走快速通道 |

### 5.3 优先级排序

| 优先级 | 改进项 | 工作量 | 收益 |
|--------|-------|--------|------|
| **P0** | #1 凭证文件权限保护 | 3 行代码 | 安全性 |
| **P1** | #3 本地 state.json 防重复 | 半天 | 可靠性 |
| **P2** | #6 SessionStart/End hook | 半天 | 易用性 |
| **P3** | #4 SSE 指数退避重连 | 2 小时 | 稳定性 |
| **P4** | #2 双层去重 | 2 小时 | 可靠性 |
| **低** | #5 Broker 模式 | 2 天 | 目前不需要 |
| **低** | #7 Detached worker | 1 天 | 特定场景 |

---

## 6. 关键结论

### mcp-wechat-server

**优点**: 极简设计，500 行代码搞定 WeChat MCP 集成。双层去重（cursor + watermark）设计巧妙。JSON 文件持久化够用。

**局限**: LLM 驱动的 long-poll 模式有本质缺陷——如果 LLM 不调 `get_messages`，整个系统就停了。25 秒 poll 间隔意味着最差延迟 25 秒。工作流指令全靠 tool description 让 LLM "自觉遵守"。

**对我们的启示**: CommHub Channel 的 SSE push 模式比 long-poll 优越——不依赖 LLM 主动拉取，延迟 < 1 秒，Channel 进程是独立的事件循环而非 LLM 的工具。但它的去重和持久化设计值得借鉴。

### codex-plugin-cc

**优点**: 工程质量极高。Broker 模式、Turn 状态机、后台 worker、Stop review gate 都是精心设计的。Unix socket 通信高效可靠。

**局限**: 单向通信（Claude → Codex），不支持 Codex 回调 Claude。不是通用消息总线。强依赖 Claude Code 插件系统。

**对我们的启示**: CommHub 已经解决了 codex-plugin-cc 没解决的问题（双向通信、跨服务器、多 Agent 编排）。但它的 Broker 模式和生命周期管理是值得学习的工程模式。

### 三者定位

```
mcp-wechat-server:  外部服务适配器（WeChat → LLM）
codex-plugin-cc:    单兵控制器（Claude → Codex 委托）
CommHub Channel:    多兵编排总线（N 个 Agent 跨服务器协调）
```

**三者不是竞品，是不同层次的解决方案。** CommHub Channel 的独特价值在于它是唯一解决跨服务器多 Agent 实时编排的方案。
