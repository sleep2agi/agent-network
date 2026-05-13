# RFC-006：codex-code-cli runtime — 通过 `codex mcp-server` stdio 让 anet 用户直接用 Codex CLI 接 commhub

| 字段 | 内容 |
|---|---|
| 状态 | **Proposed**（supersedes RFC-005） |
| 提出 | 2026-05-13 |
| 作者 | 通信SDK马 |
| 派单 / 决策 | 通信龙（roadmap + architecture pivot + deep design doc 24b744e） |
| Helpers | 通信工程马（cli.ts implementer eval + Option 2 architecture choice） |
| 关联 issue | [#18](https://github.com/sleep2agi/agent-network/issues/18) SDK research loop |
| 关联 RFC | RFC-002 channel-bind-cli / RFC-003 node telemetry / **RFC-005 superseded** |
| 前置研究 | [commit 6429bc0](https://github.com/sleep2agi/agent-network/commit/6429bc0) codex CLI 直接通信 / [commit 24b744e](https://github.com/sleep2agi/agent-network/commit/24b744e) 通信龙深度设计（B path） / 本 session protocol schema dump + `codex mcp-server` real probe |
| 目标版本 | agent-network v2.1.8（Phase 1 大 feature）+ agent-node v2.5 |
| 实施人 | 通信工程马（agent-node runtime adapter + cli.ts delegate） |

## 摘要

给 anet 加第 5 个 runtime — `codex-code-cli`，通过 spawn `codex mcp-server` stdio 子进程 + anet 作为 MCP client 调用 `codex` / `codex-reply` 两个 tool 的方式，让用户在 `anet node create --runtime codex-code-cli` 后启动节点时**自动接入 commhub mesh** — 跟其他 agent 用 `send_task / get_inbox / get_all_status` 等工具通信。**目的**：让 codex CLI 用户像 claude-code-cli runtime 一样直接接入 anet，**且实现成本仅 ~150-200 行**（RFC-005 TUI 方案估 ~80 行但不能 push，RFC-005 B 方案 ws daemon 估 ~590 行复杂度过高且协议未稳定）。

## 1. 背景

### 1.1 anet 当前 runtime 矩阵

`agent-network/bin/cli.ts:133` 当前：

```ts
type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk" | "http-api";
```

| Runtime | binary / SDK | claude | codex | push-driven |
|---|---|---|---|---|
| `claude-code-cli` | spawn `claude` 二进制 + channel plugin | ✅ | — | ✅ |
| `claude-agent-sdk` | npm SDK `@anthropic-ai/claude-agent-sdk` | ✅ | — | ✅ |
| `codex-sdk` | npm SDK `@openai/codex-sdk` | — | ✅ | ✅ |
| `http-api` | OpenAI-compatible HTTP fetch | ✅ | ✅ | ✅ |

**Gap**: claude 侧有 CLI 二进制路径（claude-code-cli），codex 侧只有 SDK，缺 codex CLI 二进制路径让 codex CLI 用户原地接入 anet。

### 1.2 Architectural Pivot — 从 RFC-005 三种方案到 RFC-006 Path C

RFC-005（草案）原描述 spawn `codex` TUI 二进制 + 注入 commhub MCP 的方式。在 Vincent telegram 4023-4063 持续 push 下，本 session 实测调研发现三条候选路径：

| Path | 描述 | 复杂度 | Push 能力 | 协议稳定性 |
|---|---|---|---|---|
| **A — RFC-005 TUI mode** | spawn `codex` TUI + 注入 MCP commhub | ~80 行 | ❌ pull-on-prompt（idle TUI 不会响应 commhub push） | ✅ stable |
| **B — `codex remote-control` ws daemon** | spawn `codex remote-control` headless daemon + anet 作 ws client（[PR #21424](https://github.com/openai/codex/pull/21424) merged 2026-05-07） | ~590-680 行（含 ws 模块 + auth + 单 client supervision） | ✅ 完整 JSON-RPC 2.0 push（turn/start + 63 ServerNotification） | ⚠ 本周仍 stabilize（[#22404](https://github.com/openai/codex/pull/22404) / [#22414](https://github.com/openai/codex/pull/22414) / [#22386](https://github.com/openai/codex/pull/22386) 都 2026-05-13 today landing） |
| **C — `codex mcp-server` stdio** | spawn `codex mcp-server` stdio child + anet 作 MCP client（@modelcontextprotocol/sdk 复用） | **~150-200 行** | ✅ MCP `tools/call codex` SYNC return + 期间 `codex/event` 实时流（含 token-level delta） | ✅ stable（`mcp-server` 早于 0.130 已 ship） |

**Path C 是 clear winner（详见 §3.2 三路径对比）**。RFC-006 基于 C path 重新 organize；RFC-005 标记 `Superseded by RFC-006`，全文保留作架构决策历史。

### 1.3 codex 0.130 `mcp-server` protocol probe（实测 evidence）

`codex --version` → `codex-cli 0.130.0`。`codex mcp-server` stdio 实测：

```jsonrpc
// initialize ack
{"id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":true}},"serverInfo":{"name":"codex-mcp-server","title":"Codex","version":"0.130.0",...}}}

// tools/list 返回 2 tools
{"id":2,"result":{"tools":[
  {"name":"codex","description":"Run a Codex session...","inputSchema":{"properties":{"prompt":{...required},"cwd":{...},"model":{...},"sandbox":{...},"approval-policy":{...},"profile":{...},"config":{...}}}},
  {"name":"codex-reply","description":"Continue a Codex conversation...","inputSchema":{"properties":{"threadId":{...required},"prompt":{...required}}}}
]}}
```

跑一个 real prompt `tools/call codex {prompt: "say hello in one word"}` 实测 — **SYNC return + 期间 emit 实时 `codex/event` JSON-RPC notifications 流**:

```jsonrpc
// 调用中 ~10 个 events 流（节选）:
{"method":"codex/event","params":{"msg":{"type":"task_started","model_context_window":258400,...}}}
{"method":"codex/event","params":{"msg":{"type":"item_started","item":{"type":"AgentMessage",...}}}}
{"method":"codex/event","params":{"msg":{"type":"agent_message_content_delta","delta":"Hello"}}}    ← token-level streaming
{"method":"codex/event","params":{"msg":{"type":"item_completed",...}}}
{"method":"codex/event","params":{"msg":{"type":"task_complete","duration_ms":3088,"time_to_first_token_ms":2944}}}

// 末尾 SYNC return result:
{"id":2,"result":{"content":[{"type":"text","text":"Hello"}],"structuredContent":{"threadId":"019e1fb1-8c39-...","content":"Hello"}}}
```

**关键发现**: `codex/event` 是 codex-mcp-server 的**非标准 MCP notification**（method 字段是 `codex/event`，不是标准 MCP `notifications/progress`）。anet MCP client 须在 @modelcontextprotocol/sdk 之上 register catch-all notification handler 才能捕获（详见 §5）。

## 2. 设计目标

| 目标 | 描述 |
|---|---|
| **G1 — 对称 anet runtime** | codex CLI 用户跟 claude-code-cli 用户体验对称（functional + behavioral parity） |
| **G2 — Push-driven** | commhub `send_task` 到达 → codex 自动响应（不依赖用户手动在 TUI 输入） |
| **G3 — Live agent UX** | Dashboard / SaaS client 看到 codex agent live token stream（不是派单后静默 N 分钟） |
| **G4 — 最小实现成本** | 复用 anet 现有 `@modelcontextprotocol/sdk` dep + agent-node 现有 codex-sdk runtime supervision 框架，目标 ~150-200 行 |
| **G5 — 协议稳定** | 走 stable mcp-server protocol，不依赖正在 stabilize 的 ws transport 系列 PR |
| **G6 — 安全默认** | approval-policy 默认 conservative，dangerous 操作 fall back escalate 或 deny |
| **G7 — 升级路径** | Phase 2 升级 ws daemon path（when 需要 turn/steer mid-execution / multi-client peer 时） |

## 3. 设计

### 3.1 Architecture — Option 2 (agent-node bridge)

```
[commhub-server]
       |
       | SSE (new_task event for codex-bot)
       v
[agent-node (codex-code-cli runtime adapter)]
       |
       | MCP stdio (via @modelcontextprotocol/sdk StdioClientTransport)
       v
[codex mcp-server child process]
       |
   1. Init: initialize / notifications/initialized handshake
   2. tools/call codex {prompt, cwd, model, sandbox, approval-policy}
        ↳ 期间 emit `codex/event` notifications stream（token deltas + lifecycle）
        ↳ end: SYNC return {content, structuredContent: {threadId, content}}
   3. 续单: tools/call codex-reply {threadId, prompt}
       |
       v
[agent-node bridge]
   - Forward live codex/event → commhub report_progress (RFC-003 telemetry)
   - Aggregate final output → commhub_send_task reply
       |
       v
[commhub]
```

**关键架构选择 — Option 2 vs Option 1**（per 通信工程马 e50eda1a + 9c43ba4e 共识）:

- **Option 1**: anet CLI (cli.ts) 直接做 MCP client bridge — cli.ts 肿胀（+290 行）
- **Option 2** ✅: cli.ts 仅 spawn `agent-node` 子进程（thin launcher，~30-50 行 dispatch），agent-node 内含 `codex-code-cli` runtime adapter 跟现有 `codex-sdk` runtime 同框架共用 supervision

Option 2 让 cli.ts 保持 launcher 角色不肿胀，跟 codex-sdk runtime 复用 daemon lifecycle（重连 / heartbeat / shutdown），是 anet 现有架构自然 extension。

### 3.2 三路径对比矩阵（决策依据）

| 维度 | 🅰 RFC-005 TUI spawn | 🅱 remote-control ws daemon | 🅲 mcp-server stdio （本 RFC） |
|---|---|---|---|
| **Push driven?** | ❌ pull on user prompt | ✅ ws turn/start | ✅ stdio tools/call |
| **codex version 要求** | 任意 | 0.130+（[PR #21424](https://github.com/openai/codex/pull/21424)） | 0.130+ (早期已 ship) |
| **协议 stability** | stable | ⚠ stabilize 中（5-13 仍 3 PRs landing） | ✅ stable |
| **Daemon supervision** | TUI process | 持续 daemon + 须 anet 写 supervisor | per-task / per-session child（生死跟 anet 同步） |
| **anet 现 dep 复用** | inquirer | 0（new ws module 须） | ✅ @modelcontextprotocol/sdk（已 dep） |
| **Auth complexity** | none | bearer JWT/capability-token 须 anet 签 | none（stdio child inherit env） |
| **Live event stream** | n/a | ✅ ServerNotification 63 events | ✅ codex/event（含 token delta） |
| **Single-client 限制** | n/a | ⚠ [issue #21551](https://github.com/openai/codex/issues/21551) open（peer-client co-presence 未 ship） | ✅ N/A（per-child stdio 隔离） |
| **Turn 中断 / steer** | n/a | ✅ turn/interrupt + turn/steer | ❌ SYNC return（不能 mid-turn 干预） |
| **Approval flow** | manual | server→client 9 个 reverse ServerRequest 须 anet 决策 | inherit codex 静态 approval-policy 参数（"never" / "on-failure" / "on-request" / "untrusted"） |
| **anet 代码量** | ~80 行 cli.ts | ~590-680 行（ws + bridge + supervision） | **~150-200 行** |
| **多 anet session 同 host** | n/a | port 冲突管理须 | ✅ 自然 stdio 隔离 |

Path C 在 7/12 维度优于 Path B，3/12 维度持平，2/12（Turn 中断 / Live event 类型）B 更全（但 C 通过 `codex/event` 覆盖 90% UX 需求）。**C 在复杂度 / 代码量 / 协议稳定性三大决策维度全面胜出，是 Phase 1 唯一合理选择**。

### 3.3 cli.ts 改动（~30-50 行）

类比 codex-sdk runtime（thin launcher，重活在 agent-node）:

```ts
// L133 RuntimeName enum 加 codex-code-cli
type RuntimeName = "claude-code-cli" | "codex-sdk" | "codex-code-cli" | "claude-agent-sdk" | "http-api";

// normalizeRuntime branch
function normalizeRuntime(r: string): RuntimeName {
  switch (r) {
    case "codex-cli":
    case "codex-code-cli":
      return "codex-code-cli";
    // ... existing branches
  }
}

// checkRuntimeDependency 加 codex 二进制 check
if (profile.runtime === "codex-code-cli") {
  if (!commandExists("codex")) {
    warn("Install codex CLI: npm i -g @openai/codex@latest");
    return false;
  }
  // verify codex --version >= 0.130.0
  const v = execFileSync("codex", ["--version"], {encoding: "utf-8"}).trim();
  // semver check
}

// setupCommand wizard choices 加 codex-code-cli 选项

// launchAgent dispatch 加 case 'codex-code-cli' → delegate agent-node
case "codex-code-cli":
  return spawnAgentNode(profile, { runtime: "codex-code-cli" });
```

通信工程马 worktree `~/anet-work/rfc-005-codex-code-cli/` 6 edit 中 5 个直接复用（RuntimeName enum / normalizeRuntime / checkRuntimeDependency / setupCommand checkbox / setupCommand install logic）。第 6 个 launchAgent spawn 段从 `spawn codex 二进制 + 注入 MCP` 改为 `spawnAgentNode(profile, {runtime: "codex-code-cli"})`，跟 codex-sdk dispatch 同款。

### 3.4 agent-node 改动（~150-200 行）

新增 `agent-node/src/runtime/codex-code-cli.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export class CodexCodeCliRuntime {
  private mcpClient: Client;
  private transport: StdioClientTransport;
  private threadId?: string;

  async start(profile: Profile) {
    this.transport = new StdioClientTransport({
      command: "codex",
      args: ["mcp-server"],
      env: { ...process.env /* codex 不需要额外 token，stdio inherit */ },
    });

    this.mcpClient = new Client(
      { name: "anet-codex-code-cli", version: AGENT_NODE_VERSION },
      { capabilities: {} }
    );

    // Register catch-all notification handler 捕 `codex/event`（非标 MCP method）
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
    const args: Record<string, unknown> = {
      prompt: task.task,
      cwd: profile.cwd,
      model: profile.model,
      sandbox: profile.flags?.codex?.sandbox ?? "workspace-write",
      "approval-policy": profile.flags?.codex?.approvalPolicy ?? "on-failure",
    };

    if (this.threadId) {
      // 续单
      const r = await this.mcpClient.callTool({
        name: "codex-reply",
        arguments: { threadId: this.threadId, prompt: task.task },
      });
      await this.replyToCommhub(task, r);
    } else {
      // 首单（自动开 thread）
      const r = await this.mcpClient.callTool({ name: "codex", arguments: args });
      this.threadId = (r.structuredContent as any)?.threadId;
      await this.replyToCommhub(task, r);
    }
  }

  // 主进程关停 → kill child
  async shutdown() {
    await this.mcpClient.close();
    await this.transport.close();
  }
}
```

复用 `codex-sdk` runtime 现有 supervision 框架（spawn / supervise / respawn / shutdown），仅替换 transport + tool call payload。

### 3.5 完整 sequence diagram

```
[commhub-server] -- SSE new_task --> [agent-node codex-code-cli runtime]
                                              |
                                              | tools/call codex { prompt, cwd, model, sandbox, approval-policy }
                                              v
                                  [codex mcp-server child]
                                              |
                                              |- codex/event { type: session_configured }
                                              |- codex/event { type: task_started }
                                              |- codex/event { type: item_started, item: AgentMessage }
                                              |- codex/event { type: agent_message_content_delta, delta: "Hello" }
                                              |- codex/event { type: item_completed }
                                              |- codex/event { type: task_complete, duration_ms, time_to_first_token_ms }
                                              v
                                  SYNC return { content, structuredContent: { threadId, content } }
                                              |
                                              v
                              [agent-node bridge]
                              - codex/event 流式 → commhub `report_progress` MCP (RFC-003 telemetry)
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
| `cwd` | optional | 工作目录（默认 agent-node 自身 cwd） |
| `model` | optional | `gpt-5.2` / `gpt-5.2-codex` 等（profile 配置） |
| `sandbox` | optional | `read-only` / `workspace-write` / `danger-full-access`（默认 `workspace-write`，per §6） |
| `approval-policy` | optional | `untrusted` / `on-failure` / `on-request` / `never`（默认 `on-failure`，per §6） |
| `profile` | optional | codex 自身 profile（`~/.codex/config.toml` 的 `[profiles.X]` 节） |
| `config` | optional | inline 配置覆盖（dotted-key TOML override 兼容 codex `-c key=val` 语义） |
| `developer-instructions` | optional | 注入 developer-role system prompt（anet 可注入 "你已接入 anet network..." 提示） |
| `base-instructions` | optional | 完全替换 codex 默认 base instructions（advanced，profile 配置） |

返回 outputSchema:
```ts
{
  content: [{ type: "text", text: <final output> }],
  structuredContent: { threadId: string, content: string }
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

### 4.3 Thread lifecycle 策略

**默认 per session 一个 thread**（跟 claude-code-cli runtime 一致）— agent-node 进程 lifetime 内首单创建 threadId，后续 task 全用 `codex-reply { threadId, prompt }`。优点：context 累积、模型记忆历史 task；缺点：context 超长可能撞 model_context_window（258400 tokens for gpt-5.2 per probe）。

**Phase 2 升级**: 加 `profile.flags.codex.threadStrategy: "session" | "task"` 选项，task 模式每个 commhub task 起新 thread（clean isolation）。Phase 1 hardcode `session` 简化。

## 5. Live Progress Forwarding —— `codex/event` → commhub `report_progress`（RFC-003 复用）

### 5.1 `codex/event` notification 类型清单（probe 实测）

| codex/event type | 触发时机 | RFC-003 NodeEvent.kind mapping |
|---|---|---|
| `session_configured` | session 初始化 | `ProgressKind.LIFECYCLE`, sub_state=`session_ready` |
| `mcp_startup_update` | MCP 子服务 starting/ready/failed | `ProgressKind.SUBSYSTEM`, sub_state=server-state |
| `task_started` | turn 开始 inference | `ProgressKind.TURN_STARTED` |
| `item_started` (AgentMessage) | model 开始生成回复 | `ProgressKind.AGENT_MESSAGE_STARTED` |
| `agent_message_content_delta` | token-level streaming | `ProgressKind.AGENT_MESSAGE_DELTA`（high-frequency，batch） |
| `item_started` (CommandExecution) | model 决定执行 shell 命令 | `ProgressKind.TOOL_CALL_STARTED` |
| `item_completed` (CommandExecution) | shell 命令完成 | `ProgressKind.TOOL_CALL_COMPLETED` |
| `item_started` (FileChange) | model 改文件 | `ProgressKind.FILE_CHANGE_STARTED` |
| `item_completed` (FileChange) | 文件改完 | `ProgressKind.FILE_CHANGE_COMPLETED` |
| `agent_message` | 完整回复（end of streaming） | `ProgressKind.AGENT_MESSAGE_COMPLETED` |
| `token_count` | rate-limit + usage update | `ProgressKind.USAGE_UPDATE` |
| `task_complete` | turn 结束 | `ProgressKind.TURN_COMPLETED`, fields={duration_ms, time_to_first_token_ms} |
| `raw_response_item` | 原始 model 输出 item | low-priority debug，**不 forward**（noise 太多） |

### 5.2 Schema mapping（per 通信工程马 review focus）

agent-node bridge 内置 mapper 函数:

```ts
function codexEventToNodeEvent(ev: CodexEvent): NodeEvent | null {
  const { type, ...rest } = ev.msg;
  switch (type) {
    case "agent_message_content_delta":
      return {
        kind: ProgressKind.AGENT_MESSAGE_DELTA,
        sub_state: null,
        delta_text: rest.delta,
        item_id: rest.item_id,
        thread_id: rest.thread_id,
        turn_id: rest.turn_id,
        timestamp: Date.now(),
      };
    case "task_complete":
      return {
        kind: ProgressKind.TURN_COMPLETED,
        sub_state: null,
        duration_ms: rest.duration_ms,
        time_to_first_token_ms: rest.time_to_first_token_ms,
        last_agent_message: rest.last_agent_message,
        timestamp: Date.now(),
      };
    // ... 其他 mapping
    case "raw_response_item":
      return null;  // skip noise
  }
}
```

### 5.3 Batch / Backpressure 策略（per 通信工程马 review focus）

`agent_message_content_delta` 在快速生成时可能 token-per-event（实测 1 字 1 event），single token sends 会 flood commhub `report_progress`。Phase 1 采用 **简单 batch 策略**:

- delta events 用 in-memory 累积 buffer，每 200ms flush 一次（或满 1KB 文本时立即 flush）
- 其他 lifecycle events（task_started / item_completed / task_complete 等）立即 forward（low frequency）
- commhub `report_progress` 单条 payload size cap 4KB（commhub-server 端 enforce），超过 reject + agent-node retry 拆 chunk

Phase 2 可加 backpressure：commhub 端返 429 时 agent-node 降频 + drop oldest delta（保 lifecycle）。Phase 1 不实现。

### 5.4 跟 RFC-003 telemetry layer 复用

RFC-003 已定义 `commhub_report_progress` MCP method + `progress_events` SQLite 表 + SSE `progress` 事件类型 + dashboard `<ProgressTimeline>` 渲染。**RFC-006 直接复用，无 commhub schema 改动**。agent-node bridge 加 codex/event mapper 后直接调 existing `commhub_report_progress`。Dashboard 端因为 NodeEvent schema 统一，codex agent 跟 claude agent 在 timeline 上同款渲染。

## 6. Configuration — Approval Policy & Sandbox

### 6.1 静态 approval-policy 参数（vs B path reverse ServerRequest 复杂决策）

`codex mcp-server` 的 `tools/call codex` 接受 `approval-policy` 参数，取值:

| 值 | codex 行为 | anet 适用场景 |
|---|---|---|
| `untrusted` | 所有 shell 命令需 approval | 高安全场景（公开 demo / Vincent 试新 agent） |
| `on-failure` | 仅命令失败后才 ask | **默认推荐**（balance 自动化 + 安全） |
| `on-request` | model 自己判断要 ask 才 ask | 中等信任（用户已熟悉 codex 行为） |
| `never` | 全自动批准 | dev 内网 + 完全信任（不推荐生产） |

**RFC-006 默认值 `on-failure`** — 跟 codex CLI default 一致，balance 自动化跟安全。在 sandbox=`workspace-write` 限制下，approval-policy=`on-failure` 是合理 default。

### 6.2 默认 sandbox=`workspace-write`

`sandbox` 参数取值:

| 值 | 权限 | 场景 |
|---|---|---|
| `read-only` | 仅读 + 禁网 | 极保守（仅 query / review 类 task） |
| `workspace-write` | 读 + 写 cwd + 禁网 | **默认推荐**（agent 改 cwd 文件 OK，不能伤害 cwd 外 + 不能联网） |
| `danger-full-access` | 全访问 | 不推荐（除非用户明确 opt-in） |

### 6.3 profile.flags.codex 配置 schema

`anet node create` 写入 `.anet/nodes/<alias>/config.json` 时支持:

```json
{
  "runtime": "codex-code-cli",
  "model": "gpt-5.2-codex",
  "flags": {
    "codex": {
      "approvalPolicy": "on-failure",
      "sandbox": "workspace-write",
      "profile": "<可选 codex profile 名 from ~/.codex/config.toml>",
      "config": { /* inline TOML overrides */ }
    }
  }
}
```

agent-node runtime adapter 启动 tools/call 时透传这些字段。

### 6.4 Codex MCP servers 嵌套（用户已有 ~/.codex/config.toml mcp_servers）

实测 probe 时 `codex mcp-server` 自动加载 `~/.codex/config.toml` 里的 `[mcp_servers.*]`（如 `commhub-proxy`）— 用户已有自定义 MCP 配置不会被 RFC-006 干扰。anet 不修改用户 `~/.codex/config.toml`，仅注入 tools/call 参数。

## 7. Setup / cli.ts integration

### 7.1 Setup wizard 添加 runtime 选项

`anet node create` 交互流程（cli.ts setup wizard）当前有 4 runtime 选项，加 5th:

```
? Select runtime:
  ❯ claude-code-cli (Claude CLI binary)
    claude-agent-sdk (Anthropic SDK)
    codex-sdk (OpenAI Codex SDK)
    codex-code-cli (Codex CLI via mcp-server) ← NEW
    http-api (OpenAI-compatible HTTP)
```

后续 prompt 加 codex-code-cli 特有问题:
- approval-policy: `untrusted` / `on-failure` (default) / `on-request` / `never`
- sandbox: `read-only` / `workspace-write` (default) / `danger-full-access`
- model: gpt-5.2-codex (default) / gpt-5.2 / 其他

### 7.2 cli.ts → agent-node delegate

`launchAgent` dispatch:

```ts
case "codex-code-cli":
  // 跟 codex-sdk runtime 同框架走 agent-node 子进程
  return spawnAgentNode(profile, { runtime: "codex-code-cli" });
```

Setup wizard 之外的 cli.ts 改动量 minimal（~30 行 dispatch + checkRuntimeDependency + assertStartCompatibility）。

## 8. Testing

### 8.1 Docker E2E test 矩阵（复用 PR #43 scaffold）

通信测试马 PR #43（test28-codex-code-cli E2E）当前 L3 用宽松 regex `codex.*mcp_servers\.commhub` cover TUI + batch 两模式。RFC-006 path C 下 L3 regex 演进:

| Level | Check | RFC-006 path C 检查 |
|---|---|---|
| L0 | prerequisites | `which codex && which anet` |
| L1 | hub up | `anet hub start` + `curl /health` |
| L2 | node create | `anet node create test-codex-bot --runtime codex-code-cli` + `.anet/nodes/test-codex-bot/config.json` 写盘 |
| L3 | child spawn verify | `pgrep -f "codex mcp-server"` ← path C 模式（vs RFC-005 path A `codex` TUI 或 path B `codex remote-control`） |
| L4 | MCP handshake | netcat / fifo 读 child stdin/stdout 验 `initialize` ack |
| L5 | tools/list verify | 验 codex + codex-reply 两 tool 都 listed |
| L6 | push verify | `anet commhub_send_task --alias test-codex-bot --task "hello"` → 验 codex 收到 tools/call codex → SYNC return 后 commhub 收 reply |
| L7 | live progress | 验 codex/event 流 forward 到 commhub `progress_events` 表 |
| L8 | cross-runtime | 起 codex-code-cli + claude-code-cli 两 node → A `send_task` B → 都能 daemon push |

L3 regex `codex.*mcp[_-]server` 修订：cover `mcp-server` subcommand spawn 模式。Phase 2 ws daemon 后再扩展。

### 8.2 Smoke test 流程

1. Vincent mac mini 跑 `anet node create vincent-codex --runtime codex-code-cli`
2. 启动 `anet node start vincent-codex`
3. 从指挥室 `commhub_send_task --alias vincent-codex --task "what is 2+2"`
4. 验:
   - codex live token stream 在 dashboard `<TaskChatPanel>` 渲染（`<ProgressTimeline>` 显示 token_count + delta 流）
   - `4` 回到 commhub
5. 续单 `commhub_send_task --alias vincent-codex --task "what about 3+3"`
6. 验 threadId 复用 + 第二轮回 `6` + context 累积（codex 知道前一轮聊过加法）

## 9. Risks & Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| `codex mcp-server` 在未来 codex release 中协议变更 | 🟡 medium | Pin codex@>=0.130 + 加 schema verify on start（tools/list 必须含 codex + codex-reply）+ fail-fast if mismatch |
| `codex/event` 非标 MCP notification @modelcontextprotocol/sdk 不识别 | 🟡 medium | catch-all `setNotificationHandler` register（@modelcontextprotocol/sdk 1.12+ 支持 fallback handler） |
| SYNC return 不能 turn/steer mid-execution | 🟢 low → high (per use case) | Phase 1 接受限制（适合 batch task / 短轮次）；Phase 2 升级 ws daemon mode 满足 mid-turn steer 需求 |
| token delta flood commhub `report_progress` | 🟡 medium | §5.3 batch 策略（200ms / 1KB flush）+ Phase 2 backpressure |
| codex child 进程 idle 资源占用 | 🟢 low | per-session lifetime（agent-node 启动时起，关停时 kill），不长期 idle |
| 用户 `~/.codex/config.toml` 已有冲突 MCP 配置 | 🟢 low | anet 不修改用户文件；anet 注入仅 tools/call 参数，用户配置和 anet 配置并存 |
| `approval-policy=on-failure` default 可能仍触发太多 ask | 🟡 medium | Smoke test 跟踪；如太多，default 降到 `untrusted`（更保守） |
| codex 0.130 cross-platform (mac/linux/windows) `mcp-server` 行为差 | 🟡 medium | Vincent mac mini final verify + Docker linux E2E + Windows 等 Vincent feedback |
| `codex mcp-server` 默认加载 `~/.codex/config.toml` 把用户 mcp_servers 全注入 — context bloat | 🟡 medium | profile.flags.codex 加 `useUserConfig: false` 选项透传 `--ignore-user-config`（codex 支持） |

## 10. Future Work — Phase 2 升级 ws daemon mode

### 10.1 Phase 2 触发条件（量化，避免永不来 — per 通信工程马 review focus）

升级到 RFC-005 path B（`codex remote-control` ws daemon）的明确触发条件:

| 触发条件 | 衡量指标 |
|---|---|
| **TR1**: 用户/产品需要 mid-turn 干预（停止 / 调整方向 / 注入额外信息） | Vincent / 用户在 5 个 task 中明确 ask "我能不能 cancel codex 中途换问题" |
| **TR2**: 单 codex 节点需 multi-client peer attach（用户在 codex 跑 task 时 dashboard 显示 + iPhone app 同时 attach） | 用户 ask "我能 dashboard 跟 codex iOS app 同时看一个 codex agent 状态吗" |
| **TR3**: codex 0.131+ stabilize 后 ws transport 进入 stable 标识 | OpenAI changelog 标 `app-server websocket transport stable` + remove "experimental" caveat |
| **TR4**: codex 引入 inject_items 等 push 入口 + multi-subscriber RFC（[issue #21551](https://github.com/openai/codex/issues/21551)） merged | issue #21551 closed with merged PR |

满足 2 个以上触发条件 → 启动 Phase 2 RFC-007（基于 RFC-005 path B 重新 organize）。

### 10.2 Phase 2 跟 Phase 1 复用度

| 模块 | 复用度 | 备注 |
|---|---|---|
| cli.ts spawn dispatch | 100% | runtime: `codex-code-cli` 不变，agent-node 内换 adapter 实现 |
| agent-node runtime adapter 框架 | 80% | supervision / restart / lifecycle 全保留，替换 MCP stdio → WS JSON-RPC |
| codex/event 流 → commhub mapping | 80% | event 类型相似（task_started / item_completed / agent_message_content_delta），新增 ServerRequest 9 个 reverse approval flow |
| Dashboard `<ProgressTimeline>` | 100% | RFC-003 NodeEvent schema 统一 |

Phase 2 实施成本估 ~300-400 行（Phase 1 基础上 delta）。

## 11. Open Questions

1. **Approval policy default** — `on-failure` vs `untrusted` 哪个更安全 default? （`untrusted` 更保守但每命令 ask 干扰 anet 自动化；`on-failure` 平衡但 dangerous 命令首次成功就过去） — **建议 `on-failure`，需 Vincent 拍板**
2. **codex `--ignore-user-config` default 是否设？** — 设：avoid 用户 mcp_servers 污染 anet codex；不设：尊重用户已有配置 — **建议 profile.flags.codex.useUserConfig=true default（不 ignore），profile 内 opt-out**
3. **thread per session vs per task** — Phase 1 hardcode `session` 简化；Phase 2 加选项？— **建议 Phase 1 仅 session，Phase 2 加选项**
4. **escalate target alias 当 dangerous approval** — 走 commhub_send_task 到 `指挥室` 还是 telegram channel？ — **建议: profile.flags.codex.escalateAlias 配置，default `指挥室`**
5. **codex/event mapper 完整性** — 13 个 event type 都 map 还是仅 5 个 high-value（lifecycle + delta + complete）？— **建议 Phase 1 仅 high-value 5 个，Phase 2 全 map**
6. **Multi-language prompt encoding** — codex mcp-server tools/call prompt 是否支持中文 / emoji / multiline？— **probe 已验中文 emoji OK（prompt: "say hello in one word"）；multiline 待 cover smoke test**
7. **codex auth (OpenAI API key) 如何 inherit** — stdio child inherit env 默认拿 `OPENAI_API_KEY` from anet env？还是用户走 `codex login` 持久化？— **建议: 推荐用户先 `codex login`（OAuth 持久化），anet 不管 auth**
8. **agent-node 多 codex-code-cli runtime 同 host RAM** — 实测 codex mcp-server idle ~50MB / running ~150MB（待量化）— **建议 doc 标注每节点 100-200MB RAM 预算**
9. **`codex/event` notification handler @modelcontextprotocol/sdk API verify** — `setNotificationHandler` 对 catch-all（method 不在标准 MCP method list）支持的具体 API 形式 — **实施时确认 SDK 文档，必要时 patch SDK or workaround**
10. **Vincent codex mac mini version 验证** — 通信龙 telegram 4054 paste 显示含 `codex app` 但需 final confirm 含 `codex mcp-server` — **不阻塞，等 Vincent `codex --version` 反馈**

## 12. Timeline

**Day 1（today 2026-05-13）**:
- ✅ 通信龙 deep design doc 24b744e（B path 视角，作 reference）
- ✅ 通信SDK马 quick feasibility report（A/B/C 三路径对比）
- ✅ `codex mcp-server` real probe 验证 SYNC return + `codex/event` 流
- ✅ RFC-006（本文）push main
- ⏳ RFC-005 mark Superseded amend commit

**Day 2**:
- 通信工程马 unstash `~/anet-work/rfc-005-codex-code-cli/` worktree 6 edit（5/6 复用 + #6 launchAgent 改 spawn agent-node）
- 通信工程马 起 agent-node `codex-code-cli.ts` runtime adapter（~150-200 行）
- 通信测试马 PR #43 演进 L3 regex `mcp[_-]server` + 新 L5 tools/list verify + L7 live progress
- 通信SDK马 review cli.ts + agent-node code

**Day 3**:
- 联合 smoke test 跑通 commhub_send_task → codex → reply
- Vincent mac mini 亲测
- Ship preview `2.1.8-preview.N`
- Vincent 亲测通过 → 升 latest `2.1.8` stable 大 feature

## 13. 结论

✅ **anet 支持 codex CLI Phase 1 完全可行** — `codex mcp-server` stdio 0.130 已 ship 完整 daemon RPC + live event stream
✅ **架构方向定了** — Option 2 agent-node bridge + MCP stdio + `@modelcontextprotocol/sdk` 复用
✅ **工作量 manageable** — ~150-200 行 agent-node + ~30-50 行 cli.ts + ~300 行 test = 总 ~500 行，2-3 天 ship 2.1.8 大 feature
✅ **Live UX 优于 RFC-005 path A** — token-level streaming dashboard 渲染
✅ **协议稳定** — mcp-server 已 stable，不依赖 stabilize 中的 ws transport PRs
⚠ **10 个 Open Questions 待 Vincent / 通信龙 拍板** — §11
⚠ **Phase 2 升级路径明确** — §10 触发条件量化

后续动作:
- RFC-005 mark Superseded
- 通信工程马 unstash + 实施
- 通信测试马 PR #43 演进
- Vincent 回答 §11 Open Questions
- 联合 smoke test ship 2.1.8 stable

— END —
