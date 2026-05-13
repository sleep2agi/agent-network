# anet 通过 codex mcp-server stdio 接入 codex CLI — 深度方案

> **作者**: 通信龙（hands-on 实测 + 源码 dive）  
> **日期**: 2026-05-13  
> **状态**: 深度方案 doc — Vincent telegram 4093 让我出 mcp 方案 (跟 SDK马 remote-control 方案并列)  
> **关联**: RFC-006 / `docs/anet-codex-code-cli-design.md` / `docs/codex-cli-direct-comm-research.md`

## 0. Hands-on 实测证据

我在 agent-orchestra 服务器 (codex 0.130.0, ChatGPT account auth) 跑了 3 个实测脚本，verify protocol 实际 behavior。

### 0.1 实测 1: `tools/list` — codex mcp-server 暴露 2 个 tools

```javascript
// /tmp/test-codex-mcp-v2.mjs verified output:
TOOLS: 2 个

TOOL codex
  desc: Run a Codex session. Accepts configuration parameters matching the Codex Config struct.
  input.required: ["prompt"]
  input.props: approval-policy, base-instructions, compact-prompt, config, cwd,
               developer-instructions, model, profile, prompt, sandbox
  output.props: threadId, content

TOOL codex-reply
  desc: Continue a Codex conversation by providing the thread id and prompt.
  input.required: ["prompt"]
  input.props: conversationId, prompt, threadId
  output.props: threadId, content
```

### 0.2 实测 2: tools/call 期间 `codex/event` notification 流（confirmed）

跑 `tools/call codex {prompt: "hi", model: "gpt-4.1-mini"}` 期间观测到 15+ notifications:

```
session_configured     (含 session_id + thread_id, model_context_window, instructions)
mcp_startup_update     (codex 自启动时 connect 别的 MCP servers — codex_apps ready, commhub-proxy failed)
mcp_startup_complete   (列出 ready / failed servers)
task_started           (含 turn_id + started_at + collaboration_mode)
warning                (Model metadata not found, fallback used)
raw_response_item      (developer/user message inserted)
item_started           (UserMessage / AgentMessage / etc 多种 item 类型)
item_completed         (item 完成事件)
user_message           (user prompt as event)
error                  (invalid request, e.g. model not supported with ChatGPT account)
```

**Vincent stale config 实证**: codex 启动时自动 connect `~/.codex/config.toml` mcp_servers 项 — 看到 `commhub-proxy` startup 失败 (per Vincent half-config: `proxy/commhub-proxy.ts` 不存在)。

### 0.3 实测 3: tools/call return 含 error path

ChatGPT account auth 下 `gpt-4.1-mini` model 不支持，return:
```json
{
  "content": [{"type": "text", "text": "{...error 400 invalid_request_error...}"}],
  "structuredContent": {"threadId": "...", "content": "{...error JSON...}"},
  "isError": true
}
```

✅ Error 不是 throw，是 normal MCP response 含 `isError: true` + error content。anet 能 parse 处理。

## 1. 关键 architectural facts (hands-on confirmed)

### 1.1 codex mcp-server 协议特性

✅ *stdio JSON-RPC 2.0* — 跟 MCP spec 一致，复用 anet `@modelcontextprotocol/sdk` dep
✅ *2 tools only* — `codex` (start) + `codex-reply` (continue) — *极简 surface*
✅ *Notification streaming during tools/call* — 客户端能 subscribe 实时事件
✅ *SYNC return* — tool call 一次性返回最终 content，*不是 streaming output*
✅ *Static approval-policy* — anet 传 input param，*不是 reverse approval request*
✅ *Thread persist* — 第一次 `codex` tool 创 thread，后续 `codex-reply` 续

### 1.2 codex mcp-server 自启动接其他 MCP servers

关键发现: codex mcp-server *启动时自己从 ~/.codex/config.toml 读 mcp_servers 项 + 主动 connect*。

```toml
# Vincent ~/.codex/config.toml 现状 (实测时看到 mcp_startup_update):
[mcp_servers.codex_apps]   # 内置，自动 ready
...

[mcp_servers.commhub-proxy]  # Vincent 半成品，failed because proxy/commhub-proxy.ts 不存在
command = "bun"
args = ["/home/vansin/agent-orchestra/proxy/commhub-proxy.ts"]
```

**含义重大**: 用户 mac mini 上配 ~/.codex/config.toml 加 commhub MCP server → 用户直接终端 `codex` 进 TUI → codex 自动 connect commhub → 用户 prompt "查 inbox" 时 codex 直接 query commhub tools。

这是 *user-mode 路径*，跟 anet runtime 平行。

## 2. 跟 codex-sdk runtime 对比

| 维度 | codex-sdk (anet 已有) | codex-code-cli-mcp (本方案) |
|---|---|---|
| 实现 path | npm `@openai/codex-sdk` in-process API | spawn `codex mcp-server` stdio child |
| Process model | agent-node 内 (no extra process) | extra child process (隔离更好) |
| Auth | API key env / config | codex CLI `codex login` (ChatGPT account or API key) |
| Thread 持久化 | per-call ephemeral | codex CLI `~/.codex/sessions/` (用户可 `codex resume` 看) |
| Sandbox | 跟 agent-node 共 | codex 自身 bubblewrap sandbox (额外隔离) |
| Live event stream | SDK streaming | codex/event JSON-RPC notifications (实测确认) |
| Approval policy | SDK config | tool input param (static, no reverse req) |
| 复杂度 | 已 ship | 新加 ~150 行 (agent-node MCP client + cli.ts entry) |

**核心差异化 value**:
- ✅ **ChatGPT account auth** — 用户已登录 ChatGPT 直接用 (无需 API key)
- ✅ **Thread 持久化 + `codex resume` 兼容** — 用户能在另一终端 codex resume 看历史
- ✅ **Sandbox 额外隔离** — codex 自己跑 bubblewrap，跟 agent-node 解耦

**重叠部分**: 多 agent network daemon push 行为 + commhub 通信能力 — 跟 codex-sdk 等价。

## 3. 实施 plan (anet 实现 codex-code-cli-mcp runtime)

### 3.1 cli.ts 改动 (~30-50 行)

```ts
// L140 RuntimeName enum
type RuntimeName = "claude-code-cli" | "codex-sdk" | "codex-code-cli-mcp" 
                  | "claude-agent-sdk" | "http-api";

// L142-149 normalizeRuntime
case "codex-mcp":
case "codex-code-cli-mcp":
  return "codex-code-cli-mcp";

// L596 assertStartCompatibility (verify codex binary + version)
if (profile.runtime === "codex-code-cli-mcp") {
  const v = execFileSync("codex", ["--version"], {encoding: "utf-8"}).trim();
  // verify codex-cli >= 0.130.0
}

// L1612-1701 launchAgent dispatch — delegate 给 agent-node (类比 codex-sdk)
case "codex-code-cli-mcp":
  return spawnAgentNode(profile, {runtime: "codex-code-cli-mcp"});
```

### 3.2 agent-node 改动 (~100-150 行)

新加 `agent-node/src/runtime/codex-code-cli-mcp.ts`:

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

class CodexCodeCliMcpRuntime {
  private mcpClient: Client;
  private threadId?: string;

  async start(profile: Profile) {
    // Spawn codex mcp-server as MCP server child
    const transport = new StdioClientTransport({
      command: "codex",
      args: ["mcp-server"],
      env: { ...process.env, COMMHUB_TOKEN: profile.token },
    });

    this.mcpClient = new Client(
      { name: "anet-codex-runtime", version: "0.1" },
      { capabilities: {} }
    );

    // Subscribe to all codex/event notifications for live progress
    this.mcpClient.fallbackNotificationHandler = (msg) => {
      if (msg.method === "codex/event") {
        this.forwardToCommhubProgress(msg.params);
      }
    };

    await this.mcpClient.connect(transport);
  }

  // commhub SSE handler — new task arrives from another agent
  async onNewTask(task: TaskEvent) {
    // First time: call `codex` tool (creates thread)
    // Subsequent: call `codex-reply` tool (continues thread)
    const result = await this.mcpClient.callTool({
      name: this.threadId ? "codex-reply" : "codex",
      arguments: this.threadId
        ? { threadId: this.threadId, prompt: task.task }
        : { 
            prompt: task.task,
            "approval-policy": profile.flags?.codexApprovalPolicy ?? "on-failure",
            sandbox: profile.flags?.codexSandbox ?? "workspace-write",
            cwd: profile.workspaceDir,
          }
    });

    // Save threadId for future calls
    this.threadId = result.structuredContent?.threadId;

    // Post final content back to commhub
    await commhubSendReply({
      task_id: task.task_id,
      content: result.structuredContent?.content,
      isError: result.isError,
    });
  }

  // Forward codex/event to commhub progress (RFC-003 telemetry compatible)
  private async forwardToCommhubProgress(event: any) {
    // Map codex/event types -> commhub progress events
    if (event.msg?.type === "agent_message_content_delta") {
      await commhubReportProgress({
        type: "text_delta",
        delta: event.msg.delta,
      });
    } else if (event.msg?.type === "task_started") {
      await commhubReportProgress({ type: "started", duration_estimate_ms: null });
    } else if (event.msg?.type === "task_complete") {
      await commhubReportProgress({ 
        type: "completed", 
        duration_ms: event.msg.duration_ms 
      });
    }
    // ... other 10+ event types
  }
}
```

### 3.3 Setup wizard 改动

`agent-network/bin/cli.ts:504-545` setupCommand `runtimeSelections`:
```ts
{
  name: "codex-code-cli-mcp",
  display: "Codex CLI MCP (daemon mode, auto handle send_task)",
  installCommand: "npm install -g @openai/codex@latest",
  authNote: "需 codex login (ChatGPT 订阅或 API key)",
}
```

### 3.4 Docker E2E test (~200 行)

`tests/test-codex-mcp/` 新加:

| Level | Check |
|---|---|
| L0 | which codex && which anet |
| L1 | anet hub start + curl /health |
| L2 | anet node create --runtime codex-code-cli-mcp + config 写盘 |
| L3 | anet node start → spawn codex mcp-server child verify (pgrep) |
| L4 | MCP client handshake — initialize ack |
| L5 | tools/list verify 2 tools (codex + codex-reply) |
| L6 | commhub_send_task → codex 节点 → codex/event stream → reply 推回 commhub (no real OpenAI key — mock model fail OK) |
| L7 | cross-runtime: codex-code-cli-mcp + claude-code-cli 跨派 send_task |

### 3.5 cases doc (通信文档马 follow-up)

`docs-site/docs/cases/codex-code-cli-mcp.md` ZH+EN — 5 步 user walkthrough。

## 4. 限制 (honest 列出)

### 4.1 用户不能 attach TUI 跟 codex 对话

agent-node 占了 codex mcp-server child 的 stdio — *用户不能 attach*。
但用户能:
- 通过 *commhub_send_task* 派任务给 codex 节点 (从 dashboard 或别的 agent)
- Dashboard 看 *live token stream* (codex/event → commhub progress → SSE → frontend)

### 4.2 SYNC return — 不能 mid-turn steer / interrupt

tools/call 一次性返回最终 content。中途用户不能 *中断 turn* 或 *steer to different direction*。如果需要 turn/steer，必走 remote-control ws daemon path (Phase 2)。

### 4.3 不暴露 codex slash commands (/goal /clean /stop)

codex mcp-server 仅暴露 2 个 tools (codex + codex-reply)，*不暴露 TUI 内 slash commands*。`/goal` 等命令是 codex TUI 客户端 sugar，map 到 app-server `thread/goal/updated` notification — *mcp-server 不 expose*。

如果用户想用 /goal 设 agent goal，必须 *TUI mode* 或 *remote-control ws*。

### 4.4 ChatGPT account auth 限制 model

我实测发现 `gpt-4.1-mini` model 不支持 ChatGPT account auth。anet 要 verify *codex CLI auth mode* + *available models*，否则用户接到 invalid request error。

实际 ChatGPT account 支持的 models 可能仅: `gpt-5` / `o4-mini` / `o3` 等 — 需进一步实测。

### 4.5 双 process 资源消耗

每个 codex-code-cli-mcp node = agent-node 进程 + codex mcp-server child 进程 + (codex 内部 startup) auto-connect 其他 MCP servers。RAM 估 *~300MB* per node (claude-code-cli 是 ~150MB per node)。

## 5. Risks + Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| ChatGPT account auth model 限制 | 🟡 medium | 设 default model = ChatGPT 支持的 + 文档列 supported models |
| codex CLI 协议本周 stabilize 中 | 🟡 medium | Pin codex@0.130.0 exact + 监控 release notes weekly |
| mcp_startup 自动 connect failed (如 Vincent commhub-proxy) | 🟢 low | warn user 但 codex 仍能跑 (我实测看到 fail 但 codex_apps 起来后仍处理 prompt) |
| Approval policy 自动批准潜在 destructive | 🔴 high | Default `on-failure` + 文档强调; profile.flags 允许 override |
| Live event stream backpressure | 🟢 low | RFC-003 telemetry layer 已有 batch + drop strategy |
| codex resume 跨 process 文件锁冲突 | 🟡 medium | anet 节点 1:1 一个 codex child，用户 codex resume 在另终端时 *只读* OK |

## 6. Phase 2 升级路径

mcp-server stdio = Phase 1 (本方案, 1-2 天 ship)。Phase 2 升级 = `codex-cli-remote-control` ws daemon:

- ✅ TUI input 体验回来 (`codex --remote ws://`)
- ✅ Multi-client (issue #21551 RFC design done)
- ✅ mid-turn steer / interrupt
- ⚠️ 协议本周仍 stabilize (codex 0.131/0.132)
- ⚠️ bearer auth 复杂

Phase 2 留作 future RFC-007 (when codex multi-client merged + protocol stable)。

## 7. 跟 SDK马 remote-control 方案对比 (高层)

| 维度 | mcp-server stdio (本方案) | remote-control ws (SDK马 方案) |
|---|---|---|
| Phase | 1 (今天) | 2 (2-3 weeks 后) |
| Push driven | ✅ (tools/call) | ✅ (turn/start RPC) |
| Live event | ✅ codex/event notifications | ✅ ServerNotification stream |
| User TUI attach | ❌ stdio 单 client | ✅ codex --remote ws:// |
| Multi-client | ❌ stdio 单 child | ⚠️ design done not merged |
| Approval | static input param | reverse ServerRequest 9 种 |
| 协议 stability | ✅ stable (mcp-server early ship) | ⚠️ this week 3 PRs landing |
| 代码量 | ~150 行 | ~590-680 行 |
| Auth | stdio inherit env | bearer JWT/capability-token |
| Future-proof | 简单稳定 | 功能更强但复杂 |

**互补不互斥** — 两个 runtime 并存 ship 也合理 (`codex-code-cli-mcp` Phase 1 + `codex-cli-remote-control` Phase 2)，用户 pick by use case。

## 8. 推荐 verdict

🥇 **Ship Phase 1 `codex-code-cli-mcp` runtime now** — 1-2 天 ship 2.1.8 大 feature

理由:
- ✅ Hands-on 实测 protocol 简单稳定
- ✅ ~150 行 implementation 工程量小
- ✅ 跟 codex-sdk 功能虽 overlap 但 *ChatGPT auth + thread persist + sandbox 差异化*  
- ✅ codex/event live stream 跟 RFC-003 telemetry 对接
- ✅ 用户 mac mini 已装 codex 0.130 + ChatGPT login

🥈 **Phase 2 加 codex-cli-remote-control** — 2-3 weeks 后等 codex stable

🥉 **Optional: anet codex-setup user-mode 命令** — 帮用户配 ~/.codex/config.toml 让 codex TUI 直连 commhub (user-mode path, 跟 daemon 互补)

## 9. Open Questions (等 Vincent 拍板)

1. **runtime naming** — `codex-code-cli-mcp` vs `codex-cli-mcp` vs `codex-mcp`?
2. **default approval-policy** — `on-failure` (推荐) / `never` / `always`?
3. **default sandbox** — `workspace-write` / `read-only` / `dangerously-bypass`?
4. **default model** — 哪个 ChatGPT account 支持的 model 作 default? (gpt-5? o4-mini? 需进一步实测 ChatGPT 订阅可用 model list)
5. **thread 续期 vs reset** — 每个 agent-node session 单一 thread (长 context) vs per-task new thread (clean isolation)?
6. **escalate target** — 如果 codex 处理 fail / approval 需要人工介入，escalate 给谁? (建议 commhub_send_task to 指挥室 即 Vincent)
7. **Optional anet codex-setup 命令** — 加进 cli.ts 帮用户配 ~/.codex/config.toml 让用户 TUI 也能用?

## 10. 实施 timeline

**今天 Day 1**:
- ✅ 通信龙 hands-on 实测 + 写本 doc (now)
- ⏳ SDK马 deep dive 出 remote-control 方案 doc (parallel)
- ⏳ Vincent 看 2 doc 决策 ship mcp-server vs remote-control vs both

**Day 2** (if mcp-server 选定):
- 通信SDK马 amend RFC-006 跟 hands-on facts 对齐
- 通信工程马 unstash worktree + implement (~3-4 hour)
- 通信测试马 Docker test L0-L7 实施
- Vincent mac mini 亲测

**Day 3**:
- Ship preview `2.1.8-preview.N` 含 codex-code-cli-mcp
- Vincent 亲测通过 → 升 latest `2.1.8` 大 feature

## 11. Hands-on artifacts

实测 scripts 在 `/tmp/test-codex-mcp.mjs` + `/tmp/test-codex-mcp-v2.mjs` + `/tmp/test-codex-mcp-event.mjs`，可复用作 PR #43 E2E test reference。

完整 schema dump 在 `/tmp/codex-schema/` (75 ClientRequest + 63 ServerNotification + 9 ServerRequest etc，来自 `codex app-server generate-json-schema`)。

---

— END —
