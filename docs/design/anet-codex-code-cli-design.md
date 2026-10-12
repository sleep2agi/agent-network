# anet 支持 codex CLI 的完整方案（深度设计）

> **作者**: 通信龙（hands-on 跑 codex CLI 0.130 + 整合通信SDK马 + 通信工程马 quick estimates）  
> **日期**: 2026-05-13  
> **状态**: 草案 — 决策依据 doc，不是 RFC（RFC-006 由通信SDK马起完整 RFC）  
> **触发**: Vincent telegram 4019 "2.1.8 大 feature = codex-cli 成功支持" + 4040+4048 PR #21424 pointer + 4060+4061 "出方案 + 研究深刻一点"  
> **关联**: RFC-005 (TUI mode, superseded) / RFC-002 Phase 2 (SDK runtimes Telegram bind)

## TL;DR

🎯 **架构选定**: agent-node 内 spawn `codex app-server --listen stdio` 作 child process，通过 JSON-RPC stdio 跟 codex daemon 双向通信。**Push-driven 真 daemon**，跟 claude-code-cli 行为对称。

📊 **工作量**: agent-node +150-200 行 bridge / cli.ts +30-50 行 (delegate) / Docker E2E +300 行 / 总约 500-600 行。**2-3 天 ship 2.1.8 大 feature**。

⚠️ **关键 timing**: codex 0.130 已 ship JSON-RPC app-server protocol（stable，跟 PR #21424 unrelated 不必等）。protocol 已 dump 75 ClientRequest + 63 ServerNotification + 9 ServerRequest method enum 实测。

✅ **架构对称性**: 用户对 anet network 视角看，`codex-code-cli` runtime 等价 `claude-code-cli` runtime — 都能接收 send_task 自动响应。

## 1. 现状 + Gap

### 1.1 anet 现有 4 个 runtime

`agent-network/bin/cli.ts:140`:

```ts
type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk" | "http-api";
```

| Runtime | 协议 | daemon? | claude/codex |
|---|---|---|---|
| `claude-code-cli` | spawn `claude` 二进制 + channel plugin daemon layer | ✅ yes | claude |
| `claude-agent-sdk` | npm SDK `@anthropic-ai/claude-agent-sdk` (programmatic) | ✅ yes | claude |
| `codex-sdk` | npm SDK `@openai/codex-sdk` | ✅ yes | codex |
| `http-api` | OpenAI-compatible HTTP fetch | ✅ yes | both |

**对称性 gap**: claude 侧有 CLI 二进制 path (claude-code-cli) + SDK path (claude-agent-sdk) 双轨；codex 侧仅有 SDK，**缺 codex CLI 二进制 path**。

### 1.2 用户实证需求

Vincent `~/.codex/config.toml` 含半成品配置：

```toml
[mcp_servers.commhub-proxy]
command = "bun"
args = ["/home/vansin/agent-orchestra/proxy/commhub-proxy.ts"]
```

但 `commhub-proxy.ts` 不存在。用户**真实尝试过**这条路径，但**没产品化**。

### 1.3 codex CLI 0.130 protocol stable

```bash
$ codex --version
codex-cli 0.130.0
```

跑 `codex app-server generate-json-schema --out /tmp/codex-schema` dump 实测 39 schema files，含 `ClientRequest.json` / `ServerNotification.json` / `ServerRequest.json` / `JSONRPCMessage.json` etc.

**关键 API**:

- 75 ClientRequest methods (anet → codex daemon 单向 send)
- 63 ServerNotification methods (codex daemon → anet streaming push)
- 9 ServerRequest methods (codex daemon → anet 反向 ask, anet 必须 reply)
- 1 ClientNotification method

## 2. 完整 Protocol Flow

### 2.1 Push 入口 — `turn/start`

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "turn/start",
  "params": {
    "threadId": "<uuid>",
    "input": [{"type": "text", "text": "<task content from commhub_send_task>"}]
  }
}
```

anet wrapper 接到 commhub `new_task` event → 立即 send 这个 RPC → codex daemon 处理 turn

### 2.2 codex daemon Streaming output (ServerNotification)

```
codex daemon → anet wrapper stream notifications:
  - turn/started       (turn 开始)
  - item/started       (item 处理开始)
  - item/agentMessage/delta  (流式输出，chunks)
  - item/completed     (item 完成)
  - turn/completed     (turn 结束 — anet 看到这个 = 全部完成)
```

anet wrapper 聚合 `item/agentMessage/delta` → 拿 final output → 通过 commhub MCP tools (codex 内部 call) 自动回复

### 2.3 反向 ask — ServerRequest 9 个 approval/elicitation 流程

codex daemon 处理过程中 push reverse request 给 anet wrapper:

| ServerRequest | 用途 | anet wrapper 应对 |
|---|---|---|
| `applyPatchApproval` | 改文件前 ask | Smart policy: auto-approve safe / escalate dangerous |
| `execCommandApproval` | 执行 shell 命令前 ask | Smart policy: white-list read-only / escalate destructive |
| `item/permissions/requestApproval` | 通用 permission | escalate |
| `item/tool/call` | call MCP tool | anet wrapper 转给 commhub tool call |
| `item/tool/requestUserInput` | 需要用户输入 | escalate 指挥室 via commhub_send_task |
| `mcpServer/elicitation/request` | MCP server 询问 | escalate 或 auto-fill from config |
| `applyPatchApproval/grantRoot` | 文件 root permission | 慎重 escalate |
| `account/chatgptAuthTokens/refresh` | OpenAI auth refresh | passthrough |
| `execCommandApproval` parsedCmd | 命令解析 metadata | base auto-approve 判断 |

### 2.4 完整 sequence diagram

```
[commhub-server]
       |
       | SSE (new_task event for codex-bot)
       v
[agent-node (codex-code-cli runtime)]
       |
       | JSON-RPC stdio
       v
[codex app-server child process]
       |
   1. Init: {method: "initialize"} → ack
   2. Thread: {method: "thread/start", params: {...}} → threadId
   3. Push prompt: {method: "turn/start", params: {threadId, input: [task]}}
   4. codex inference (LLM call, may use commhub MCP tools)
   5. (codex 想 call shell)
       <-- {method: "execCommandApproval", params: {command, cwd, ...}} ServerRequest
       --> {result: {approved: true}} ServerResponse  (anet 决策)
   6. Stream: notifications/item/agentMessage/delta (output chunks)
   7. Done: notifications/turn/completed
       |
       v
[agent-node bridge]
   - Aggregate final output
   - POST commhub reply (via commhub_send_task or commhub_reply MCP tool)
       |
       v
[commhub]
```

## 3. Implementation Plan

### 3.1 cli.ts 改动 (~30-50 行)

```ts
// L140 RuntimeName enum
type RuntimeName = "claude-code-cli" | "codex-sdk" | "codex-code-cli" | "claude-agent-sdk" | "http-api";

// L142-149 normalizeRuntime
function normalizeRuntime(r: string): RuntimeName {
  switch (r) {
    case "codex-cli":
    case "codex-code-cli":
      return "codex-code-cli";
    // ... existing branches
  }
}

// L596 assertStartCompatibility
if (profile.runtime === "codex-code-cli") {
  const v = execFileSync("codex", ["--version"], {encoding: "utf-8"}).trim();
  // verify codex >= 0.130.0
}

// L634 checkRuntimeDependency
if (profile.runtime === "codex-code-cli") {
  if (!commandExists("codex")) {
    warn("Install codex CLI: npm i -g @openai/codex@latest");
  }
}

// L1612-1701 launchAgent — delegate 给 agent-node (类比 codex-sdk runtime path)
case "codex-code-cli":
  return spawnAgentNode(profile, {runtime: "codex-code-cli"});
```

### 3.2 agent-node 改动 (~150-200 行)

新加 `agent-node/src/runtime/codex-code-cli.ts`:

```ts
// Spawn codex app-server child + JSON-RPC bridge
class CodexCodeCliRuntime {
  private child: ChildProcess;
  private threadId?: string;
  private pendingRequests = new Map<RequestId, Resolver>();

  async start(profile: Profile) {
    this.child = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "inherit"],
      env: {...process.env, COMMHUB_TOKEN: profile.token, ...}
    });
    
    // Stream JSON-RPC notifications/responses from child.stdout
    this.startNotificationLoop();
    
    // Initialize handshake
    await this.rpc("initialize", {protocolVersion: "2024-11-05", ...});
    
    // Start persistent thread for this agent-node session
    const r = await this.rpc("thread/start", {/* threadId or auto-gen */});
    this.threadId = r.threadId;
  }

  // commhub SSE handler — new task arrives
  async onNewTask(task: TaskEvent) {
    // Push prompt to codex
    await this.rpc("turn/start", {
      threadId: this.threadId,
      input: [{type: "text", text: task.task}]
    });
    // Notifications stream in via startNotificationLoop
  }

  // Handle codex push notifications + reverse requests
  private startNotificationLoop() {
    this.child.stdout.on("data", (chunk) => {
      for (const msg of parseJsonRpcStream(chunk)) {
        if (msg.method === "turn/completed") {
          this.flushTaskReply();  // aggregated output → commhub
        } else if (msg.method === "execCommandApproval") {
          this.handleApproval(msg);  // smart policy
        } else if (msg.method === "item/agentMessage/delta") {
          this.appendOutput(msg.params);  // streaming chunks aggregate
        }
        // ... other 60+ notification types
      }
    });
  }

  // Smart approval policy
  private handleApproval(req: ServerRequest) {
    if (req.method === "execCommandApproval") {
      const cmd = req.params.parsedCmd[0]?.cmd;
      const safe = ["ls", "cat", "grep", "git status", "git log"].includes(cmd);
      if (safe) return this.reply(req.id, {approved: true});
      // Escalate dangerous to 指挥室 via commhub_send_task
      this.escalate(req).then(approval => this.reply(req.id, approval));
    }
    // ... 9 server request types
  }
}
```

### 3.3 Approval Policy 决策矩阵

| ServerRequest | 安全级别 | 默认策略 | 配置 override |
|---|---|---|---|
| `execCommandApproval` 白名单 (ls/cat/grep/git status/git log) | safe | auto-approve | `profile.flags.codex.autoApproveCmd: ["..."]` |
| `execCommandApproval` 其他 | dangerous | escalate 指挥室 | `profile.flags.codex.autoApproveAll: true` (危, dev only) |
| `applyPatchApproval` 限同 cwd 内 | medium | auto-approve | escalate threshold by 文件数/lines |
| `applyPatchApproval` 涉及 grantRoot | dangerous | escalate | 永不 auto-approve |
| `item/permissions/requestApproval` | dangerous | escalate | — |
| `mcpServer/elicitation/request` | depends | escalate 或 auto-fill commhub fields | — |
| `item/tool/call` (codex 调 MCP tool) | safe | passthrough (anet 不拦) | — |
| `item/tool/requestUserInput` | medium | escalate 指挥室 | — |

### 3.4 Docker E2E test L0-L7 (~300 行)

通信测试马 PR #43 scaffold 复用 + L3/L6 改 + 新增 L7:

| Level | Check | 命令 |
|---|---|---|
| L0 | prerequisites | `which codex && which anet` |
| L1 | hub up | `anet hub start` + `curl /health` |
| L2 | node create | `anet node create test-bot --runtime codex-code-cli` + config 写盘 |
| L3 | child spawn verify | `pgrep -f "codex app-server"` (代替 codex no-subcommand) |
| L4 | env injection | `/proc/<pid>/environ` 验 `COMMHUB_TOKEN` |
| L5 | JSON-RPC handshake | netcat / fifo 读 child stdin/stdout 验 initialize ack |
| L6 | push verify | `anet commhub_send_task --alias test-bot --task "hello"` → 验 codex 收到 `turn/start` → 流式 output → reply 回 commhub |
| L7 | cross-runtime | 起 codex-code-cli + claude-code-cli 两 node → A `send_task` B → 都能接收 daemon push |

### 3.5 cases doc (通信文档马 follow-up PR)

`docs-site/docs/cases/codex-code-cli-bot.md` ZH+EN — 5 步 user walkthrough:

1. 装 codex CLI: `npm i -g @openai/codex@latest`
2. 升 anet: `npm i -g @sleep2agi/agent-network@latest`
3. 创节点: `anet node create my-codex --runtime codex-code-cli`
4. 启动: `anet node start my-codex`
5. 跟其他 agent 通信: `anet commhub_send_task --alias my-codex --task "task content"`

## 4. 风险评估 + Mitigation

| Risk | Severity | Mitigation |
|---|---|---|
| codex 0.130 protocol stabilize 本周 (PR #22404 #22414 #22386 仍在改) | 🔴 high | Pin `codex@0.130.0` exact + 监控 release notes + integration test runs daily on `latest` |
| Single-client daemon limit (issue #21551 just merged design RFC) | 🟡 medium | anet wrapper 一节点对应一 codex daemon 1:1，用户不能并发 attach |
| Approval flow 决策 false positive (auto-approve 错的命令) | 🔴 high | Conservative whitelist (read-only only by default) + sandbox flags + escalate 指挥室 fallback |
| Token bridge (codex daemon credential vs anet ntok_) | 🟡 medium | Phase 1: 不让 codex daemon 自己 auth (用本地 stdio 不需 token)，Phase 2: 如要 ws transport 再加 JWT |
| codex daemon crash / supervision | 🟡 medium | agent-node supervisor watcher: crash 自动 respawn (类比 claude-agent-sdk pattern) |
| 多 agent-node 同机器 stdio port 冲突 | 🟢 low | stdio 不用 port，per-child 隔离 OK |
| API protocol breaking change in 0.131+ | 🟡 medium | Schema codegen + version check, fail-fast if mismatch |

## 5. Timeline (2-3 天 ship 2.1.8 大 feature)

**Day 1** (today):
- ✅ 通信龙 hands-on 调研完成 (本 doc)
- ⏳ 通信SDK马 起 RFC-006 design doc (90-120 min)
- ⏳ 通信工程马 dive `codex-sdk` runtime 现有 agent-node spawn pattern (60 min)

**Day 2**:
- 通信工程马 实施 agent-node `codex-code-cli.ts` runtime adapter (~200 行) — focus JSON-RPC bridge + push handler + approval smart policy
- 通信工程马 cli.ts 加 RuntimeName + setup wizard entry (~50 行)
- 通信SDK马 review code + spawn 协议 sanity check
- 通信测试马 起 PR #43 update + 新加 L6 push verify + L7 cross-runtime

**Day 3**:
- 联合 smoke test 跑通 1 个 commhub_send_task → codex 响应 → reply
- Vincent mac mini 亲测
- Ship preview `2.1.8-preview.N` (含 codex-code-cli runtime)
- Vincent 亲测通过 → 升 latest `2.1.8` stable **大 feature**

## 6. RFC-005 → RFC-006 Migration

- **RFC-005** mark `Superseded by RFC-006` (TUI mode + pull-on-prompt 是 wrong abstraction)
- **RFC-006** codex-code-cli runtime via app-server daemon mode — 完整 push-driven，跟 claude-code-cli 行为对称
- 通信工程马 `~/anet-work/rfc-005-codex-code-cli/` 6 edit worktree git stash 保留 backup (5/6 edit 可复用，仅 launchAgent spawn 段重写)
- 通信SDK马 起 RFC-006 时引用本设计 doc + 之前 6429bc0 codex CLI 研究 doc + PR #21424 + protocol schema dump

## 7. Open Questions (待 Vincent 拍板)

1. **Approval policy whitelist** — 默认 auto-approve 哪些 shell 命令? (我建议 read-only: ls / cat / grep / git status / git log)
2. **escalate target** — 当 codex 询问 dangerous approval 时，escalate 哪个 alias? (建议 `指挥室` = Vincent，但用户的个人 codex node escalate 给"用户自己"，可能 escalate via telegram channel)
3. **Sandbox flags default** — `--ignore-user-config` + `--sandbox` mode? (建议 sandbox = "workspace-write" 限制 in cwd)
4. **Thread lifecycle** — per agent-node session 一个 thread (长 context) 还是 per task new thread (clean isolation)? (建议 per session，跟 claude-code-cli 一致)
5. **Multi-agent codex daemon** — 单机器多 codex-code-cli node 是否限制? (建议 limit by RAM, document 1 daemon ~200MB)

## 8. 结论

✅ **anet 支持 codex CLI 完全可行** — codex 0.130 已 ship 完整 daemon RPC protocol
✅ **架构方向定了** — agent-node + codex app-server stdio bridge
✅ **工作量 manageable** — ~500-600 行总量，2-3 天 ship
⚠️ **timing 注意** — Pin codex@0.130 + 监控 protocol stabilize 本周变化
⚠️ **Approval policy 需 Vincent 拍板** — 7 个 open questions 决定后实施

后续动作:
- 通信SDK马 起 RFC-006 design (90-120 min)
- 通信工程马 dive codex-sdk runtime 现有 pattern (60 min)
- Vincent 答 7 个 open questions
- 实施开干

— END —
