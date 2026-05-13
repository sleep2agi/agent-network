# RFC-007：codex-cli-mcp runtime — 通过 `codex mcp-server` stdio 让 anet 用户直接用 Codex CLI 接 commhub mesh

| 字段 | 内容 |
|---|---|
| 状态 | **Proposed** (supersedes RFC-005 + RFC-006) |
| 提出 | 2026-05-13 |
| 作者 | 通信SDK马 |
| 派单 / 决策 | 通信龙（roadmap + 6 轮 architectural pivot + dual deep plan dispatch） |
| Helpers | Vincent（telegram 4136 final pivot 复位 Path C）, 通信工程马（cli.ts implementer eval + Option 2 architecture choice） |
| 关联 issue | [#18](https://github.com/sleep2agi/agent-network/issues/18) SDK research loop |
| 关联 RFC | RFC-002 channel-bind-cli / RFC-003 node telemetry / **RFC-005 superseded** / **RFC-006 superseded (Path B archive)** |
| 关联 doc | [`docs/anet-codex-mcp-server-plan.md`](../anet-codex-mcp-server-plan.md) 通信龙 Path C 深度调研 / [`docs/codex-deep-research.md`](../codex-deep-research.md) 通信SDK马 evidence dive / [`docs/anet-codex-remote-control-plan.md`](../anet-codex-remote-control-plan.md) Path B archive (Phase 2 future work) / [commit 6429bc0](https://github.com/sleep2agi/agent-network/commit/6429bc0) codex CLI 直接通信研究 / [commit 24b744e](https://github.com/sleep2agi/agent-network/commit/24b744e) 通信龙 deep design |
| 目标版本 | agent-network v2.1.8（Phase 1 大 feature）+ agent-node v2.5 |
| 实施人 | 通信工程马（agent-node runtime adapter + cli.ts delegate） |

## 摘要

给 anet 加 1 个 codex CLI runtime — **`codex-cli-mcp`** (daemon mode, push-driven via `codex mcp-server` stdio)，通过 spawn `codex mcp-server` stdio 子进程 + anet 作为 MCP client 调用 `codex` / `codex-reply` 两个 tool 的方式，让用户在 `anet node create --runtime codex-cli-mcp` 后启动节点时**自动接入 commhub mesh** — 跟其他 agent 用 `send_task / get_inbox / get_all_status` 等工具通信。**目的**：让 codex CLI 用户像 claude-code-cli runtime 一样直接接入 anet，**实现成本 ~250-350 行**。

**Vincent telegram 4136 final pivot rationale** (经 6 轮 pivot 收敛):

- ✅ multi-client thread streaming hands-on falsified — 用户 TUI `--remote ws://` attach 仅看 lifecycle, in-progress token streaming 仅 thread owner 收到 (Path B 卖点 broken)
- ✅ OpenAI 标 "Under-development incomplete" Path B 实证 (deep research §1.4 + Vincent 4123 实测)
- ✅ Path C 2x 简单 + 协议 stable + ChatGPT auth value 共享
- ✅ Vincent 4123 "如果不能 TUI 的话" → 4136 "行吧先 mcp 吧" final 决策

## 1. 背景

### 1.1 anet 当前 runtime 矩阵

`agent-network/bin/cli.ts:133`:

```ts
type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk" | "http-api";
```

| Runtime | binary / SDK | claude | codex | push-driven |
|---|---|---|---|---|
| `claude-code-cli` | spawn `claude` 二进制 + channel plugin | ✅ | — | ✅ |
| `claude-agent-sdk` | npm SDK `@anthropic-ai/claude-agent-sdk` | ✅ | — | ✅ |
| `codex-sdk` | npm SDK `@openai/codex-sdk` | — | ✅ | ✅ |
| `http-api` | OpenAI-compatible HTTP fetch | ✅ | ✅ | ✅ |

**Gap**: claude 侧有 CLI 二进制路径 (claude-code-cli), codex 侧仅 SDK, 缺 codex CLI 二进制路径让 codex CLI 用户原地接入 anet mesh。

### 1.2 6 轮 Vincent architectural pivot timeline (本 session 完整收敛史)

| Pivot # | Vincent telegram | Phase 1 scope | Rationale |
|---|---|---|---|
| 1 (initial) | — | Path C 单 runtime (mcp-server stdio) | Vincent 4019 "2.1.8 大 feature = codex-cli 成功支持", `codex mcp-server` real probe 显示 stdio 简单 |
| 2 | 4067+4068 | A TUI + C dual | 增 user attached TUI mode |
| 3 | 4073 | A + C + B triple | 加 Path B ws daemon 作 Phase 2 |
| 4 | 4074+4075 | C only narrow | "A 意义不大", drop TUI |
| 5 | 4108+4110 | B only (ws daemon) | Vincent 4099 实测跑通 ws daemon, "用 remote-control 去做 Runtime" |
| **6 (final)** | **4136** | **C only (mcp-server stdio)** | **multi-client thread streaming hands-on falsified Path B 卖点** + Vincent 4123 "如果不能 TUI 的话" + 4136 "行吧先 mcp 吧" |

**Pivot 6 决策依据 (evidence-driven)**:

- 通信SDK马 deep research [96430e6](https://github.com/sleep2agi/agent-network/commit/96430e6) §3.3: ws daemon broadcast 模型 + per-client opt-out, **用户 TUI attach 仅看 lifecycle, in-progress token streaming 仅 thread owner 收到** (per-thread streaming subscriber model 待 [issue #21551](https://github.com/openai/codex/issues/21551) stable)
- 通信龙 hands-on `thread/resume <A's id>`: `"no rollout found for thread id"` error — thread disk persist 须时间, B 立即 resume race
- 实测 finding 直接 falsify Path B 卖点 "用户 TUI co-presence 看 anet 跑的 turn live token stream"
- 结合 OpenAI 自标 "Under-development incomplete" + 本周协议 stabilize (3 PRs landing 5-13) + 2x 代码量, Path B trade-off 不再值得

### 1.3 codex 0.130 `mcp-server` protocol probe (实测 evidence)

`codex --version` → `codex-cli 0.130.0`。`codex mcp-server` stdio 实测:

```jsonrpc
// initialize ack
{"id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"codex-mcp-server","title":"Codex","version":"0.130.0",...}}}

// tools/list 返回 2 tools
{"id":2,"result":{"tools":[
  {"name":"codex","description":"Run a Codex session...","inputSchema":{"properties":{"prompt":{...required},"cwd":{...},"model":{...},"sandbox":{...},"approval-policy":{...},"profile":{...},"config":{...},"developer-instructions":{...},"base-instructions":{...},"compact-prompt":{...}}}},
  {"name":"codex-reply","description":"Continue a Codex conversation...","inputSchema":{"properties":{"threadId":{...required},"prompt":{...required},"conversationId":{...DEPRECATED}}}}
]}}
```

跑 real prompt `tools/call codex {prompt: "say hello in one word"}` 实测 — **SYNC return + 期间 emit 实时 `codex/event` JSON-RPC notifications 流** (含 token-level `agent_message_content_delta {"delta":"Hello"}`):

```jsonrpc
// 调用中 ~10 events 流:
{"method":"codex/event","params":{"msg":{"type":"session_configured", session_id, thread_id, model, model_context_window, approval_policy, ...}}}
{"method":"codex/event","params":{"msg":{"type":"mcp_startup_update","server":"codex_apps","status":{"state":"starting"}}}}
{"method":"codex/event","params":{"msg":{"type":"task_started", turn_id, started_at, model_context_window, collaboration_mode_kind}}}
{"method":"codex/event","params":{"msg":{"type":"item_started","item":{"type":"AgentMessage",id,...}}}}
{"method":"codex/event","params":{"msg":{"type":"agent_message_content_delta","delta":"Hello"}}}
{"method":"codex/event","params":{"msg":{"type":"item_completed","item":{"type":"AgentMessage",...,"content":[{"type":"Text","text":"Hello"}]}}}}
{"method":"codex/event","params":{"msg":{"type":"task_complete","turn_id":"2","duration_ms":3088,"time_to_first_token_ms":2944,"last_agent_message":"Hello"}}}

// 末尾 SYNC return:
{"id":2,"result":{"content":[{"type":"text","text":"Hello"}],"structuredContent":{"threadId":"019e1fb1-8c39-...","content":"Hello"}}}
```

**关键发现**: `codex/event` 是 codex-mcp-server 的**非标 MCP notification** (method 字段是 `codex/event` 不是标准 MCP `notifications/progress`)。anet MCP client 须在 @modelcontextprotocol/sdk 上 register catch-all notification handler 才能捕获 (详见 §5)。

## 2. 设计目标

| 目标 | 描述 |
|---|---|
| **G1 — 对称 anet runtime** | codex CLI 用户跟 claude-code-cli 用户体验对称 (functional parity, push-driven daemon path) |
| **G2 — Push-driven daemon** | commhub `send_task` 到达 → codex 自动响应 (不依赖用户 attached TUI), anet 作 MCP client `tools/call codex` 直接 push prompt |
| **G3 — Live agent UX** | Dashboard / SaaS client 看到 codex agent live token stream (`agent_message_content_delta`) 不是派单后静默 N 分钟 |
| **G4 — 最小实现成本** | 复用 anet 现有 `@modelcontextprotocol/sdk` dep + agent-node 现有 codex-sdk runtime supervision 框架, 目标 ~250-350 行 |
| **G5 — 协议稳定** | 走 stable mcp-server protocol, 不依赖正在 stabilize 的 ws transport 系列 PRs (#22404 #22414 #22386) |
| **G6 — 安全默认 align anet philosophy** | approval-policy 默认 `never` + sandbox 默认 `danger-full-access` (per Vincent §6.5 4144 Option A 跟 anet autonomous teammate-mode 一致). Conservative 路径仍 surface via wizard + profile.flags 让 dev-conscious 用户 opt-in. |
| **G7 — 升级路径明确** | Phase 2 升级 ws daemon path (when [issue #21551](https://github.com/openai/codex/issues/21551) multi-client subscriber stable + 用户真 ask mid-turn steer 时启动 RFC-008-like new RFC) |

## 3. 设计

### 3.0 Phase 0 spike gate — MCP `setNotificationHandler` 实测 (blocking implement)

**Per 通信牛 review P1 #2** (was §11 Q10, promoted to blocking gate):

`@modelcontextprotocol/sdk` Client 的 `setNotificationHandler(schema, handler)` 通常按 schema/method 注册 typed handler, 非标准 `codex/event` method 可能不被 SDK typed dispatcher 捕获。**implement 前 30min spike 实测**, 3 个 fallback path 确认其一可用后方可启动 Phase 1:

| Spike result | Fallback path | 实施 complexity |
|---|---|---|
| **A**: SDK Client 暴露 `fallbackNotificationHandler` 字段 (per 通信龙 plan 98b6728 §3.2 引用) | 直接用 SDK native API | ~5 行 (cli.ts L437-style) |
| **B**: SDK 不 expose catch-all, 但 transport (`StdioClientTransport`) 暴露 `onmessage` raw event | client transport-level intercept + manual JSON-RPC dispatch | ~30 行 (复用 `/tmp/codex-schema/JSONRPCMessage.json` schema framing) |
| **C**: 都不 work | 不用 @modelcontextprotocol/sdk Client, 自己写 raw stdio JSON-RPC parser (借鉴 codex 0.130 protocol envelope `{jsonrpc, id?, method, params?}`) | ~100 行 (full bring-your-own MCP client) + 失 SDK tools/list typed types |

**Spike degradation policy** (per 通信牛 P1 #2 末段):
- Spike A/B/C 任一 work → Phase 1 ship full feature (含 live progress forwarding)
- Spike 全 fail → Phase 1 ship **degraded**: only `tools/call codex` SYNC return → commhub_send_task reply, 不承诺 live progress (`item/agentMessage/delta` 等). Setup wizard 显式 warn "live progress unavailable, codex 输出仅最终结果"
- doc 显式标 spike outcome + 选用 fallback path 在 implementation PR description

**Spike 谁做**: 通信工程马 implement 第一步 (在 unstash worktree 后, 改 cli.ts 之前)。

### 3.1 Architecture (Option 2: agent-node 内 runtime bridge)

```
[commhub-server]
       |
       | SSE (new_task event for codex-bot)
       v
[agent-node (codex-cli-mcp runtime adapter)]
       |
       | MCP stdio (via @modelcontextprotocol/sdk StdioClientTransport)
       v
[codex mcp-server child process]
       |
   1. Init: initialize / notifications/initialized handshake
   2. tools/call codex {prompt, cwd, model, sandbox, approval-policy}
        ↳ 期间 emit `codex/event` notifications stream (token deltas + lifecycle)
        ↳ end: SYNC return {content, structuredContent: {threadId, content}}
   3. 续单: tools/call codex-reply {threadId, prompt}
       |
       v
[agent-node bridge]
   - Forward live codex/event → commhub `report_progress` (RFC-003 telemetry)
   - Aggregate final output → commhub_send_task reply
       |
       v
[commhub]
```

**关键架构选择 — Option 2** (per 通信工程马 e50eda1a + 9c43ba4e 共识):

- cli.ts: thin launcher (~30-50 行 dispatch + setup wizard 增 entry)
- agent-node: 重活 (MCP client + codex/event handler + commhub bridge + supervision)

### 3.2 cli.ts 改动 (~30-50 行)

```ts
// L133 RuntimeName enum
type RuntimeName =
  | "claude-code-cli"
  | "codex-sdk"
  | "codex-cli-mcp"        // ← NEW (Path C, mcp-server stdio)
  | "claude-agent-sdk"
  | "http-api";

// normalizeRuntime
function normalizeRuntime(r: string): RuntimeName {
  switch (r) {
    case "codex-cli-mcp":
    case "codex-mcp":
      return "codex-cli-mcp";
    // ... existing branches
  }
}

// checkRuntimeDependency
if (profile.runtime === "codex-cli-mcp") {
  if (!commandExists("codex")) {
    warn("Install codex CLI: npm i -g @openai/codex@latest");
    return false;
  }
  // verify codex --version >= 0.130.0
  const v = execFileSync("codex", ["--version"], {encoding: "utf-8"}).trim();
  // semver check
}

// launchAgent dispatch — delegate to agent-node
case "codex-cli-mcp":
  return spawnAgentNode(profile, { runtime: "codex-cli-mcp" });
```

### 3.3 agent-node 改动 (~250-350 行)

新增 `agent-node/src/runtime/codex-cli-mcp.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class CodexCliMcpRuntime {
  private mcpClient: Client;
  private transport: StdioClientTransport;
  private threadId?: string;

  async start(profile: Profile) {
    this.transport = new StdioClientTransport({
      command: "codex",
      args: ["mcp-server"],
      env: { ...process.env /* codex 不需要额外 token, stdio inherit */ },
    });

    this.mcpClient = new Client(
      { name: "anet-codex-cli-mcp", version: AGENT_NODE_VERSION },
      { capabilities: {} }
    );

    // Register catch-all notification handler 捕 `codex/event` (非标 MCP method)
    this.mcpClient.setNotificationHandler(/* catch-all */ async (notification) => {
      if (notification.method === "codex/event") {
        await this.forwardProgressEvent(notification.params);  // → commhub report_progress (§5)
      }
    });

    await this.mcpClient.connect(this.transport);
    // tools/list verify codex + codex-reply available (defensive)
  }

  // commhub SSE handler — 新 task 到达
  async onNewTask(task: TaskEvent) {
    const isFirstTask = !this.threadId;
    const r = isFirstTask
      ? await this.mcpClient.callTool({
          name: "codex",
          arguments: {
            prompt: task.task,
            cwd: profile.cwd,
            model: profile.model,
            sandbox: profile.flags?.codex?.sandbox ?? "danger-full-access",  // per Vincent §6.5 4144 Option A: anet autonomous teammate-mode default
            "approval-policy": profile.flags?.codex?.approvalPolicy ?? "never",  // per Vincent §6.5 4144 Option A
          },
        })
      : await this.mcpClient.callTool({
          name: "codex-reply",
          arguments: { threadId: this.threadId, prompt: task.task },
        });

    if (isFirstTask) this.threadId = (r.structuredContent as any)?.threadId;

    // Handle isError (per 通信龙 §0.3 实测)
    if (r.isError) {
      await commhubSendReply({
        task_id: task.task_id,
        content: `Codex error: ${r.content?.[0]?.text || "unknown"}`,
        isError: true,
      });
      return;
    }

    await commhubSendReply({
      task_id: task.task_id,
      content: r.structuredContent?.content || r.content?.[0]?.text,
    });
  }

  async shutdown() {
    await this.mcpClient.close();
    await this.transport.close();
  }

  // Forward codex/event to commhub progress (RFC-003 telemetry compatible)
  private async forwardProgressEvent(event: any) {
    const mapped = codexEventToNodeEvent(event);
    if (mapped) await commhubReportProgress(mapped);
  }
}
```

复用 `codex-sdk` runtime 现有 supervision 框架 (spawn / supervise / respawn / shutdown), 替换 transport (npm SDK → MCP stdio)。

### 3.4 完整 sequence diagram

```
[commhub-server] -- SSE new_task --> [agent-node codex-cli-mcp runtime]
                                              |
                                              | tools/call codex { prompt, cwd, model, sandbox, approval-policy }
                                              v
                                  [codex mcp-server child]
                                              |
                                              |- codex/event { type: session_configured, model_context_window: 258400 }
                                              |- codex/event { type: mcp_startup_update, server: "codex_apps" / "commhub-proxy" }
                                              |- codex/event { type: task_started, turn_id, started_at }
                                              |- codex/event { type: item_started, item: AgentMessage }
                                              |- codex/event { type: agent_message_content_delta, delta: "Hello" }
                                              |- codex/event { type: item_completed }
                                              |- codex/event { type: task_complete, duration_ms, time_to_first_token_ms }
                                              v
                                  SYNC return { content, structuredContent: { threadId, content } }
                                              |
                                              v
                              [agent-node bridge]
                              - codex/event 流式 → commhub `report_progress` MCP (RFC-003 telemetry layer)
                              - Final content 聚合 → commhub_send_task reply
                                              |
                                              v
                                        [commhub]
```

## 4. Tool Call Flow

### 4.1 首单 — `codex` tool

| 字段 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | 用户 / 派单消息原文 |
| `cwd` | optional | 工作目录 (默认 agent-node 自身 cwd) |
| `model` | optional | `gpt-5-codex` / `gpt-5.2` / `o3` / `o4-mini` 等 (profile 配置, ChatGPT auth 限制部分 model) |
| `sandbox` | optional | `read-only` / `workspace-write` / `danger-full-access` (默认 `danger-full-access` per Vincent §6.5 4144 Option A) |
| `approval-policy` | optional | `untrusted` / `on-failure` / `on-request` / `never` (默认 `never` per Vincent §6.5 4144 Option A) |
| `profile` | optional | codex 自身 profile (`~/.codex/config.toml` 的 `[profiles.X]` 节) |
| `config` | optional | inline 配置覆盖 (dotted-key TOML override, 兼容 codex `-c key=val` 语义) |
| `developer-instructions` | optional | 注入 developer-role system prompt (anet 可注入 "你已接入 anet network..." 提示) |
| `base-instructions` | optional | 完全替换 codex 默认 base instructions (advanced, profile 配置) |
| `compact-prompt` | optional | 自定 compaction prompt |

返回 outputSchema:
```ts
{
  content: [{ type: "text", text: <final output> }],
  structuredContent: { threadId: string, content: string },
  isError?: boolean  // ← per 通信龙 §0.3 实测, 错误路径 (auth/model 等)
}
```

### 4.2 续单 — `codex-reply` tool

```ts
{
  threadId: <从首单 structuredContent 拿到>,
  prompt: <续单消息>
}
```

返回同 §4.1 outputSchema。

### 4.3 Error handling — `isError: true` (per 通信龙 §0.3 实测)

ChatGPT account auth model 不支持时 (实测 `gpt-4.1-mini` fail):
```json
{
  "content": [{"type": "text", "text": "{...error 400 invalid_request_error...}"}],
  "structuredContent": {"threadId": "...", "content": "{...error JSON...}"},
  "isError": true
}
```

**关键: threadId save 顺序 (per 通信牛 review P1 #3)** — 实测 model/auth error 路径 `structuredContent.threadId` 仍有值, 若 anet 盲存会让后续任务 `codex-reply` 到坏上下文。**正确顺序**:

```ts
const r = await this.mcpClient.callTool({...});

// Step 1: 检查 isError 先决定是否进 session state
if (r.isError) {
  // Error path: 不 update threadId, forward as task error
  await commhubSendReply({
    task_id: task.task_id,
    content: `Codex error: ${r.content?.[0]?.text || "unknown"}`,
    isError: true,
  });
  return;
}

// Step 2: 验 content valid (避免 structuredContent.content 空字符串等边界)
const finalContent = r.structuredContent?.content || r.content?.[0]?.text;
if (!finalContent || finalContent.trim() === "") {
  await commhubSendReply({
    task_id: task.task_id,
    content: "Codex returned empty content",
    isError: true,
  });
  return;
}

// Step 3: 仅 success + content valid 才 save threadId
if (isFirstTask) {
  this.threadId = (r.structuredContent as any)?.threadId;
  await writebackSessionId(this.threadId);  // per §4.4 align agent-node session lifecycle
}

await commhubSendReply({ task_id: task.task_id, content: finalContent });
```

### 4.4 Thread lifecycle align agent-node session 写回机制 (per 通信牛 review P1 #4)

**默认 per agent-node process lifetime 一个 thread** — 跟现有 `agent-node/src/cli.ts` 的 `SESSION_ID` + `writebackSession()` 机制对称:

| 时机 | 行为 |
|---|---|
| Agent-node 启动 | Read `.anet/nodes/<alias>/config.json` 的 `session` field (per memory `feedback_anet_session_field.md`, claude code session UUID 兼容) — 若有值, 视为 `SESSION_ID` 已存 → 首单 dispatch via `codex-reply { threadId: SESSION_ID, prompt }` (resume 路径) |
| Agent-node 首单 (无 SESSION_ID) | `tools/call codex {prompt, ...}` → 成功返 → `writebackSession(r.structuredContent.threadId)` 写回 node config |
| Agent-node 首单 (有 SESSION_ID) | `tools/call codex-reply {threadId: SESSION_ID, prompt}` → resume |
| Agent-node 续单 | `tools/call codex-reply {threadId: this.threadId, prompt}` |
| Agent-node 重启后 | Read config, 走 resume 路径 (跟 claude-code-cli / codex-sdk runtime 行为一致) |

→ 用户 `anet node restart <alias>` 后 codex 会 resume 之前的 thread (rollout 文件已 disk persist), context 不丢。

**Phase 2 可选 alternative**: `profile.flags.codex.threadStrategy: "session" | "task"` 选项, task 模式每个 commhub task 起新 thread (clean isolation, debug 用)。Phase 1 hardcode `session` 简化。

## 5. Live Progress Forwarding — `codex/event` → commhub `report_progress`（RFC-003 复用，无 schema 改动）

### 5.1 codex/event → RFC-003 NodeEvent.kind mapping (实测 + 通信牛 review P1 #1 rewrite)

**关键修正 (per 通信牛 P1 #1)**: 用 RFC-003 现有 `ProgressKind` union (`turn_start` / `thinking` / `tool_start` / `tool_end` / `todo_update` / `subagent_start` / `subagent_end` / `rate_limit` / `compact` / `error` / `turn_end`) **完全 cover** codex/event types, **无 commhub schema 改动 + 无 dashboard 改动**:

#### Phase 1 forward (core high-value + critical kinds) — per §11 Q6 narrow

Phase 1 forward 包含 RFC-003 `ProgressKind` 的 8 个 kind 实例 (turn_start / thinking / tool_start / tool_end / todo_update / turn_end / rate_limit / error), 跟 codex/event types 映射如下。**别硬记数字** (per 通信牛 review P2 #5 nit), 实施时按 mapper code (§5.2) 即可:

| codex/event type | RFC-003 kind | RFC-003 substate | payload | forward? |
|---|---|---|---|---|
| `task_started` | `turn_start` | — | `{tokens_in: 0}` (initial) | ✅ Phase 1 |
| `agent_message_content_delta` | `thinking` | — | `{preview: <batched delta text>}` (200ms / 1KB flush) | ✅ Phase 1 |
| `item_started` (AgentMessage) | `thinking` | `planning` | `{preview: ""}` (item started signal) | ✅ Phase 1 |
| `item_started` (CommandExecution) | `tool_start` | `tool_running` | `{tool_name: "shell", tool_use_id: item.id, args_preview: command.slice(0, 200)}` | ✅ Phase 1 |
| `item_completed` (CommandExecution) | `tool_end` | — | `{tool_use_id, ok: exit_code==0, duration_ms, output_preview: aggregated_output.slice(0, 500), exit_code}` | ✅ Phase 1 |
| `item_started` (FileChange) | `tool_start` | `tool_running` | `{tool_name: "apply_patch", tool_use_id: item.id, args_preview: file_paths.join(",")}` | ✅ Phase 1 |
| `item_completed` (FileChange) | `tool_end` | — | `{tool_use_id, ok, duration_ms, output_preview: diff_summary}` | ✅ Phase 1 |
| `item_started` / `item_completed` (TodoList) | `todo_update` | `planning` (started) / — (completed) | `{items: todo_items, from: 'codex_native'}` | ✅ Phase 1 |
| `task_complete` | `turn_end` | `idle` | `{tokens_in, tokens_out, cost_usd?}` (from task_complete + token_count fold) | ✅ Phase 1 |
| `account/rateLimits/updated` (if emit) | `rate_limit` | `rate_limited` | `{resets_at_ms, limit_type, utilization}` | ✅ Phase 1 (critical) |
| **`error`** (mcp-server primary, codex/event with type=error per 通信龙 plan 98b6728 §0.2 实测) | `error` | — | error.field: `{code: 'tool_error' \| 'auth_failed' \| ..., message, retryable}` | ✅ Phase 1 (critical) |
| `task_failed` / `thread.error` (ws-schema variants, defensive future-compat) | `error` | — | (same shape, future codex versions if emit) | 🟡 defensive (Phase 1 不强测) |

#### Phase 1 log-only (~6 types) — Open Q6 narrow rationale

| codex/event type | reason |
|---|---|
| `session_configured` | session metadata (model, sandbox), not progress signal — log only |
| `mcp_startup_update` | codex 子 MCP server startup (codex_apps / 用户 commhub-proxy 等), debug 用 — log only |
| `item_completed` (AgentMessage) | turn_end 已 carry final content, 重复 forward — log only |
| `agent_message` | 同 item_completed AgentMessage — log only |
| `token_count` | fold into `turn_end` payload, 不单独 forward — log only |
| `raw_response_item` | 原始 model item, 噪声太大 (实测 12-line rollout 大部分是这个) — log only |
| `warning` (under-development) | filter "Under-development incomplete" message — log only |

#### Phase 2 forward 候选 (Open Q6 deferred)

剩余 ServerNotification types (per `/tmp/codex-schema/ServerNotification.json` 63 events) 大多 codex 内部 lifecycle 或 Windows specific, Phase 2 视 dashboard UX 需求 + 用户 feedback 决定是否加 forward。**核心 5 kinds + 2 critical 已 cover anet "派单后静默" 解决主体**。

### 5.2 Schema mapping code (Phase 1)

agent-node bridge 内置 mapper (用 RFC-003 actual ProgressKind union, **无新 kind 引入**):

```ts
import { ProgressKind, SubState, NodeEvent } from "./events";

interface DeltaBuffer { text: string; firstTs: number; }
const deltaBuf: Record<string /* thread_id */, DeltaBuffer> = {};

function codexEventToNodeEvent(ev: any): NodeEvent | null {
  const msg = ev.params?.msg;
  if (!msg) return null;
  const { type } = msg;
  const ts_ms = Date.now();
  const baseFields = { alias: ALIAS, task_id: CURRENT_TASK_ID, origin: "codex_sdk", ts_ms };
  // ↑ Phase 1 reuse `codex_sdk` origin (mcp-server 本质同 codex backend; per RFC-003 origin enum)
  // Phase 2 可加 `codex_cli` origin if dashboard 须区分 codex-sdk vs codex-cli-mcp runtime (minor schema bump)

  switch (type) {
    case "task_started":
      return { ...baseFields, kind: "turn_start", payload: { kind: "turn_start", tokens_in: 0 } };

    case "agent_message_content_delta": {
      // Batch buffer: 200ms 或 1KB flush, Phase 1 batch logic
      const tid = msg.thread_id;
      if (!deltaBuf[tid]) deltaBuf[tid] = { text: "", firstTs: ts_ms };
      deltaBuf[tid].text += msg.delta;
      const since = ts_ms - deltaBuf[tid].firstTs;
      if (deltaBuf[tid].text.length < 1024 && since < 200) return null;  // wait for batch
      const preview = deltaBuf[tid].text;
      delete deltaBuf[tid];
      return { ...baseFields, kind: "thinking", payload: { kind: "thinking", preview } };
    }

    case "item_started":
      if (msg.item?.type === "AgentMessage")
        return { ...baseFields, kind: "thinking", substate: "planning", payload: { kind: "thinking", preview: "" } };
      if (msg.item?.type === "CommandExecution")
        return { ...baseFields, kind: "tool_start", substate: "tool_running",
                 payload: { kind: "tool_start", tool_name: "shell", tool_use_id: msg.item.id,
                            args_preview: (msg.item.command || "").slice(0, 200) } };
      if (msg.item?.type === "FileChange")
        return { ...baseFields, kind: "tool_start", substate: "tool_running",
                 payload: { kind: "tool_start", tool_name: "apply_patch", tool_use_id: msg.item.id,
                            args_preview: (msg.item.file_paths || []).join(",") } };
      if (msg.item?.type === "TodoList")
        return { ...baseFields, kind: "todo_update", substate: "planning",
                 payload: { kind: "todo_update", items: msg.item.items || [], from: "codex_native" } };
      return null; // other item types: log only

    case "item_completed":
      if (msg.item?.type === "CommandExecution")
        return { ...baseFields, kind: "tool_end",
                 payload: { kind: "tool_end", tool_use_id: msg.item.id, ok: msg.item.exit_code === 0,
                            duration_ms: msg.item.duration_ms || 0,
                            output_preview: (msg.item.aggregated_output || "").slice(0, 500),
                            exit_code: msg.item.exit_code } };
      if (msg.item?.type === "FileChange")
        return { ...baseFields, kind: "tool_end",
                 payload: { kind: "tool_end", tool_use_id: msg.item.id, ok: msg.item.success !== false,
                            duration_ms: msg.item.duration_ms || 0, output_preview: msg.item.diff_summary || "" } };
      if (msg.item?.type === "TodoList")
        return { ...baseFields, kind: "todo_update",
                 payload: { kind: "todo_update", items: msg.item.items || [], from: "codex_native" } };
      return null;

    case "task_complete":
      return { ...baseFields, kind: "turn_end", substate: "idle",
               payload: { kind: "turn_end", tokens_in: msg.tokens_in, tokens_out: msg.tokens_out, cost_usd: msg.cost_usd } };

    case "error":          // ← Primary (per 通信龙 plan 98b6728 §0.2 实测: codex mcp-server 的 codex/event 含 type="error" event)
    case "task_failed":    // ← Defensive future-compat (若 mcp-server 后续加 ws-schema 命名)
    case "thread.error":   // ← Defensive future-compat (同上)
      return { ...baseFields, kind: "error",
               error: { code: msg.error_code || "tool_error", message: msg.message || "Codex error", retryable: msg.retryable ?? true } };

    case "account/rateLimits/updated":
      return { ...baseFields, kind: "rate_limit", substate: "rate_limited",
               payload: { kind: "rate_limit", resets_at_ms: msg.resets_at_ms, limit_type: msg.limit_type, utilization: msg.utilization } };

    // log-only (Phase 1 不 forward):
    case "session_configured":
    case "mcp_startup_update":
    case "raw_response_item":
    case "warning":
    case "token_count":
    case "agent_message":
      return null;

    default:
      return null;  // unknown types log-only
  }
}
```

→ **0 commhub schema 改动 + 0 dashboard 改动** — 复用 RFC-003 已 ship `commhub_report_progress` MCP method + `progress_events` 表 + SSE + `<ProgressTimeline>`。codex agent 跟 claude agent 用同 NodeEvent schema 渲染。

### 5.3 Batch / Backpressure 策略 (per 通信工程马 review focus)

`agent_message_content_delta` 在快速生成时可能 token-per-event (实测 ~100ms 间隔), single token sends 会 flood commhub `report_progress`。Phase 1 采用 **简单 batch 策略**:

- delta events buffer 200ms 或满 1KB 即 flush
- 其他 lifecycle events 立即 forward (low-frequency)
- commhub `report_progress` payload size cap 4KB (commhub-server enforce)

Phase 2 可加 backpressure: commhub 端返 429 时 agent-node 降频 + drop oldest delta (保 lifecycle)。Phase 1 不实现。

### 5.4 跟 RFC-003 telemetry layer 复用

RFC-003 已 ship `commhub_report_progress` MCP method + `progress_events` SQLite 表 + SSE `progress` 事件 + dashboard `<ProgressTimeline>`。**RFC-007 直接复用, 无 commhub schema 改动**。Dashboard 因为 NodeEvent schema 统一, codex agent 跟 claude agent 同款渲染。

## 6. Configuration — Approval Policy & Sandbox

### 6.1 静态 approval-policy 参数 (vs ws daemon reverse ServerRequest 复杂决策)

`codex mcp-server` `tools/call codex` 接受 `approval-policy` 参数:

| 值 | codex 行为 | anet 适用场景 |
|---|---|---|
| `untrusted` | 所有 shell 命令需 approval | 高安全场景 (公开 demo / Vincent 试新 agent) — wizard surface 但 default 不选 |
| `on-failure` | 仅命令失败后才 ask | 中等保守, balance 自动化 + 安全 — wizard surface 但 default 不选 |
| `on-request` | model 自己判断要 ask 才 ask | 中等信任 (用户已熟悉 codex 行为) |
| `never` | 全自动批准, 无 approval prompt | **RFC-007 默认值** (跟 anet autonomous teammate-mode philosophy 一致, per Vincent §6.5 4144 Option A + memory `feedback_default_flags.md`) |

**RFC-007 默认值 `never`** (per Vincent 4144 final Option A) — 跟 anet 5-runtime autonomous teammate philosophy 一致, 用户期望 anet agents 自动跑不卡 approval prompt。conservative 路径仍 surface via wizard 让 dev-conscious 用户 opt-in (`profile.flags.codex.approvalPolicy: "on-failure"` etc)。

### 6.2 默认 sandbox=`danger-full-access`

| 值 | 权限 | 场景 |
|---|---|---|
| `read-only` | 仅读 + 禁网 | 极保守 (仅 query / review 类 task) — wizard surface 但 default 不选 |
| `workspace-write` | 读 + 写 cwd + 禁网 | 保守 — agent 改 cwd 文件 OK, 不能伤害 cwd 外 + 不能联网。wizard surface 让 dev-conscious 用户 opt-in (`profile.flags.codex.sandbox: "workspace-write"`) |
| `danger-full-access` | 全访问 (网络 + 全文件系统) | **RFC-007 默认值** (per Vincent §6.5 4144 Option A + anet autonomous teammate philosophy) |

**RFC-007 默认值 `danger-full-access`** (per Vincent 4144 final Option A) — 跟 anet 5-runtime autonomous teammate philosophy 一致, codex-sdk runtime 也是同款 default (intentional, 非 inconsistency)。conservative 路径 wizard surface 给 dev-conscious 用户 opt-in。

### 6.3 profile.flags.codex 配置 schema

`anet node create` 写入 `.anet/nodes/<alias>/config.json` 时支持:

```json
{
  "runtime": "codex-cli-mcp",
  "model": "gpt-5-codex",
  "flags": {
    "codex": {
      "approvalPolicy": "never",            // ← default (跟 anet autonomous teammate-mode 一致)
      "sandbox": "danger-full-access",      // ← default (跟 anet autonomous teammate-mode 一致)
      "profile": "<可选 codex profile 名 from ~/.codex/config.toml>",
      "config": { /* inline TOML overrides */ },
      "useUserConfig": true,
      "developerInstructions": "你已接入 anet network..."
    }
  }
}
```

agent-node runtime adapter 启动 tools/call 时透传这些字段。Dev-conscious 用户可显式 set conservative (`approvalPolicy: "on-failure"` + `sandbox: "workspace-write"`) 跟 anet ecosystem default 不一致 — wizard surface 这些选项。

### 6.4 Codex MCP servers 嵌套 (用户已有 ~/.codex/config.toml mcp_servers)

实测 probe 时 `codex mcp-server` 自动加载 `~/.codex/config.toml` 里的 `[mcp_servers.*]` (per 通信龙 §1.2 实测 — Vincent commhub-proxy 半成品被 connect 失败) — 用户已有自定义 MCP 配置会自动 inherit。

**两种选项 (Open Q2)**:
- `useUserConfig: true` (默认): 尊重用户 ~/.codex/config.toml, 但用户 stale config 可能 fail 子 MCP startup (cosmetic, codex 主体仍 work)
- `useUserConfig: false`: profile.flags 触发 anet 透传 `--ignore-user-config` 给 codex spawn, 完全隔离用户 toml

### 6.5 安全 cross-runtime consistency matrix (per Vincent §6.5 4144 Option A final)

anet 5 runtime 默认安全策略矩阵 — **全 autonomous teammate-mode consistent** (per Vincent telegram 4144 final Option A decision + memory `feedback_default_flags.md` philosophy):

| Runtime | 默认 approval | 默认 sandbox | 状态 |
|---|---|---|---|
| `claude-code-cli` | `--dangerously-skip-permissions` (per profile.flags.dangerouslySkipPermissions default true) | n/a (claude CLI 无 sandbox 概念) | ✅ anet autonomous teammate-mode |
| `claude-agent-sdk` | `permissionMode: "bypassPermissions" + allowDangerouslySkipPermissions: true` (cli.ts L520-524) | n/a | ✅ anet autonomous teammate-mode |
| `codex-sdk` (existing, cli.ts L617-622) | `approvalPolicy: "never"` | `sandboxMode: "danger-full-access"` | ✅ anet autonomous teammate-mode (intentional, NOT inconsistency — Round 147 misread 修正) |
| **`codex-cli-mcp` (RFC-007 v3 NEW)** | `approval-policy: "never"` | `sandbox: "danger-full-access"` | ✅ anet autonomous teammate-mode (per Vincent §6.5 4144 Option A) |
| `http-api` | n/a (single-shot HTTP fetch 无 agent loop / 无 tools / 无 sandbox 概念) | n/a | n/a (per Round 152 4-runtime symmetry analysis) |

**Vincent 决策史 (§6.5 audit trail)**:
- Round 147 我 mark codex-sdk "🚨 inconsistency 待 fix" — **MISREAD** (实际 anet pattern intentional)
- Round 149 raise A/B/C options to Vincent
- 通信龙 propose Option D (hybrid bounded autonomous: never + workspace-write)
- **Vincent telegram 4144 final: Option A** — codex-cli-mcp 跟 anet autonomous teammate-mode full consistency (`never` + `danger-full-access`)

**Rationale (per Vincent memory `feedback_default_flags.md` + 4144 decision)**:
> "anet 自动生成的 config.json 必须默认带 `dangerouslySkipPermissions: true` 和 `teammateMode: "in-process"`。
> **Why:** 用户的所有 agent 都需要这两个 flag，不开的话 Claude Code 会卡在权限确认上，无法自动化工作。"

anet 设计哲学 = **autonomous teammate-mode**, 用户期望 anet agents 自动跑不卡 approval prompt。codex-cli-mcp follow 这个 pattern 跟 ecosystem 一致。

**Conservative 路径 (dev-conscious 用户 opt-in)**:

profile.flags.codex.approvalPolicy + sandbox 仍 override default:

```json
{
  "runtime": "codex-cli-mcp",
  "flags": {
    "codex": {
      "approvalPolicy": "on-failure",     // ← explicit conservative opt-in
      "sandbox": "workspace-write"        // ← explicit sandbox opt-in
    }
  }
}
```

**Wizard surfaces conservative 选项** (cli.ts setupCommand, 让 dev-conscious 用户选):

```
? Codex approval policy:
  ❯ never (default, autonomous teammate-mode — 全自动批准)
    on-failure (失败后 ask)
    on-request (model 判断 ask)
    untrusted (全 ask, 最保守)

? Codex sandbox mode:
  ❯ danger-full-access (default, autonomous teammate-mode — 全访问)
    workspace-write (限 cwd 写 + 禁网)
    read-only (仅读)
```

**~~Phase 1 fix codex-sdk default~~ 撤销** (per Vincent §6.5 4144 Option A):
- codex-sdk runtime (cli.ts L617-622) **维持现状** (`never` + `danger-full-access`)
- 不是 inconsistency, 是 intentional anet pattern
- RFC-007 implement PR **不动** L617-622
- 撤销 changelog / migration note (无 breaking change)

**Phase 2 considerations** (deferred):
- 若用户/产品后续 ask "我想 anet 全 conservative default" (Vincent 改主意) → Phase 2 RFC-009-like new RFC 全 runtime defaults 翻转
- 若 daemon mode (unmanned) 跟 manned 行为差异化 → profile.flags.codex.daemonMode flag 区分

## 7. Setup / cli.ts integration

### 7.1 Setup wizard 添加 runtime 选项

`anet node create` 交互流程当前 4 runtime 选项, 加 5th:

```
? Select runtime:
  ❯ claude-code-cli (Claude CLI binary)
    claude-agent-sdk (Anthropic SDK)
    codex-sdk (OpenAI Codex SDK)
    codex-cli-mcp (Codex CLI via mcp-server stdio, daemon mode) ← NEW
    http-api (OpenAI-compatible HTTP)
```

后续 prompt 加 codex-cli-mcp 特有问题 (default 标在 anet ecosystem autonomous 一致的值, conservative 选项仍 surface 给 dev-conscious 用户 opt-in):
- approval-policy: `untrusted` / `on-failure` / `on-request` / `never` **(default)** — per Vincent §6.5 4144 Option A
- sandbox: `read-only` / `workspace-write` / `danger-full-access` **(default)** — per Vincent §6.5 4144 Option A
- model: gpt-5-codex (default for ChatGPT account) / gpt-5.2 / o3 / o4-mini / other (用户输入, ChatGPT auth 限部分 model)

### 7.2 cli.ts → agent-node delegate

```ts
case "codex-cli-mcp":
  return spawnAgentNode(profile, { runtime: "codex-cli-mcp" });
```

## 8. 限制 (per 通信龙 plan doc §4 honest 列出)

### 8.1 stdio 1:1 — 不能 multi-anet-client 共 daemon

agent-node 占了 codex mcp-server child 的 stdio — **用户不能 attach** TUI 跟 codex 对话同 daemon。
但用户能:
- 通过 `commhub_send_task` 派任务给 codex 节点 (从 dashboard / 别 agent)
- Dashboard 看 `live token stream` (codex/event → commhub progress → SSE → frontend)
- 用户想自己跟 codex TUI 互动: 直接在用户终端跑 `codex` (无 anet, 走 user-mode), 或用 §10.3 Optional anet codex-setup 命令帮配 ~/.codex/config.toml

### 8.2 SYNC return — 不能 mid-turn steer / interrupt

`tools/call codex` 一次性返回最终 content。中途用户不能 *中断 turn* 或 *steer to different direction*。

若需要 mid-turn steer → §10 Phase 2 ws daemon path (RFC-008-like future RFC, 触发条件: TR1-TR3 满足)。

### 8.3 不暴露 codex slash commands (/goal /clean /stop 等 60+)

`codex mcp-server` 仅暴露 2 个 tools (`codex` + `codex-reply`), **不**暴露 TUI 内 60+ slash commands。`/goal` `/clean` 等是 codex TUI 客户端 sugar, map 到 app-server `thread/goal/updated` 等 notification — mcp-server 不 expose。

若用户想用 `/goal` 设 agent goal, 须 TUI mode (用户自己跑) 或 Phase 2 ws daemon path。

### 8.4 ChatGPT account auth 限 model

实测 (per 通信龙 §0.3) `gpt-4.1-mini` 不支持 ChatGPT account auth。anet wizard 须 verify *codex CLI auth mode* + supported model 矩阵。

实际 ChatGPT 订阅可能支持: `gpt-5` / `gpt-5-codex` / `o3` / `o4-mini` 等 — 须进一步实测 (per task #111 benchmark Phase 3 + Open Q7)。

API key auth (set `OPENAI_API_KEY` env) 支持更多 models (按 OpenAI API platform availability)。

### 8.5 双 process 资源消耗

每个 codex-cli-mcp node = agent-node 进程 + codex mcp-server child 进程 + (codex 内部 startup) 子 MCP servers (per 8.4 mcp_startup_update events)。RAM 估 **~200-300MB per node** (claude-code-cli 是 ~150MB per node, **占位值待 task #111 benchmark 实测后 update**).

### 8.6 SYNC tool call hang → child timeout + watchdog spec (NEW per 通信牛 P1 #6)

**问题**: §8.2 述 SYNC return 不能 mid-turn steer; 若 codex 内部 hung tool call (e.g. shell 命令 deadlock / model API timeout / 子 MCP server stuck) → `tools/call codex` 不返 → **整个 agent-node turn 卡死, 全 anet node 不响应后续 commhub task**。

**Spec — child timeout + watchdog**:

```ts
class CodexCliMcpRuntime {
  private readonly TURN_TIMEOUT_MS = profile.flags?.codex?.turnTimeoutMs ?? 5 * 60 * 1000; // default 5min
  private readonly CHILD_HEALTHCHECK_MS = 30 * 1000; // 30s ping

  async onNewTask(task: TaskEvent) {
    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      this.log(`turn timeout after ${this.TURN_TIMEOUT_MS}ms, abort + kill child`);
      abortController.abort();
      this.killChild();          // SIGKILL codex mcp-server child
      this.respawnChild();       // 重启 child + re-handshake initialize
    }, this.TURN_TIMEOUT_MS);

    try {
      const r = await this.mcpClient.callTool({
        ...
        signal: abortController.signal,  // (若 SDK 支持 AbortSignal; Phase 0 spike verify)
      });
      clearTimeout(timeoutHandle);
      // ... per §4.3 error path
    } catch (err) {
      clearTimeout(timeoutHandle);
      await commhubSendReply({
        task_id: task.task_id,
        content: err.message === "AbortError" ? `Turn timeout after ${this.TURN_TIMEOUT_MS}ms` : err.message,
        isError: true,
      });
    }
  }

  private killChild() { this.daemon?.kill("SIGKILL"); }

  private async respawnChild() {
    await this.start(this.profile); // 重 spawn + initialize + thread/resume {this.threadId}
  }

  // Heartbeat — active-turn aware (per 通信牛 review checklist #1):
  // - inFlightTurn=true 时 SKIP listTools() (避免 active turn 期间 mcp-server 不响应 listTools 被误杀健康任务)
  // - active turn 用 codex/event 活跃度 + turnTimeoutMs 检测 hung (lastEventAt + 60s 无 event → suspect)
  // - idle 状态才 listTools() ping
  private inFlightTurn = false;
  private lastEventAt = Date.now();

  private startHealthcheck() {
    setInterval(async () => {
      // Active turn check: 用 codex/event 活跃度 判 hung (无 listTools 干扰)
      if (this.inFlightTurn) {
        const sinceLastEvent = Date.now() - this.lastEventAt;
        if (sinceLastEvent > 60 * 1000) {  // 60s 无 codex/event → suspect hung
          this.log(`active turn no event for ${sinceLastEvent}ms, suspect hung (turn timeout will fire at ${this.TURN_TIMEOUT_MS}ms)`);
          // 不立即 kill, 让 turn timeout watchdog (在 onNewTask) 处理 — 避免 race
        }
        return;
      }
      // Idle check: listTools() ping
      try {
        await Promise.race([
          this.mcpClient.listTools(),  // keep-alive query (仅 idle 跑)
          new Promise((_, rej) => setTimeout(() => rej(new Error("healthcheck timeout")), 5000)),
        ]);
      } catch {
        this.log("daemon unhealthy (idle ping failed), respawn");
        this.killChild();
        await this.respawnChild();
      }
    }, this.CHILD_HEALTHCHECK_MS);
  }

  // Mapper hook: each codex/event 更新 lastEventAt
  private updateActivity() { this.lastEventAt = Date.now(); }
}
```

**onNewTask 入口/出口 set inFlightTurn**:
```ts
async onNewTask(task: TaskEvent) {
  this.inFlightTurn = true;
  this.lastEventAt = Date.now();
  try {
    // ... turn watchdog + tool call (per §4.3 + §8.6 above)
  } finally {
    this.inFlightTurn = false;
  }
}
```

**Failure modes covered (per 通信牛 review checklist #1 amended)**:
- ✅ tool call hang > turnTimeoutMs (default 5min): AbortSignal trigger → kill + respawn child → anet 报 task error
- ✅ child silent hung **idle** (无 response on stdio): 30s healthcheck listTools() failed → kill + respawn
- ✅ child silent hung **active turn** (无 codex/event 60s+): lastEventAt 检测 log warning, turnTimeout 5min trigger kill — 避免 active turn listTools race kill 健康 long task
- ✅ child crash (segfault / OOM): node child_process `exit` event → 自动 respawn
- ⚠ thread/resume on respawn 须 thread persist 已 disk (rollout 文件)。若 turn 内 crash, 用户当前 task 失败但下一 task 仍可走 codex-reply resume (per §4.4)

**profile.flags.codex 加 timeout 字段**:
```json
"flags": {
  "codex": {
    "turnTimeoutMs": 300000,         // default 5min
    "childHealthcheckMs": 30000      // default 30s
  }
}
```

## 9. Testing

### 9.1 Docker E2E test 矩阵 (复用 PR #43 scaffold)

通信测试马 PR #43 当前 L3 用宽松 regex `codex.*mcp_servers\.commhub` cover TUI + batch 两模式. RFC-007 Path C 下 L3 regex 演进:

| Level | Check | RFC-007 path C 检查 |
|---|---|---|
| L0 | prerequisites | `which codex && which anet` |
| L1 | hub up | `anet hub start` + `curl /health` |
| L2 | node create | `anet node create test-codex-bot --runtime codex-cli-mcp` + `.anet/nodes/test-codex-bot/config.json` 写盘 |
| L3 | child spawn verify | `pgrep -f "codex mcp-server"` ← path C 模式 |
| L4 | MCP handshake | netcat / fifo 读 child stdin/stdout 验 `initialize` ack |
| L5 | tools/list verify | 验 codex + codex-reply 两 tool 都 listed |
| L6 | push verify | `anet commhub_send_task --alias test-codex-bot --task "hello"` → 验 codex 收到 tools/call codex → SYNC return 后 commhub 收 reply |
| L7 | live progress | 验 codex/event 流 forward 到 commhub `progress_events` 表 — **若 §3.0 Phase 0 spike 全 fail (degraded mode), L7 mark `expected_skip`** (per 通信牛 review checklist #5, implementation PR 须根据 spike result update test config) |
| L8 | cross-runtime | 起 codex-cli-mcp + claude-code-cli 两 node → A `send_task` B → 都能 daemon push |
| L9 | isError handling | 触发 codex 内部 error (e.g. model not available) → 验 anet 接到 isError=true + 正确 forward as task error |
| L10 | useUserConfig=false | 验 --ignore-user-config flag 透传 + codex 不加载 ~/.codex/config.toml mcp_servers |

L3 regex `codex.*mcp[_-]server` 修订: cover `mcp-server` subcommand spawn 模式。

### 9.2 Smoke test 流程

1. Vincent mac mini 跑 `anet node create vincent-codex --runtime codex-cli-mcp`
2. 启动 `anet node start vincent-codex`
3. 从指挥室 `commhub_send_task --alias vincent-codex --task "what is 2+2"`
4. 验:
   - codex live token stream 在 dashboard `<TaskChatPanel>` 渲染 (`<ProgressTimeline>` 显示 token_count + delta 流)
   - `4` 回到 commhub
5. 续单 `commhub_send_task --alias vincent-codex --task "what about 3+3"`
6. 验 threadId 复用 + 第二轮回 `6` + context 累积 (codex 知道前一轮聊过加法)

## 10. Future Work — Phase 2 + Non-goal

### 10.1 Phase 2 触发条件 (升级 ws daemon, 量化避免永不来)

升级到 RFC-006 archived path B (`codex remote-control` ws daemon) 的明确触发条件:

| 触发条件 | 衡量指标 |
|---|---|
| **TR1**: 用户/产品需要 mid-turn 干预 (停止 / 调整方向 / 注入额外信息) | Vincent / 用户在 5 个 task 中明确 ask "我能不能 cancel codex 中途换问题" |
| **TR2**: 单 codex 节点需 multi-anet-client peer attach (用户在 codex 跑 task 时 dashboard 显示 + iPhone app 同时 attach + anet wrapper 自己) | 用户 ask "我能 dashboard 跟 codex iOS app 同时看一个 codex agent 状态吗" |
| **TR3**: codex 0.131+ stabilize 后 ws transport 进入 stable 标识 + multi-client subscriber RFC merged | OpenAI changelog 标 `app-server websocket transport stable` + [issue #21551](https://github.com/openai/codex/issues/21551) closed with merged PR |

满足 2 个以上触发条件 → 启动 RFC-008-like new RFC (基于 RFC-006 Path B archive 重新 organize), Phase 2 加 `codex-cli-remote-control` runtime 作 alternative (双 runtime user 选)。

### 10.2 Non-goal — `codex-code-cli` TUI mode (Path A)

Phase 1 不 ship, Phase 2 也不 ship。用户直接跑 `codex` (默认 TUI) + 手配 `~/.codex/config.toml` `[mcp_servers.commhub]` 即可 (user-mode), anet 不重复包装。

### 10.3 Optional anet codex-setup user-mode 命令 (per 通信龙 plan §8 🥉)

非 runtime 路径, 帮用户配 `~/.codex/config.toml` 让用户 TUI 直接接 commhub MCP (user-mode 跟 daemon-mode 互补):

```bash
anet codex-setup --alias my-codex-user-tui
# 输出: 写 ~/.codex/config.toml [mcp_servers.commhub-anet] section + env var instructions
# 用户接下来直接跑 `codex` (TUI), codex 自动 connect commhub mesh
```

Phase 1 是否实施 待 Vincent 拍板 (Open Q raise in §11)。

### 10.4 anet-bridge fan-out 脑洞 (Option α — per 通信龙 plan §8 中期)

短期 1:1 mcp 简单稳定。中期: anet 自己写 broker layer fan-out codex/event 给多 anet client (不改 codex 源码) — anet wrapper 作 "shadow proxy" 接收 codex/event 单 stdio, fan-out 给多个内部 commhub consumer。Phase 2 backlog。

## 11. Open Questions

1. **Runtime naming** — `codex-cli-mcp` (RFC-007 选, 3-token 短)  vs `codex-code-cli-mcp` (4-token 跟 `claude-code-cli` symmetry)? — **建议 `codex-cli-mcp`**, 跟 Vincent 4067 推荐一致, 减 typing
2. **codex `--ignore-user-config` default 是否设？** — 设: avoid 用户 mcp_servers 污染 anet codex; 不设: 尊重用户已有配置 (per 通信龙 §1.2 实测 stale config 不影响 codex 主体, 仅 cosmetic mcp_startup fail) — **建议 `useUserConfig: true` default (不 ignore), profile.flags.codex.useUserConfig=false 让用户 opt-out**
3. ~~**Approval policy default**~~ — **RESOLVED per Vincent §6.5 telegram 4144 Option A**: default `never` (跟 anet autonomous teammate-mode 一致), conservative (`on-failure` / `untrusted` 等) 走 profile.flags.codex.approvalPolicy opt-in 路径
4. **Escalate target alias 当 dangerous approval** — 走 commhub_send_task 到 `指挥室` 还是 telegram channel? — **建议: profile.flags.codex.escalateAlias 配置, default `指挥室`**
5. **Thread per session vs per task** — Phase 1 hardcode `session` 简化; Phase 2 加选项? — **建议 Phase 1 仅 session, Phase 2 加 profile.flags.codex.threadStrategy 选项**
6. **codex/event mapper 完整性** — 13 个 event type 都 map 还是仅 5 个 high-value (lifecycle + delta + complete)? — **建议 Phase 1 仅 high-value 5 个, Phase 2 全 map**
7. **ChatGPT account auth supported models** — gpt-5 / gpt-5-codex / o3 / o4-mini 哪些 default 推荐? gpt-4.1-mini 实测 fail (per 通信龙 §0.3) — **建议 wizard 列 supported model 矩阵 + 用户输入, default 不强制 (per 实测 model availability 实时变化)**
8. **codex auth (OpenAI API key) 如何 inherit** — stdio child inherit env 默认拿 `OPENAI_API_KEY` from anet env? 还是用户走 `codex login` 持久化? — **建议: 推荐用户先 `codex login` (OAuth 持久化), anet 不管 auth**
9. **agent-node 多 codex-cli-mcp runtime 同 host RAM** — 实测 codex mcp-server idle ~50MB / running ~150MB / + agent-node node ~100MB = 总 200-300MB per node — **建议 doc 标注每节点 200-300MB RAM 预算** (task #111 benchmark confirm 后定值)
10. ~~`codex/event` notification handler @modelcontextprotocol/sdk API verify~~ — **promoted to §3.0 Phase 0 spike gate (blocking)** per 通信牛 review P1 #2
11. **Vincent codex mac mini version 验证** — 通信龙 telegram 4054 paste 显示含 `codex app` 但需 final confirm 含 `codex mcp-server` — **不阻塞, 等 Vincent `codex --version` 反馈**
12. **Optional anet codex-setup 命令** — Phase 1 包含 (帮用户 user-mode 也接 mesh) vs 推迟 Phase 2 (避免 scope creep)? — **建议 Phase 1 ship 简单版** (cli.ts `anet codex-setup --alias X` 仅 print toml + env var template, 不自动写文件), 真写文件版 Phase 2 加 `--apply` flag

## 12. Timeline

**Day 1 (today 2026-05-13)**:
- ✅ 通信龙 deep design doc 24b744e (Path B + C 初探)
- ✅ Path B 深度调研 doc [`docs/anet-codex-remote-control-plan.md`](../anet-codex-remote-control-plan.md) (通信SDK马 093d76a)
- ✅ Path C 深度调研 doc [`docs/anet-codex-mcp-server-plan.md`](../anet-codex-mcp-server-plan.md) (通信龙 98b6728)
- ✅ codex 深度调研 doc [`docs/codex-deep-research.md`](../codex-deep-research.md) (通信SDK马 96430e6, evidence multi-client falsify Path B 卖点)
- ✅ Vincent 4136 final pivot Path C
- ⏳ RFC-007 主体 ship (本 commit, Path C clean)
- ⏳ RFC-006 mark Superseded by RFC-007 (下一 commit)

**Day 2** (通信牛 review 过后):
- 通信工程马 unstash worktree (`~/anet-work/rfc-005-codex-code-cli/`) + 重写 #6 launchAgent 改 `spawnAgentNode(profile, {runtime: "codex-cli-mcp"})` delegate (vs ws spawn)
- 通信工程马 起 agent-node `src/runtime/codex-cli-mcp.ts` runtime adapter (~250-350 行)
- 通信测试马 PR #43 演进 L3 regex `mcp-server` + 新 L5 tools/list / L9 isError / L10 useUserConfig

**Day 3**:
- 联合 smoke test 跑通 commhub_send_task → codex → reply
- Vincent mac mini 亲测
- Ship preview `2.1.8-preview.N`
- Vincent 亲测通过 → 升 latest `2.1.8` stable 大 feature

## 13. 结论

✅ **Vincent 4136 final pivot Path C accepted** — 6 轮 architectural pivot 收敛到 mcp-server stdio (实证 multi-client thread streaming hands-on falsify Path B 卖点)
✅ **架构方向定了** — Option 2 agent-node bridge + MCP stdio + `@modelcontextprotocol/sdk` 复用
✅ **工作量 manageable** — ~250-350 行 agent-node + ~30-50 行 cli.ts + ~300 行 test = 总 ~600-700 行, 1-2 天 ship 2.1.8 大 feature
✅ **Live UX 完整** — token-level streaming forward 到 dashboard `<ProgressTimeline>` (跟 claude agent 对称)
✅ **协议稳定** — mcp-server 早 stable, 不依赖 stabilize 中的 ws transport PRs
⚠ **12 个 Open Questions** 待 Vincent 拍板 (§11) — 大部分有 RFC 默认推荐, Vincent 仅须 confirm naming + ChatGPT model + Optional codex-setup
🟡 **Phase 2 升级路径明确** — §10.1 TR1-TR3 触发条件量化避免永不来

后续动作:
- ✅ RFC-005 mark Superseded ([commit 63b28e3](https://github.com/sleep2agi/agent-network/commit/63b28e3))
- ⏳ RFC-006 mark Superseded by RFC-007 (next commit)
- ⏳ 通信工程马 unstash worktree + 实施 agent-node `codex-cli-mcp.ts` runtime adapter
- ⏳ 通信测试马 PR #43 演进 L0-L10
- ⏳ Vincent 回答 §11 12 个 Open Questions (重点 Q1 naming / Q7 ChatGPT model / Q12 Optional codex-setup)
- ⏳ 联合 smoke test → ship 2.1.8 preview → Vincent 亲测 → ship 2.1.8 latest stable 大 feature

— END —
