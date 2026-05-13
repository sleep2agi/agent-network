# RFC-006：codex-cli-remote-control runtime — 通过 `codex remote-control` ws daemon 让 anet 用户直接用 Codex CLI 接 commhub

## Superseded by RFC-007

> **本 RFC 已被 [RFC-007](./RFC-007-codex-code-cli-mcp.md) 取代** (2026-05-13)
>
> 本 RFC 经历 6 轮 Vincent architectural pivot:
> - **Pivot 1-4** (initial → dual A+C → triple A+C+B → narrow C only): RFC-006 主体 Path C mcp-server stdio
> - **Pivot 5** (Vincent telegram 4108+4110): pivot 到 Path B ws remote-control daemon, 870 行 amend
> - **Pivot 6** (Vincent telegram 4136): **复位 Path C**, "行吧先 mcp 吧"
>
> 6 轮 pivot 收敛 rationale (evidence-driven, hands-on multi-client thread streaming experiment falsified Path B 卖点):
> - 通信SDK马 + 通信龙 双 deep plan 实测发现: 用户 `codex --remote ws://` TUI attach 仅看 lifecycle, **in-progress token streaming 仅 thread owner 收到** (broadcast 模型 + per-client opt-out, 真 per-thread subscriber 待 [issue #21551](https://github.com/openai/codex/issues/21551) stable)
> - 通信龙 `thread/resume <A's id>` race: `"no rollout found for thread id"` (thread persist 须 disk write 时间)
> - 实测直接 falsify Path B 卖点 "用户 TUI co-presence 看 anet 跑的 turn live token stream"
> - 结合 OpenAI 自标 "Under-development incomplete" + 协议本周 stabilize (3 PRs landing #22404 #22414 #22386) + 2x 代码量, Path B trade-off 不再值得
> - Vincent 4123 "如果不能 TUI 的话" → 4136 "行吧先 mcp 吧" final 决策
>
> **Phase 1 ship 改走 [RFC-007](./RFC-007-codex-code-cli-mcp.md) (Path C clean version, runtime `codex-cli-mcp`)**. 本 RFC-006 全文保留作 **Path B 设计 archive + 6 轮 pivot 决策史**, 方便未来 Phase 2 (if TR1-TR3 触发, per RFC-007 §10.1) 启动 RFC-008-like new RFC 时引用 Path B 实施 spec。
>
> 实施请参考 [RFC-007](./RFC-007-codex-code-cli-mcp.md)。

---

| 字段 | 内容 |
|---|---|
| 状态 | **Superseded by RFC-007**（原: Proposed, supersedes RFC-005 + own Path C version per Vincent 4108-4110 pivot, 现 Path B archive per Vincent 4136 final pivot） |
| 提出 | 2026-05-13 (Path C primary), amended 2026-05-13 (Path B primary per Vincent 4108-4110) |
| 作者 | 通信SDK马 |
| 派单 / 决策 | 通信龙（roadmap + architecture pivots + dual deep plan dispatch） |
| Helpers | 通信工程马（cli.ts implementer eval + Option 2 architecture choice） |
| 关联 issue | [#18](https://github.com/sleep2agi/agent-network/issues/18) SDK research loop |
| 关联 RFC | RFC-002 channel-bind-cli / RFC-003 node telemetry / **RFC-005 superseded** |
| 关联 doc | [`docs/anet-codex-remote-control-plan.md`](../anet-codex-remote-control-plan.md) Path B 深度调研 / [`docs/anet-codex-mcp-server-plan.md`](../anet-codex-mcp-server-plan.md) Path C 深度调研 (Phase 2 backup) / [commit 6429bc0](https://github.com/sleep2agi/agent-network/commit/6429bc0) codex CLI 直接通信研究 / [commit 24b744e](https://github.com/sleep2agi/agent-network/commit/24b744e) 通信龙 deep design |
| 目标版本 | agent-network v2.1.8（Phase 1 大 feature）+ agent-node v2.5 |
| 实施人 | 通信工程马（agent-node runtime adapter + cli.ts delegate） |

## 摘要

给 anet 加 1 个 codex CLI runtime — **`codex-cli-remote-control`** (ws daemon mode, push-driven via [codex remote-control](https://github.com/openai/codex/pull/21424) ws transport)，通过 spawn `codex --enable remote_control app-server --listen ws://127.0.0.1:<port>` daemon child + anet 作为 ws client 跑 JSON-RPC 2.0 协议的方式，让用户在 `anet node create --runtime codex-cli-remote-control` 后启动节点时**自动接入 commhub mesh**，同时支持**用户 TUI 通过 `codex --remote ws://...` 同时 attach** (multi-client peer co-presence)。

**Vincent telegram 4108+4110 拍板** (2026-05-13): Phase 1 走 Path B (ws daemon) 而非 Path C (mcp-server stdio), 接受:
- ✅ 用户 TUI attach 价值 > mcp-server SYNC 限制
- ✅ 完整 ServerNotification 63 events 流 (含 turn/steer mid-execution 控制)
- ✅ Multi-client peer co-presence (anet wrapper + 用户 TUI 并发 connect 同 daemon)
- ⚠ 接受 OpenAI "Under-development incomplete" warning (docs 标 experimental)
- ⚠ ~1000 行实施成本 (vs Path C ~500 行, 2x 代码量)
- ⚠ 本周协议仍 stabilize ([#22404](https://github.com/openai/codex/pull/22404) / [#22414](https://github.com/openai/codex/pull/22414) / [#22386](https://github.com/openai/codex/pull/22386) 全 2026-05-13 today landing) — Pin codex@>=0.130.0 with weekly release notes monitor

**Phase 1 ship**: `codex-cli-remote-control` 单 runtime (ETA 3-4 天, ~1000 行)。

**Phase 2 backup option** (`codex-code-cli-mcp`, Path C mcp-server stdio): 等 ws daemon 真正 stabilize OR 用户报 Path B `under-development` 警告太多 negative UX 时, 加 mcp-server stdio runtime 作 alternative (双 runtime, user 选)。详 §10。

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

**Gap**: claude 侧有 CLI 二进制路径（claude-code-cli），codex 侧只有 SDK，缺 codex CLI 二进制路径让 codex CLI 用户原地接入 anet **且支持用户 TUI 并发 attach**。

### 1.2 Architectural Pivot — Vincent 5 轮 decision timeline

RFC-006 经历了 5 次 architectural pivot:

| 时间 | Pivot | 描述 |
|---|---|---|
| 2026-05-13 morning | 初始 (Path C 单 runtime) | mcp-server stdio + tools/call codex/codex-reply, SYNC return + codex/event 流 |
| Vincent telegram 4067+4068 | 双 runtime (A TUI + C mcp daemon) | 增 Path A 用户 attached TUI mode 作 secondary entry |
| Vincent telegram 4073 | 三 runtime (A + C + B) | 增 Path B ws daemon 作 Phase 2 |
| Vincent telegram 4074+4075 | narrow 回 single (C only) | "A 意义不大" — drop TUI, ship C 单 runtime |
| **Vincent telegram 4108+4110** ← **NOW** | **pivot Phase 1 到 Path B** (ws daemon primary) | 用户 TUI attach 价值 > SYNC 限制, ship ws daemon, mcp-server stdio demoted Phase 2 backup |

**Vincent 4108+4110 rationale** (实测驱动):
- Vincent 4099 hands-on 实测 `codex --enable remote_control app-server --listen ws://127.0.0.1:14500` 跑通完整 ws daemon, 跟 multi-client tutorial
- 通信SDK马 deep plan doc [093d76a](https://github.com/sleep2agi/agent-network/commit/093d76a) 跟 通信龙 mcp-server plan [98b6728](https://github.com/sleep2agi/agent-network/commit/98b6728) 双 doc 验证: Path B 功能完整 + 用户 TUI attach OK
- 接受 trade-off: 实施 2x 代码量 + under-development experimental warning, 换取 user-facing experience completeness

### 1.3 三路径对比 (历史决策依据)

| Path | 描述 | 复杂度 | Push 能力 | 协议稳定性 | Phase 1 ship? |
|---|---|---|---|---|---|
| **A — TUI mode** | spawn `codex` TUI + 注入 MCP commhub | ~80 行 | ❌ pull-on-prompt | ✅ stable | ❌ non-goal (§10.2) |
| **B — `codex remote-control` ws daemon** ✅ | spawn `codex remote-control` headless daemon + anet 作 ws client | **~1000 行** | ✅ 完整 JSON-RPC 2.0 push + multi-client peer + turn/steer | ⚠ 本周仍 stabilize | **✅ Phase 1 primary** |
| **C — `codex mcp-server` stdio** | spawn `codex mcp-server` stdio child + anet 作 MCP client | ~500 行 | ✅ SYNC return + codex/event 流 | ✅ stable | 🟡 Phase 2 backup (§10.3) |

### 1.4 codex remote-control ws daemon 实测 evidence (Path B)

详细实测内容已在 [`docs/anet-codex-remote-control-plan.md`](../anet-codex-remote-control-plan.md) (commit 093d76a, 544 行) 覆盖。本 RFC §3-§4 主要 design 基于该 doc。Key facts:

- `codex --enable remote_control app-server --listen ws://127.0.0.1:<port>` 起 ws server (实测 :18765 / :18766 / :18778 都 OK)
- WebSocket handshake: `HTTP/1.1 101 Switching Protocols` ✅ (with bearer) / `HTTP/1.1 401 Unauthorized` (without)
- JSON-RPC 2.0 流: initialize → thread/start → turn/start → 25 events stream (含 `item/agentMessage/delta {"delta":"Hi"}` token-level) → turn/completed
- Multi-client peer co-presence: 2 ws clients 并发 connect 同 daemon, lifecycle events 跨 client broadcast ✅, per-thread streaming 须 owner-subscriber 关系 (thread/resume 须 thread persist to disk)
- Daemon emit **`warning: "Under-development features enabled: remote_control. Under-development features are incomplete and may behave unpredictably."`** + `remoteControl/status/changed: errored` — OpenAI 自己标 incomplete

## 2. 设计目标

| 目标 | 描述 |
|---|---|
| **G1 — 对称 anet runtime** | codex CLI 用户跟 claude-code-cli 用户体验对称 (functional + behavioral parity, 含用户 TUI attach 能力) |
| **G2 — Push-driven daemon** | commhub `send_task` 到达 → codex 自动响应 (不依赖用户手动在 TUI 输入), agent-node 作 ws client `turn/start { input }` 直接 push prompt |
| **G3 — User TUI attach co-presence** | 用户用 `codex --remote ws://127.0.0.1:<port> --remote-auth-token-env COMMHUB_TOKEN` attach 同 daemon, 看 anet 自动跑的 turn live (lifecycle events broadcast) |
| **G4 — Live agent UX** | Dashboard / SaaS client 看到 codex agent live token stream (`item/agentMessage/delta`) 不是派单后静默 |
| **G5 — turn/steer mid-execution** | 用户可中途 `turn/interrupt` 停止 / `turn/steer` 调整方向 (mcp-server stdio 不能) |
| **G6 — 安全默认** | bearer auth (capability-token / signed-JWT), 限 loopback ws:// 或 wss://, approval-policy 默认 conservative, dangerous 操作 fallback escalate |
| **G7 — Phase 2 backup option** | 若 ws daemon `under-development` warning 长期不去除 OR 用户报 UX 不好, Phase 2 加 mcp-server stdio runtime 作 alternative |

## 3. 设计

### 3.1 Architecture (Option 2: agent-node 内 runtime bridge)

```
[commhub-server]
       |
       | SSE (new_task event for codex-bot)
       v
[agent-node (codex-cli-remote-control runtime adapter)]
       |
       | spawn child: codex --enable remote_control app-server --listen ws://127.0.0.1:<port> 
       |              --ws-auth capability-token --ws-token-sha256 <hex>
       |              (+ free port allocation + token gen)
       v
[codex app-server child process (codex 0.130+)]
       |
       | ws://127.0.0.1:<port>
       | (HTTP upgrade with Bearer auth)
       v
[agent-node ws client (npm `ws` 8.x)]
       |
   1. Init: initialize handshake (capabilities + clientInfo)
   2. Thread: thread/start { cwd, sandbox, approvalPolicy } → threadId
   3. Push prompt: turn/start { threadId, input: [{ type:"text", text:<task> }] }
   4. Stream during turn: item/agentMessage/delta {"delta":"..."} ← token-level
   5. Reverse approval: server→client ServerRequest (e.g. execCommandApproval) → anet reply
   6. End: turn/completed (duration_ms, time_to_first_token_ms)
       |
       v
[agent-node bridge]
   - codex `ServerNotification` 流 → commhub `report_progress` (RFC-003 telemetry)
   - Final content (last_agent_message) → commhub_send_task reply
       |
       v
[commhub-server]

【并发】 用户可执行 codex --remote ws://127.0.0.1:<port> --remote-auth-token-env COMMHUB_TOKEN
        作 second ws client, 看 anet 跑的 turn live (lifecycle broadcast)
```

**关键架构选择 — Option 2** (per 通信工程马 e50eda1a + 9c43ba4e 共识):
- cli.ts: thin launcher (~50 行 dispatch + setup wizard 增 entry)
- agent-node: 重活 (ws client + bearer auth + reconnect + 9 reverse approval + supervision + bridge)

### 3.2 cli.ts 改动 (~50 行)

```ts
// L133 RuntimeName enum
type RuntimeName =
  | "claude-code-cli"
  | "codex-sdk"
  | "codex-cli-remote-control"   // ← NEW (Path B ws daemon)
  | "claude-agent-sdk"
  | "http-api";

// normalizeRuntime
function normalizeRuntime(r: string): RuntimeName {
  switch (r) {
    case "codex-remote":
    case "codex-cli-remote":
    case "codex-cli-remote-control":
      return "codex-cli-remote-control";
    // ... existing branches
  }
}

// checkRuntimeDependency
if (profile.runtime === "codex-cli-remote-control") {
  if (!commandExists("codex")) {
    warn("Install codex CLI: npm i -g @openai/codex@latest");
    return false;
  }
  // verify codex --version >= 0.130.0
  const v = execFileSync("codex", ["--version"], {encoding: "utf-8"}).trim();
  // semver check + warn if < 0.131 (under-development)
}

// launchAgent dispatch
case "codex-cli-remote-control":
  return spawnAgentNode(profile, { runtime: "codex-cli-remote-control" });
```

### 3.3 agent-node 改动 (~470 行)

新增 `agent-node/src/runtime/codex-cli-remote-control.ts`:

```ts
import { spawn, ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import WebSocket from "ws";

export class CodexCliRemoteControlRuntime {
  private daemon: ChildProcess;
  private ws: WebSocket;
  private threadId?: string;
  private token: string;
  private port: number;

  async start(profile: Profile) {
    // 1. Allocate free port (127.0.0.1:PORT range, e.g. 18000-18999)
    this.port = await allocateFreePort();

    // 2. Generate random capability token + sha256
    this.token = crypto.randomBytes(32).toString("hex"); // 64 hex chars
    const tokenSha256 = crypto.createHash("sha256").update(this.token).digest("hex");

    // 3. Spawn codex daemon child
    this.daemon = spawn("codex", [
      "--enable", "remote_control",
      "app-server",
      "--listen", `ws://127.0.0.1:${this.port}`,
      "--ws-auth", "capability-token",
      "--ws-token-sha256", tokenSha256,
    ], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    // 4. Wait for daemon ready (poll /healthz)
    await waitForPort(this.port, 5000);

    // 5. Connect ws client with Bearer token
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });

    await new Promise((resolve, reject) => {
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });

    // 6. JSON-RPC 2.0 handshake
    await this.rpc("initialize", { clientInfo: { name: "anet-codex-cli-remote-control", version: AGENT_NODE_VERSION } });

    // 7. Listen for ServerNotifications + ServerRequest (reverse approval)
    this.ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.method && !msg.id) {
        // ServerNotification — forward to commhub
        this.handleServerNotification(msg);
      } else if (msg.method && msg.id) {
        // ServerRequest reverse-call — anet must reply
        this.handleServerRequest(msg);
      } else if (msg.id) {
        // Response to our ClientRequest
        this.handleResponse(msg);
      }
    });

    // 8. Start persistent thread for this anet session
    const r = await this.rpc("thread/start", {
      cwd: profile.cwd,
      sandbox: profile.flags?.codex?.sandbox ?? "workspace-write",
      approvalPolicy: profile.flags?.codex?.approvalPolicy ?? "on-failure",
    });
    this.threadId = r.thread.id;

    // 9. Supervise daemon (reconnect on disconnect, restart on crash)
    this.daemon.on("exit", () => { /* respawn logic */ });
    this.ws.on("close", () => { /* reconnect logic + thread/resume */ });
  }

  // commhub SSE handler — new task arrives
  async onNewTask(task: TaskEvent) {
    await this.rpc("turn/start", {
      threadId: this.threadId,
      input: [{ type: "text", text: task.task }],
    });
    // turn/completed notification will trigger final reply via handleServerNotification
  }

  // Handle ServerNotification (broadcast events)
  private handleServerNotification(msg: any) {
    // Filter own thread events only (multi-client broadcast nuance)
    if (msg.params?.threadId && msg.params.threadId !== this.threadId) return;

    if (msg.method === "item/agentMessage/delta") {
      this.bufferAndFlushDelta(msg.params.delta);
    } else if (msg.method === "turn/completed") {
      this.flushReplyToCommhub(msg.params.lastAgentMessage);
    } else if (msg.method === "warning") {
      // Filter under-development warning, log others
    }
    // Forward to commhub report_progress (RFC-003 telemetry)
    forwardToCommhubProgress(msg);
  }

  // Handle ServerRequest reverse-call — 9 reverse approval types
  private async handleServerRequest(msg: any) {
    const policy = profile.flags?.codex?.approvalPolicy ?? "on-failure";
    let response;
    switch (msg.method) {
      case "execCommandApproval":
        response = this.smartApproveCommand(msg.params, policy);
        break;
      case "applyPatchApproval":
        response = this.smartApprovePatch(msg.params, policy);
        break;
      case "item/permissions/requestApproval":
        response = await this.escalateToCommander(msg.params); // commhub_send_task to 指挥室
        break;
      case "item/tool/call":
        response = await this.passthroughToCommhub(msg.params); // commhub MCP tool 转发
        break;
      // ... 5 more cases
    }
    this.reply(msg.id, response);
  }

  async shutdown() {
    this.ws.close();
    this.daemon.kill();
  }
}
```

复用 `codex-sdk` runtime 现有 supervision 框架 (spawn / supervise / respawn / shutdown), 替换 transport (npm SDK → ws JSON-RPC 2.0)。

### 3.4 完整 sequence diagram (Path B daemon mode)

```
[commhub-server] -- SSE new_task --> [agent-node codex-cli-remote-control]
                                              |
                                              | spawn child: codex --enable remote_control
                                              |              app-server --listen ws://127.0.0.1:<port>
                                              |              --ws-auth capability-token
                                              |              --ws-token-sha256 <hex>
                                              v
                                  [codex daemon child + auto-update loop]
                                              |
                                              | ws://127.0.0.1:<port>
                                              v
                                  [agent-node ws client]
                                              |
                                              | initialize → ack
                                              | thread/start → threadId
                                              | turn/start { threadId, input: [{type:"text",text:<task>}] }
                                              v
                                  [codex inference]
                                  - item/agentMessage/delta {"delta":"Hello"}  ← token stream
                                  - execCommandApproval (reverse) → anet smart policy reply
                                  - turn/completed { duration_ms, time_to_first_token_ms }
                                              |
                                              v
                              [agent-node bridge]
                              - ServerNotification 流 → commhub `report_progress` (RFC-003)
                              - last_agent_message 聚合 → commhub_send_task reply
                                              |
                                              v
                                        [commhub]

【并发】 另一终端用户: codex --remote ws://127.0.0.1:<port> --remote-auth-token-env COMMHUB_TOKEN
       (TUI second client, 看 anet 跑的 turn lifecycle events broadcast)
```

## 4. Tool Call Flow / Protocol Details

### 4.1 完整 ClientRequest 序列 (Phase 1 anet 使用)

| Method | When | Params |
|---|---|---|
| `initialize` | 1x per ws session | `clientInfo: {name, version}` |
| `thread/start` | 1x per agent-node session | `cwd, sandbox, approvalPolicy, model?, ephemeral?` |
| `thread/resume` | on ws reconnect | `threadId` (resume disk-persisted thread) |
| `turn/start` | per commhub task | `threadId, input: UserInput[]` |
| `turn/interrupt` | 用户中断 / anet 超时 | `threadId, turnId` |
| `turn/steer` | 用户调整方向 (Phase 1 optional, Phase 2 主要) | `threadId, turnId, input` |

### 4.2 ServerNotification 流 (anet bridge → commhub report_progress)

per [/tmp/codex-schema/ServerNotification.json](实测 dump) 63 events, anet bridge 关注 mapping:

| codex ServerNotification | RFC-003 NodeEvent.kind |
|---|---|
| `turn/started` | `ProgressKind.TURN_STARTED` |
| `item/started` (AgentMessage) | `ProgressKind.AGENT_MESSAGE_STARTED` |
| `item/agentMessage/delta` | `ProgressKind.AGENT_MESSAGE_DELTA` (token, high-frequency, batch 200ms/1KB) |
| `item/started` (CommandExecution) | `ProgressKind.TOOL_CALL_STARTED` |
| `item/completed` (CommandExecution) | `ProgressKind.TOOL_CALL_COMPLETED` |
| `item/started` (FileChange) | `ProgressKind.FILE_CHANGE_STARTED` |
| `item/completed` (FileChange) | `ProgressKind.FILE_CHANGE_COMPLETED` |
| `thread/tokenUsage/updated` | `ProgressKind.USAGE_UPDATE` |
| `account/rateLimits/updated` | `ProgressKind.RATE_LIMIT_UPDATE` |
| `turn/completed` | `ProgressKind.TURN_COMPLETED` (duration_ms, time_to_first_token_ms) |
| `warning` (under-development) | log only, **不 forward** (suppress per profile.flags) |
| `remoteControl/status/changed` | `ProgressKind.LIFECYCLE` (status: disabled/connecting/connected/errored) |
| `mcpServer/startupStatus/updated` | `ProgressKind.SUBSYSTEM` |
| `raw_response_item` | low-priority debug, **不 forward** (noise) |

### 4.3 ServerRequest 9 个 reverse approval (anet 须 reply)

| ServerRequest | anet smart policy |
|---|---|
| `execCommandApproval` | whitelist (ls/cat/grep/git status/git log) auto-approve / 其他 escalate `指挥室` |
| `applyPatchApproval` | same cwd 内 + 文件数 ≤5 + lines ≤200 auto-approve / 其他 escalate |
| `applyPatchApproval/grantRoot` | 永不 auto-approve, escalate `指挥室` |
| `item/permissions/requestApproval` | escalate `指挥室` |
| `item/tool/call` (codex 调 MCP tool) | passthrough commhub MCP tool 转发 |
| `item/tool/requestUserInput` | escalate `指挥室` via commhub_send_task |
| `mcpServer/elicitation/request` | escalate 或 auto-fill from profile.flags |
| `account/chatgptAuthTokens/refresh` | passthrough |
| `execCommandApproval` parsedCmd (metadata) | base whitelist 判断 |

→ ~80 行决策框架 in agent-node。

### 4.4 用户 TUI attach flow (G3 multi-client)

per Vincent 4099 tutorial:

```bash
# Step 1: anet 已起 daemon (per §3.3 step 3)
# daemon listen ws://127.0.0.1:<port> + token in COMMHUB_TOKEN env var

# Step 2: 用户另一终端 attach
export COMMHUB_TOKEN=<从 anet 节点 config 取或 anet 命令显示>
codex --remote ws://127.0.0.1:<port> --remote-auth-token-env COMMHUB_TOKEN

# 用户进 codex TUI, 看 lifecycle events 实时 (per multi-client broadcast)
# 用户也可在 TUI 内 prompt → 创建新 thread (跟 anet 自动跑的 thread 独立)
```

**实测 caveat** (per Path B deep plan §3):
- ✅ lifecycle events (thread/status/changed, mcpServer/startup/updated) 跨 client broadcast
- ⚠ per-thread streaming (item/agentMessage/delta) 仅 thread owner 收到, 用户 attach 时**不能** "看 anet 跑的 turn 的 token stream"
- 解决: anet thread `ephemeral: false` 持久化到 disk + 用户 `thread/resume {anet's threadId}` (但需 thread persist 后才能 resume, 实测 race condition)

## 5. Live Progress Forwarding (RFC-003 telemetry 复用)

### 5.1 ServerNotification → commhub `report_progress` mapping

agent-node bridge 内置 mapper:

```ts
function codexNotificationToNodeEvent(msg: any): NodeEvent | null {
  switch (msg.method) {
    case "item/agentMessage/delta":
      return {
        kind: ProgressKind.AGENT_MESSAGE_DELTA,
        delta_text: msg.params.delta,
        item_id: msg.params.itemId,
        thread_id: msg.params.threadId,
        turn_id: msg.params.turnId,
        timestamp: Date.now(),
      };
    case "turn/completed":
      return {
        kind: ProgressKind.TURN_COMPLETED,
        duration_ms: msg.params.durationMs,
        time_to_first_token_ms: msg.params.timeToFirstTokenMs,
        last_agent_message: msg.params.lastAgentMessage,
        timestamp: Date.now(),
      };
    case "raw_response_item":
      return null; // skip noise
    case "warning":
      if (msg.params.message?.includes("Under-development")) return null;
      // log only
    // ... 其他 mapping
  }
}
```

### 5.2 Batch / Backpressure 策略

`item/agentMessage/delta` 实测 token-per-event (~100ms 间隔), flooding `report_progress`。Phase 1 简单 batch:

- delta events buffer 200ms 或满 1KB 即 flush
- 其他 lifecycle events 立即 forward
- commhub `report_progress` payload size cap 4KB

### 5.3 跟 RFC-003 telemetry layer 复用

RFC-003 已 ship `commhub_report_progress` MCP method + `progress_events` SQLite 表 + SSE `progress` 事件 + dashboard `<ProgressTimeline>`。**RFC-006 直接复用, 无 commhub schema 改动**。

## 6. Configuration

### 6.1 bearer token format

**推荐 `capability-token` mode** (PR #14853, anet 易实施):

```bash
# Server side (anet spawn)
codex --enable remote_control app-server --listen ws://127.0.0.1:<port> \
      --ws-auth capability-token \
      --ws-token-sha256 <SHA256_HEX_OF_TOKEN>

# Client side (anet ws client OR user TUI)
new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
```

Phase 2 evaluate `signed-bearer-token` (JWT with issuer/audience/clock-skew) 若 anet ntok_ 升级到 JWT 体系。

### 6.2 ws listen URL

- 默认 `ws://127.0.0.1:<port>` (loopback only) — per PR #14853 安全 restriction
- 远程部署: SSH port-forwarding 或 nginx reverse proxy (不推荐直接 0.0.0.0)
- 端口分配: agent-node 启动时 `allocateFreePort()` 动态选 (18000-18999 range), 写入 node config

### 6.3 approval-policy default `on-failure`

| 值 | 描述 | anet 适用 |
|---|---|---|
| `untrusted` | 所有 shell 需 approval | 高安全场景 |
| `on-failure` | 仅失败后 ask | **推荐 default** (balance 自动化 + 安全) |
| `on-request` | model 判断 ask | 中等信任 |
| `never` | 全自动批准 | dev 内网 only (不推荐生产) |

### 6.4 sandbox default `workspace-write`

| 值 | 权限 |
|---|---|
| `read-only` | 仅读 + 禁网 |
| `workspace-write` | 读 + 写 cwd + 禁网 (**推荐 default**) |
| `danger-full-access` | 全访问 (不推荐) |

### 6.5 profile.flags.codex 配置 schema

```json
{
  "runtime": "codex-cli-remote-control",
  "model": "gpt-5.2-codex",
  "flags": {
    "codex": {
      "approvalPolicy": "on-failure",
      "sandbox": "workspace-write",
      "wsListenPort": null,    // null = auto-allocate
      "wsAuthMode": "capability-token",
      "supervisorRestart": true,  // crash → respawn
      "useUserConfig": true       // 加载 ~/.codex/config.toml mcp_servers
    }
  }
}
```

### 6.6 tmux 长跑配置 (per Vincent 4099 tutorial)

```bash
# Step 1: anet node start in tmux (long-running)
tmux new -s codex-bot
anet node start my-codex-bot   # auto-spawn daemon + ws client + bridge
# Ctrl+B D detach

# Step 2: 用户 attach TUI from anywhere
codex --remote ws://127.0.0.1:<port> --remote-auth-token-env COMMHUB_TOKEN
```

### 6.7 远程部署 SSH port-forward

```bash
# 远程机器跑 anet node
ssh user@remote-host
tmux new -s codex-bot
anet node start my-codex-bot

# 本地 attach
ssh -L 18765:127.0.0.1:18765 user@remote-host
codex --remote ws://127.0.0.1:18765 --remote-auth-token-env COMMHUB_TOKEN
```

## 7. Setup / cli.ts integration

### 7.1 Setup wizard 添加 runtime 选项

```
? Select runtime:
  ❯ claude-code-cli (Claude CLI binary)
    claude-agent-sdk (Anthropic SDK)
    codex-sdk (OpenAI Codex SDK)
    codex-cli-remote-control (Codex CLI via remote-control ws daemon) ⚠ EXPERIMENTAL ← NEW
    http-api (OpenAI-compatible HTTP)
```

**Experimental warning prominent** (per Vincent 4108-4110 accept under-development risk):

```
⚠ codex-cli-remote-control uses codex 0.130 "remote_control" feature which is currently
  marked as "Under-development incomplete" by OpenAI. Behavior may be unstable until codex
  0.131+ ships with stable WS transport.

  Continue? (Y/n)
```

### 7.2 cli.ts → agent-node delegate

```ts
case "codex-cli-remote-control":
  return spawnAgentNode(profile, { runtime: "codex-cli-remote-control" });
```

## 8. Testing

### 8.1 Docker E2E test L0-L9 (~400 行, PR #43 演进)

| Level | Check |
|---|---|
| L0 | `which codex && which anet` |
| L1 | `anet hub start` + `curl /health` |
| L2 | `anet node create test-codex-bot --runtime codex-cli-remote-control` |
| L3 | child spawn verify: `pgrep -f "codex.*app-server.*--listen"` |
| L4 | ws handshake: 验 `HTTP/1.1 101 Switching Protocols` |
| L5 | bearer auth: 错 token → 401, 对 token → 101 |
| L6 | JSON-RPC handshake: initialize / thread/start / threadId 验 |
| L7 | push verify: `commhub_send_task --alias test-codex-bot --task "hello"` → turn/start → ServerNotification 流 → reply |
| L8 | live progress: 验 `item/agentMessage/delta` forward 到 commhub `progress_events` 表 |
| L9 | multi-client peer: 起 2nd ws client → 验 lifecycle broadcast |
| L10 | reverse approval: turn 内 codex `execCommandApproval` → anet smart policy reply |
| L11 | reconnect: kill ws → 验自动 reconnect + thread/resume |

### 8.2 Smoke test 流程

per Vincent 4108-4110 acceptance:

1. Vincent mac mini 跑 `anet node create vincent-codex --runtime codex-cli-remote-control`
2. 启动 `anet node start vincent-codex` (auto-spawn daemon)
3. 用户另一终端 `codex --remote ws://127.0.0.1:<port> --remote-auth-token-env COMMHUB_TOKEN` attach TUI
4. 从指挥室 `commhub_send_task --alias vincent-codex --task "what is 2+2"`
5. 验:
   - codex live token stream 在 dashboard `<ProgressTimeline>` 显示
   - 用户 TUI 看到 lifecycle events broadcast
   - `4` 回到 commhub
6. 用户在 TUI 内 prompt "say hi" → 创建独立 thread (不干扰 anet)
7. 验 multi-thread isolation OK

## 9. Risks & Mitigation (rewrite for ws daemon)

| Risk | Severity | Mitigation |
|---|---|---|
| 🔴 OpenAI 标 `remote_control` "Under-development incomplete" | high | Phase 1 setup wizard 显式 experimental warning + cases doc 标 / 监控 codex release notes 等 `under-development` 标签移除 (Phase 2 升级) |
| 🔴 2026-05-13 三个 PRs 仍在 stabilize ws transport (#22404 #22414 #22386) | high | Pin codex@>=0.130.0 minimum + weekly release notes monitor + auto-skip update window |
| 🟡 multi-client peer co-presence partial work (per-thread streaming 须 owner-subscriber 关系, `thread/resume` race condition) | medium | doc 显式 caveat: 用户 TUI attach 仅看 lifecycle, per-token stream 须自己创独立 thread / Phase 2 等 [issue #21551](https://github.com/openai/codex/issues/21551) RFC stable 后真 peer streaming |
| 🟡 bearer auth complexity (token gen + sha256 + env injection + 不写 process args) | medium | crypto.randomBytes(32) + sha256 hex inline + ENV 名 in profile flags + process args 仅 sha256 (token 本身不暴露) |
| 🟡 ws reconnect + supervision (daemon crash + ws disconnect + thread/resume timing) | medium | npm `ws` 库 reconnect 指数退避 (1s→30s, 10 retries) + `thread/resume {threadId}` 自动续 (但 thread 须 disk persist + race window ~100-500ms) |
| 🟡 Port allocation race (多 anet node 同 host) | low | port range allocation (18000-18999) + retry on EADDRINUSE + 持久化分配在 .anet/nodes/<alias>/config.json |
| 🟡 Token 泄漏 (env / log / process listing) | medium | token in env COMMHUB_TOKEN, sha256 in CLI args (不可逆), 不写 daemon log |
| 🟡 daemon crash → anet 无法连接 | medium | Supervisor restart (类比 codex-sdk runtime pattern) + thread/resume on reconnect |
| 🟡 1000 行实施成本 + 新 ws dep | low | `ws` ^8 + `@types/ws` 已成熟 npm, manageable |
| 🟡 auto-update loop (codex 自身 update 时 daemon restart) | medium | Reconnect 策略 + thread/resume 接回原 thread |
| 🟡 multi-anet-node 同 host 事件广播 cross-thread 泄漏 | medium | per-anet-session 独立 daemon (port + token 隔离) + client-side filter 仅订阅自己 thread events |

## 10. Future Work — Phase 2 + Non-goal

### 10.1 Phase 2 触发条件 (转 mcp-server stdio 加 backup runtime, OR 弃用 ws 都重 mcp-server stdio)

| 触发条件 | 衡量指标 |
|---|---|
| **TR1**: codex 0.131/0.132 ship 后 `remote_control` 移出 "under-development" | OpenAI changelog 显式 "stable" 标识 |
| **TR2**: codex multi-client RFC [#21551](https://github.com/openai/codex/issues/21551) 真正 merged (per-thread streaming subscriber model) | issue closed with PR merged |
| **TR3**: 用户报 Phase 1 ws daemon UX 不好 (experimental warning 太频 / 协议 churn 触发频繁 break) | Vincent / 用户 feedback ≥3 起 |

### 10.2 Phase 2 升级路径 (Path C mcp-server stdio 作 backup runtime)

满足 TR1+TR3 时启动 Phase 2:
- 加 `codex-code-cli-mcp` runtime (Path C, mcp-server stdio) — 跟 `codex-cli-remote-control` 双 runtime 并存
- 用户根据 use case 选:
  - `codex-cli-remote-control` — 想 user TUI attach / mid-turn steer / 复杂控制
  - `codex-code-cli-mcp` — 想简单 SYNC return / 不需要 user attach / 最低资源占用
- Path C 实施 spec 见 [`docs/anet-codex-mcp-server-plan.md`](../anet-codex-mcp-server-plan.md) (通信龙 commit 98b6728, 已 ship doc 作 backup blueprint)

### 10.3 Optional: anet codex-setup user-mode 命令 (per 通信龙 mcp-server plan §8 🥉)

非 runtime 路径, 帮用户配 `~/.codex/config.toml` 让用户 TUI 直接接 commhub MCP (user-mode 跟 daemon-mode 互补):

```bash
anet codex-setup --alias my-codex-user-tui
# 输出: 写 ~/.codex/config.toml [mcp_servers.commhub-anet] section + env var instructions
# 用户接下来直接跑 `codex` (TUI), codex 自动 connect commhub mesh
```

Phase 1 是否实施 待 Vincent 拍板 (raise as Open Q11)。

### 10.4 Non-goal: `codex-code-cli` TUI mode (Path A)

Phase 1 不 ship, Phase 2 也不 ship. 用户直接跑 `codex` (默认 TUI) + 手配 `~/.codex/config.toml` mcp_servers 即可 (user-mode), anet 不重复包装。

## 11. Open Questions (12 个, 等 Vincent 拍板)

1. **Runtime naming** — `codex-cli-remote-control` (RFC-006 选, 4-token 含 `-remote-control` suffix) vs 短形 `codex-remote` / `codex-cli-remote`?
2. **bearer token format default** — `capability-token` (推荐, 实测最简) vs `signed-bearer-token` JWT (anet ntok_ 升 JWT 后)?
3. **ws listen default port** — auto-allocate (18000-18999 range) vs fixed 4500 (per Vincent 4099 tutorial) vs dynamic?
4. **Multi-anet-node 同 host port 分配** — 独立 daemon per node (推荐, 隔离好) vs 共享 daemon (复用, 但 cross-thread 事件泄漏)?
5. **codex daemon crash supervisor** — auto-restart with exponential backoff (推荐) vs 标 node error / 通知用户 manual restart?
6. **9 reverse approval flow policy default** — auto-approve safe whitelist (ls/cat/grep/git status/git log) (推荐) + escalate dangerous to 指挥室 vs 全 escalate (用户介入太多)?
7. **ChatGPT account model 限制** — default model 选 ChatGPT 支持的 (gpt-5? o4-mini?) 须实测 / 或 API key only mode default?
8. **Multi-client peer co-presence experimental warning** — Phase 1 setup wizard 弹 prompt 警告 (推荐) vs 仅 doc 标 / runtime metadata 标 experimental flag?
9. **`thread/resume` race condition (multi-client subscriber)** — anet thread 默认 `ephemeral: false` 持久化 (推荐, 允许用户 resume) vs `ephemeral: true` 私有 (避免用户误改 anet 状态)?
10. **`under-development` warning suppression** — 默认 `suppress_under_development_features_warning = true` in profile.flags (推荐, 减 log noise) vs 默认 false (保 visibility)?
11. **Optional anet codex-setup 命令** — Phase 1 包含 (帮用户 user-mode 也接 mesh) vs 推迟 Phase 2 (避免 scope creep)?
12. **跟 Phase 2 mcp-server stdio 共存 strategy** — Phase 2 双 runtime 并存, runtime 选择由用户决定 (推荐) vs 自动选 based on codex --version (复杂)?

## 12. Timeline

**Day 1 (today 2026-05-13)**:
- ✅ 通信龙 deep design doc 24b744e
- ✅ Path A/B/C 三路径研究 (RFC-006 §1.3)
- ✅ Path B 深度调研 doc [`docs/anet-codex-remote-control-plan.md`](../anet-codex-remote-control-plan.md) (通信SDK马 093d76a)
- ✅ Path C 深度调研 doc [`docs/anet-codex-mcp-server-plan.md`](../anet-codex-mcp-server-plan.md) (通信龙 98b6728)
- ✅ RFC-006 主体 ship (Path C primary) + amend narrow single runtime
- ✅ Vincent 4108+4110 pivot Phase 1 → Path B (ws daemon)
- ⏳ RFC-006 amend (本 commit, Path B primary, Path C demoted Phase 2 backup)

**Day 2-3** (Vincent GO 后):
- 通信工程马 unstash worktree (`~/anet-work/rfc-005-codex-code-cli/`) + 重写 #6 launchAgent 改 spawn `codex --enable remote_control app-server --listen ws://...` + 起 agent-node `codex-cli-remote-control.ts` runtime adapter (~470 行)
- 通信测试马 PR #43 演进: L3 regex `codex.*app-server.*--listen` + 新 L4-L11 (ws handshake / bearer / push / live progress / multi-client / approval / reconnect)
- 通信SDK马 review cli.ts + agent-node code

**Day 4**:
- 联合 smoke test (per §8.2): 跑 commhub_send_task + 用户 TUI attach + live token stream
- Vincent mac mini 亲测
- Ship preview `2.1.8-preview.N` (含 codex-cli-remote-control runtime, experimental flag)
- Vincent 亲测通过 → 升 latest `2.1.8` stable 大 feature

## 13. 结论

✅ **Vincent 4108+4110 pivot accepted** — Phase 1 走 ws daemon (Path B), 接受 under-development risk + 2x 代码量, 换取 user TUI attach + multi-client peer + turn/steer mid-execution 价值
✅ **架构方向定了** — Option 2 agent-node bridge + ws JSON-RPC 2.0 + npm `ws` ^8 + bearer auth (capability-token)
✅ **工作量** — agent-node +470 行 (ws + bearer + reconnect + 9 reverse approval + supervision) + cli.ts +50 行 + Docker E2E +400 行 + npm dep `ws`+`@types/ws` = ~1000 行总, **3-4 天 ship**
✅ **协议 evidence** — Path B 深度调研 doc 093d76a 完整 hands-on 验证 (ws handshake / bearer auth / multi-client / 25-event 完整 sequence / token-level streaming)
⚠ **Risk accepted** — Vincent 决定接受 OpenAI "Under-development incomplete" + 本周协议 stabilize 中 + 用户 TUI attach race condition
⚠ **12 Open Questions** 待 Vincent 拍板 (§11)
🟡 **Phase 2 backup option** — mcp-server stdio (`codex-code-cli-mcp` Path C) 等 TR1+TR3 触发条件后加成 alternative runtime (§10.2)

后续动作:
- ✅ RFC-005 mark Superseded ([commit 63b28e3](https://github.com/sleep2agi/agent-network/commit/63b28e3))
- ⏳ 通信工程马 unstash worktree + 重写 launchAgent → ws spawn
- ⏳ 通信测试马 PR #43 演进 L0-L11
- ⏳ Vincent 回答 §11 12 个 Open Questions
- ⏳ 联合 smoke test → ship 2.1.8 preview → Vincent mac mini 亲测 → ship 2.1.8 latest stable 大 feature

— END —
