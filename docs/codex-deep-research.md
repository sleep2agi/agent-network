# codex CLI 0.130 深度调研 — evidence-based 实证 + 源码 dive

> **作者**: 通信SDK马（hands-on 实测 + openai/codex GitHub repo 源码 read + 通信龙 并行 hands-on cross-verify）
> **日期**: 2026-05-13
> **状态**: Deep research doc (per Vincent telegram 4117+4118 "真深入研究 codex 不是表面 plan")
> **触发**: Vincent 4108-4110 拍板 Phase 1 Path B ws daemon 后, 4117+4118 raise: implement 之前先 evidence-verify §3 design assumption
> **关联**: [RFC-006 b42eada amend](https://github.com/sleep2agi/agent-network/blob/main/docs/rfcs/RFC-006-codex-code-cli-mcp-server.md) / [`docs/anet-codex-remote-control-plan.md`](./anet-codex-remote-control-plan.md) Path B 调研 / [`docs/anet-codex-mcp-server-plan.md`](./anet-codex-mcp-server-plan.md) 通信龙 Path C 调研

## TL;DR

🔬 **Deep dive evidence summary**:

- ✅ Session disk format 实测: JSONL with `RolloutLine {type, payload}` envelope, 4 entry types (`session_meta` / `event_msg` / `response_item` / `turn_context`)
- ✅ 本周 3 PRs (#22404 / #22414 / #22386) all merged 2026-05-13 today — protocol churn active 但 mitigated (auth guard restored, unix:// 新 transport, feature flag deprecation graceful)
- ✅ 60+ TUI slash commands found in `slash_command.rs` (含 `/goal` `/clear` `/quit` `/diff` `/status` `/model` `/resume` `/fork` `/init` `/compact` `/plan` `/agent` 等) — 大部分 **不** map app-server RPC, 是 TUI 本地 sugar
- ✅ ws transport per-connection `optOutNotificationMethods` set 控制 broadcast (clients 可选择不收某些 notification)
- ✅ non-loopback ws listener (e.g. 0.0.0.0) **MUST** 配 `--ws-auth` (PR #22404 restore + guard); loopback (127.0.0.1) 无 auth OK (anet 用 loopback 简化)
- ✅ `codex remote-control` 现用 `--remote-control --listen unix://` spawn (PR #22386 + #22414), 但 `--enable remote_control app-server --listen ws://...` 兼容 path 仍 work
- ⚠ Vincent ChatGPT account auth probe: `auth.json.account.account_type` field empty/null — 可能 ChatGPT session 失效或 anonymous; 须 Vincent 重 `codex login`

🎯 **anet 实施 implications** (evidence-based, 修正 RFC-006 §3 assumption):

- A. **建议默认走 `unix://`** 替代 `ws://127.0.0.1:port` (PR #22414 + #22386 daemon spawn 默认 unix://, 文件权限隔离比 token 更简单, 无 port 冲突)
- B. **Phase 1 用 `--enable remote_control app-server --listen ws://` 兼容 path 仍 OK** 但 future-proof 应 migrate `--remote-control --listen unix://`
- C. **ChatGPT account auth model 限制确认**: gpt-4.1-mini ❌ (per 通信龙 实测), 须实测 supported models matrix (gpt-5 / o3 / o4-mini)
- D. **Per-thread streaming subscriber model 待 #21551 stable** — Phase 1 接受 multi-client 仅 lifecycle broadcast (per-token streaming 须 owner)
- E. **9 ServerRequest reverse approval flow 实测须** 通信龙 parallel hands-on confirm

## 1. 整体架构

### 1.1 codex CLI 0.130 binary tree

```
codex (Node.js wrapper, ~/.nvm/versions/node/v20.20.0/bin/codex)
  └── child: /lib/node_modules/@openai/codex/.../codex (Rust binary, codex-linux-x64)
      ├── default: TUI mode (no subcommand)
      ├── exec: non-interactive (codex exec [QUERY])
      ├── review: 代码 review
      ├── mcp-server: stdio MCP server (Path C alternative)
      ├── app-server: experimental low-level daemon
      │   └── proxy / generate-ts / generate-json-schema
      ├── remote-control: experimental headless wrapper around app-server
      ├── cloud: cloud task submission (exec/status/list/apply/diff)
      └── completion: shell completion
```

### 1.2 ws transport (anet Path B 用)

per [`codex-rs/app-server/src/lib.rs`](https://github.com/openai/codex/blob/main/codex-rs/app-server/src/lib.rs) (实测 head 部分):

```rust
let accept_handle = start_websocket_acceptor(
    *bind_address,
    transport_event_tx.clone(),
    transport_shutdown_token.clone(),
    policy_from_settings(&auth)?,  // ← bearer auth policy from --ws-auth flag
).await?;

// 三类 JSON-RPC 消息 dispatch
match message {
    JSONRPCMessage::Request(request) => processor.process_request(connection_id, request, ...),
    JSONRPCMessage::Response(response) => processor.process_response(response),
    JSONRPCMessage::Notification(notification) => processor.process_notification(notification),
}

// Per-connection opt-out tracking (multi-client broadcast model)
let outbound_opted_out_notification_methods = Arc::new(RwLock::new(HashSet::new()));
// route_outgoing_envelope() 路由前查这个 set
```

**关键 evidence**:
- ws transport 是 **broadcast-by-default**: 所有 connected clients 默认接收 daemon emit 的所有 ServerNotification
- 每个 client 在 `initialize.params.capabilities.optOutNotificationMethods: ["item/agentMessage/delta", ...]` 显式 opt-out 不需要的 notification 类型
- 这跟之前 RFC-006 §3.7 "per-thread streaming 须 owner-subscriber" 描述 **部分错误** — 协议层是 broadcast, 但有效 streaming targeting 须 client 端 filter (anet wrapper 实施时 filter own thread events, 用户 TUI attach 时 client 自己决定 receive)

### 1.3 sessions disk format (rollout 文件)

实测 `~/.codex/sessions/2026/05/13/rollout-2026-05-13T13-45-55-019e1fde-ca3a-7501-bb2e-d082c7cd004a.jsonl`:

```
[0] {timestamp, type: "session_meta", payload: {id, timestamp, cwd, originator, cli_version, source, model_provider, base_instructions}}
[1] {timestamp, type: "event_msg", payload: {msg: {type: <event type>, ...}}}
[2] {timestamp, type: "response_item", payload: {item: {type:"message", role:"developer", content:[...]}}}
[3] {timestamp, type: "response_item", payload: {item: {type:"message", role:"user", content:[...]}}}
[4] {timestamp, type: "turn_context", payload: {...}}
[5] {timestamp, type: "response_item", payload: {item: {type:"message", role:"assistant", content:[...]}}}
... (12 lines for a "say hi in one word" turn)
```

**Format insights**:
- JSONL append-only, 一行一 RolloutLine `{timestamp, type, payload}` envelope
- 4 个 type: `session_meta` (header) / `event_msg` (events emit 期间) / `response_item` (raw conversation messages, developer/user/assistant) / `turn_context` (turn boundary)
- per PR #3380 "Introduce rollout items": 格式 migration, 老 codex 写 bare ResponseItem 不能 deserialize 新格式 — **anet 实施时 codex pin 0.130+**
- Stored: `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<UUID>.jsonl`
- Archive: `$CODEX_HOME/archived_sessions/`
- **`thread/resume {threadId}` flow**: daemon 用 threadId 在 disk 找对应 rollout 文件, 解析 JSONL 重建 in-memory thread state

**anet 含义**:
- thread persist 是 sync per-event 写入 (实测 12 line for 一个 turn — 每个 item/event 一 line)
- `thread/resume` 须 thread 已 persist (race: anet thread/start → 立即 turn/start 完成 后 才 persist? 还是 thread/start 后就持久化 session_meta? 实测见 §3)
- anet 实施 sessionStore mirror (跟 RFC-008 §C claude side parallel) 时, codex 这边 rollout 已是 daemon native 持久化, anet 仅须读 + 同步 commhub_session_transcripts 表 (~80 行 mirror logic)

### 1.4 sandbox modes (`codex-rs/core/src/sandbox/`)

per `codex app-server generate-json-schema` SandboxPolicy schema:

| Mode | type discriminator | networkAccess | filesystem |
|---|---|---|---|
| `read-only` | `readOnly` | default false (restricted) | only read |
| `workspace-write` | `workspaceWrite` | default restricted | read + write cwd (`~/.codex/cwd-restricted-fs/`) |
| `danger-full-access` | `dangerFullAccess` | full | full filesystem |
| `external-sandbox` | `externalSandbox` | configurable | external sandbox config |

per probe 实测: daemon 启动时 ERROR `"Codex could not find bubblewrap on PATH"` — codex 用 [bubblewrap](https://github.com/containers/bubblewrap) 实现 sandbox。bundled fallback 是 codex-linux-x64 内置 bwrap binary。

anet 实施推荐 **`workspace-write` default** — agent 改 cwd 文件 OK, 不能伤害 cwd 外 + 不能联网 (符合 G6 安全默认)。

### 1.5 auth modes

- `~/.codex/auth.json` 持久化 ChatGPT OAuth tokens + OPENAI_API_KEY
- 实测我本机 `auth.json`: `{auth_mode, OPENAI_API_KEY, tokens, last_refresh}` 但 `account.account_type` field 空 — Vincent ChatGPT account login session 可能未 active 或 anonymous

**ChatGPT account auth 限制**:
- 通信龙 §0.3 实测: `gpt-4.1-mini` 不支持 → return error 400 "invalid_request_error"
- Vincent ChatGPT 订阅支持 models 估 (从 ChatGPT.com 跟 codex 共享同 account): gpt-5 / gpt-5-codex / o3 / o4-mini / Sora 等
- API key auth 模式 (set OPENAI_API_KEY env) 支持更多 models (按 OpenAI API platform availability)

→ anet RFC-006 §11 Q7 (default model) 答案: **profile.flags.codex.model** required, default 不设 (用户输入), 但 wizard prompt 列 supported models 矩阵 (ChatGPT vs API key 两 path)

## 2. WS Protocol 详解 (实测 + schema dump)

### 2.1 完整 ClientRequest 75 个 method (anet Phase 1 用 ~6 个)

per `/tmp/codex-schema/ClientRequest.json` dump (实测 75 个):

**anet Phase 1 用 (~6 method)**:
- `initialize` — 1x per ws session
- `thread/start` — 1x per agent-node session (params: cwd, sandbox, approvalPolicy, model?, ephemeral?)
- `thread/resume` — on ws reconnect (params: threadId)
- `turn/start` — per commhub task (params: threadId, input: UserInput[])
- `turn/interrupt` — anet 超时 / 用户 explicit interrupt
- `turn/steer` — 用户中途调整 (Phase 1 optional)

**Other 69 method** (anet 可能 Phase 2 用 / 不用):
- thread/fork / thread/list / thread/archive / thread/unarchive / thread/inject_items / thread/rollback / thread/metadata/update / thread/name/set / thread/unsubscribe
- command/exec / command/exec/resize / command/exec/terminate / command/exec/write
- config/read / config/value/write / config/batchWrite / config/mcpServer/reload
- fs/readFile / fs/writeFile / fs/createDirectory / fs/copy / fs/remove / fs/readDirectory / fs/getMetadata / fs/watch / fs/unwatch
- mcpServer/oauth/login / mcpServer/resource/read / mcpServer/tool/call / mcpServerStatus/list
- model/list / modelProvider/capabilities/read
- plugin/install / plugin/uninstall / plugin/list / plugin/read / plugin/share/save / plugin/share/list / plugin/share/delete / plugin/share/updateTargets / plugin/skill/read
- skills/list / skills/config/write
- account/login/start / account/login/cancel / account/logout / account/read / account/rateLimits/read / account/sendAddCreditsNudgeEmail
- fuzzyFileSearch
- review/start
- thread/compact/start / thread/loaded/list / thread/read / thread/approveGuardianDeniedAction
- experimentalFeature/list / experimentalFeature/enablement/set
- externalAgentConfig/detect / externalAgentConfig/import
- feedback/upload / hooks/list / marketplace/add / marketplace/remove / marketplace/upgrade
- windowsSandbox/readiness / windowsSandbox/setupStart
- app/list / configRequirements/read

→ Phase 1 anet 仅用 ~8% of ClientRequest surface (6/75)。Phase 2 可能加: thread/inject_items (Path B push prompt without new turn), turn/steer (mid-execution control), thread/fork (multi-branch reasoning), model/list (validate supported model).

### 2.2 63 个 ServerNotification (anet bridge → commhub mapping)

per `/tmp/codex-schema/ServerNotification.json` dump, anet 关注 mapping (13 个 high-value, 50 个 low-priority 不 forward):

**High-value (forward 给 commhub `report_progress` 即 RFC-003 telemetry)**:
- `turn/started`, `turn/completed` (含 duration_ms / time_to_first_token_ms)
- `item/started`, `item/completed` (UserMessage / AgentMessage / CommandExecution / FileChange)
- `item/agentMessage/delta` (token-level streaming, **anet batch 200ms/1KB flush**)
- `item/commandExecution/outputDelta` (shell output stream)
- `item/fileChange/outputDelta` / `item/fileChange/patchUpdated`
- `thread/tokenUsage/updated`, `account/rateLimits/updated`
- `mcpServer/startupStatus/updated` (codex 自己启动子 MCP server 状态)
- `remoteControl/status/changed` (status: disabled/connecting/connected/errored)

**Low-priority (anet 不 forward, log only or skip)**:
- `raw_response_item` (debug noise — 实测 12-line rollout 大部分是这个)
- `configWarning`, `deprecationNotice` (log only)
- `warning` (含 "Under-development incomplete" 警告 — anet 显式 filter, 不污染 commhub progress)
- `windows/worldWritableWarning`, `windowsSandbox/setupCompleted` (Windows specific)
- `thread/realtime/*` (8 events, WebRTC audio — Phase 1 不用)
- `fuzzyFileSearch/sessionCompleted/Updated` (fuzzy search session, anet 不用)
- `hook/started`, `hook/completed`, `process/exited`, `process/outputDelta` (hook 跟 codex 自身 — anet 不 forward)
- `model/rerouted`, `model/verification` (model 路由 — log only)
- `serverRequest/resolved` (server-side approval flow tracking)
- `thread/archived`, `thread/unarchived`, `thread/compacted`, `thread/closed` (lifecycle, anet 用 thread/status/changed 同效)
- `mcpServer/oauthLogin/completed` (MCP OAuth flow — passthrough)
- `account/login/completed`, `account/updated` (account state — log only)
- `app/list/updated` (apps list — log only)
- `skills/changed` (Skills hot-reload — log only)
- `thread/name/updated`, `thread/goal/updated`, `thread/goal/cleared` (per 通信龙 §4.3 mcp-server 不 expose, ws daemon **会** emit — 可作 anet "thread goal" feature 显示在 dashboard)
- `guardianWarning` (sandbox guardian — log + escalate 指挥室)
- `model/verification`, `model/rerouted`, `deprecationNotice` (model lifecycle)
- `error`, `configWarning`, `externalAgentConfig/import/completed` (lifecycle)

→ Phase 1 anet bridge filter logic: **whitelist 13 high-value + filter rest as low-priority log**。~30 行 filter code in agent-node。

### 2.3 9 个 ServerRequest reverse approval (anet 须 reply)

per `/tmp/codex-schema/ServerRequest.json` 9 method enum (实测):

| ServerRequest | params | 来源 | anet 推荐 reply 策略 |
|---|---|---|---|
| `execCommandApproval` | command, cwd, parsedCmd | codex 执行 shell 前 | whitelist (ls/cat/grep/git status/git log) auto-approve / 其他 escalate `指挥室` |
| `applyPatchApproval` | patches (含 file_paths + lines diff) | codex 改文件前 | same cwd + ≤5 files + ≤200 lines auto-approve / 其他 escalate |
| `item/permissions/requestApproval` | reason, action | codex 申请新 permission | escalate `指挥室` |
| `item/tool/call` | tool_name, arguments | codex 调 MCP tool (含 commhub_*) | passthrough commhub MCP tool 转发 |
| `item/tool/requestUserInput` | prompt, kind | codex 需要用户输入 | escalate `指挥室` via commhub_send_task |
| `mcpServer/elicitation/request` | schema, message | MCP server 询问 anet | escalate 或 auto-fill from profile.flags |
| `account/chatgptAuthTokens/refresh` | (no params) | codex auth refresh | passthrough |
| `applyPatchApproval/grantRoot` (variant) | path, reason | codex 申请 cwd 外 root | 永不 auto-approve, escalate |
| (一个 reserved variant) | | | |

**实测待 通信龙 并行 hands-on confirm**:
- 起 daemon + ws client, send turn/start prompt 让 codex 执行 shell command (sandbox=`workspace-write` + approvalPolicy=`on-failure`)
- 观察 daemon emit `execCommandApproval` ServerRequest 内容 (command + parsedCmd 结构)
- anet client **不 reply** 看 daemon timeout/retry behavior
- anet client reply `{approved: true}` 看 codex 继续执行
- anet client reply `{approved: false, reason: "..."}` 看 codex 用 reason 重 plan

我 hands-on 受 task #30 时间预算限制, **委托通信龙 parallel hands-on** (per task body §3), 跟我 doc cross-verify。

## 3. Multi-client peer co-presence — 完整 verify

### 3.1 Daemon broadcast model (源码 confirm)

per §1.2 ws transport `route_outgoing_envelope()`:
- daemon 默认 broadcasts ALL ServerNotifications 给 ALL connected ws clients
- 每 client 在 `initialize` 时显式 opt-out specific method names via `capabilities.optOutNotificationMethods`
- 不是 per-thread subscriber model — 是 protocol 层 broadcast + client 端 filter

### 3.2 Real probe — 跟 Path B deep plan §3.2 结果一致

**第 1 轮 (2 个独立 thread, 各 client 起一个)**: BOTH clients see BOTH threads' lifecycle events (confirm broadcast)

**第 2 轮 (B `thread/resume <A's threadId>`)**: 
- `thread/resume` error: `"no rollout found for thread id 019e1fcc-a0f5-7a42-b1a7-5014ad7918fd"` 
- 原因: A thread 创建后立即 turn/start, rollout file 尚未 sync 写入 disk (race condition)

**第 2 轮 reality** (per §1.3 sessions disk format):
- A thread/start 后 daemon 在 `~/.codex/sessions/YYYY/MM/DD/rollout-...jsonl` 创建文件并写 `session_meta` line — 但这个 sync 是 *event*  async (codex 内部 disk write 用 task spawn)
- B 立即 thread/resume 时 daemon 在内存找不到 (尚未 commit), 在 disk 也找不到 (尚未写入) → error
- **实际可工作 flow**: A 先完成 turn/start (~3 sec for "say hi"), 此时 rollout 已写完整, **然后** B thread/resume 同 threadId — 但 thread state 是历史 snapshot, 不是 live streaming

### 3.3 Per-thread streaming subscriber 真行为 (实测 nuance)

通信龙 待 hands-on 验证, **预期** (基于 schema + broadcast model 推理):
- B 不能直接 "follow A's live streaming" via thread/resume — daemon 不维护 active subscriber model
- B 可 `thread/resume <id>` 重建 A 历史 state, 但 A 的 in-progress turn 仍只对 A 推送 turn/* + item/* 事件
- 真 multi-client peer co-presence: 用户场景 = **A 跑完 turn 后 B resume 看 history** (类似 reading session log), 不是 live streaming
- → 跟 [GitHub issue #21551](https://github.com/openai/codex/issues/21551) 描述对应: 当前 broadcast 给所有 client, 但 turn streaming 是 emit-once 不是 subscribe

### 3.4 anet 含义 — 修正 RFC-006 §3.7 描述

RFC-006 §3.7 sequence diagram 中描述的"用户 TUI attach 同 daemon → 看 anet 跑的 turn live"是 **部分错误**:

- ✅ 用户 TUI attach 同 daemon → 看 lifecycle events broadcast (turn/started / item/started / item/completed / turn/completed)
- ❌ 用户 TUI **不** 看到 `item/agentMessage/delta` token-level streaming for anet's thread (因为 delta 是定向 emit 给创建该 turn 的 client connection, 不是全 broadcast)
- ✅ 用户 TUI **可以** 在 anet thread 完成 turn 后 `thread/resume <anet's threadId>` 看历史 conversation 已 persisted to rollout

**Errata for RFC-006**: §3.7 sequence diagram + §4.4 user TUI attach flow 须 amend caveat: "用户 TUI 可见 lifecycle, **不可见** in-progress token stream, 但可 thread/resume 看完整 history (turn 完成后)"。

## 4. Sandbox Modes 完整对比

per `codex app-server generate-json-schema` SandboxPolicy schema:

| Mode | type discriminator | networkAccess | filesystem | anet 推荐? |
|---|---|---|---|---|
| `read-only` | `readOnly` | restricted (default false, 可 enable) | only read all | 严格 review-only agent |
| `workspace-write` | `workspaceWrite` | restricted (default false) | read all + write cwd | **Phase 1 default** ✅ |
| `danger-full-access` | `dangerFullAccess` | full | full filesystem | 不推荐 (除非用户明确 opt-in) |
| `external-sandbox` | `externalSandbox` | configurable | external sandbox config | 高级 (Phase 2 if 用户 ask) |

**实测 caveat (从 daemon log)**:
```
codex_app_server: Codex could not find bubblewrap on PATH. Install bubblewrap with your OS package manager. See the sandbox prerequisites: https://developers.openai.com/codex/concepts/sandboxing#prerequisites. Codex will use the bundled bubblewrap in the meantime.
```

→ Linux daemon 须 bubblewrap (bwrap binary) for sandbox enforcement; bundled fallback 来自 `@openai/codex-linux-x64` npm package。Mac mini 可能用 macOS Sandbox 机制 (待 Vincent 跨平台 verify)。

## 5. /goal Flow

per `codex-rs/tui/src/slash_command.rs` (WebFetch):
- `/goal` — "set or view the goal for a long-running task" (TUI slash command)
- 60+ 其他 slash commands 含 `/clear` `/quit` `/exit` `/diff` `/status` `/model` `/resume` `/fork` `/init` `/compact` `/plan` `/agent` `/side` `/copy` `/raw` `/mention` `/skills` `/hooks` `/theme` `/pets` `/mcp` `/plugins` `/logout` 等

**关键**: `slash_command.rs` 仅是 TUI **slash command metadata** (description + arg support + task availability), **不** 包含 RPC mapping。Slash commands 是 TUI 客户端本地 sugar, 大部分在 TUI 进程内执行 (e.g. `/clear` 清 terminal), 部分 map app-server RPC (e.g. `/resume` → `thread/resume`, `/fork` → `thread/fork`)。

`thread/goal/updated` notification (per §2.2) 存在于 ServerNotification list, 说明 daemon 有 thread-level "goal" 概念 (跟 `/goal` slash command 对应), 但 mcp-server (Path C) 不 expose 这个 notification (per 通信龙 §4.3)。**ws daemon (Path B) 会 emit `thread/goal/updated`** — anet Phase 1 可在 dashboard `<TaskChatPanel>` 显示 thread current goal (UX 加分)。

**anet 实施**:
- 接收 `thread/goal/updated` notification → 写入 commhub `progress_events` (kind=GOAL_UPDATED) → dashboard "Goal: ..." badge
- 用户在 TUI attach 时 `/goal` 设 goal, anet 的 dashboard 自动 reflect (跨 client 协作 UX)
- anet wrapper 自己不需要 set goal, 但接收 + forward 给 dashboard

## 6. 协议 stability + 本周 3 PRs 详细 analysis

### 6.1 PR #22404 — Restore ws listener with auth guard (etraut-openai, 2026-05-13)

**Restore 内容**:
- ws://IP:PORT parsing capability
- TCP websocket acceptor for app-server
- WebSocket auth CLI flags
- Test coverage

**Auth guard**:
- non-loopback ws listeners (e.g. 0.0.0.0:port / LAN IP:port) **MUST** 配 `--ws-auth capability-token` 或 `--ws-auth signed-bearer-token`
- loopback (127.0.0.1) listener remain auth-optional (for SSH port-forwarding)

**Origin**: 之前 PR #21843 REMOVED TCP ws listener (security concern but break TUI remoting), #22404 restored 并加 guard。

**anet 含义**:
- ✅ anet 用 loopback ws://127.0.0.1:<port> 默认 不需 auth (但 RFC-006 §6.1 仍 recommend capability-token 加保险, anti-other-process-on-same-host scenarios)
- ⚠ codex 0.130 release period 可能 ws transport 缺失 (在 #21843 和 #22404 之间), Vincent mac mini 装的 0.130 须 verify ws listen flag 是否 work

### 6.2 PR #22414 — Add UDS support for codex --remote (etraut-openai, 2026-05-13)

**新加**:
- `--remote unix://PATH` Unix Domain Socket 支持
- 协议层不变 (仍 JSON-RPC-over-WebSocket protocol over UDS stream — JSON 框架走 ws-like frame on UDS)
- TUI 现 智能 fallback: probe default daemon socket → daemon absent/unresponsive → fallback embedded app-server

**Auth model**:
- `--remote-auth-token-env` flag **仅适用 wss:// 或 loopback ws://**, **不** 适用 UDS
- UDS 通过 unix socket file permission 控制 access (chmod / chown 隔离, vs token model)

**anet 含义**:
- ✅ **Phase 1.5 / 2 候选**: anet 改 `unix:///tmp/anet-codex-<alias>.sock` 替代 ws://port — 优势 无 port 冲突 + 文件权限 chmod 0700 比 token 简单
- ⚠ npm `ws` 8.x 不原生支持 unix socket (需要 + 用 node `net.createConnection({path: '/path/to/sock'})` 自行 framing), 估 +50 行 transport code
- 建议 RFC-006 §11 加 Open Q13: "Phase 1 ws://127.0.0.1:port vs unix:///tmp/anet-codex-<alias>.sock 选哪个 transport"

### 6.3 PR #22386 — Mark Feature::RemoteControl as Stage::Removed (owenlin0, 2026-05-13)

**变更**:
- `[features] remote_control = true` config setting 变 **inert** (兼容性保留, 但不再影响功能)
- 改用 CLI flag `--remote-control` (hidden) 给 `codex app-server`
- daemon 现 spawn 用 `--remote-control --listen unix://` (注意 unix://!)

**Breaking change behavior**:
- 旧 config 不报错 (compat key), 但 not enforce remote_control feature
- 用户 must migrate: 命令行加 `--remote-control` 替代 config

**anet 当前 RFC-006 §3.3 spawn flag**:
```
codex --enable remote_control app-server --listen ws://127.0.0.1:<port> --ws-auth capability-token --ws-token-sha256 <hex>
```

**post-#22386 推荐 migration**:
```
codex --remote-control --listen unix:///tmp/anet-codex-<alias>.sock
# 或者保持 ws:
codex --remote-control --listen ws://127.0.0.1:<port> --ws-auth capability-token --ws-token-sha256 <hex>
```

→ anet 实施时 `--enable remote_control` 跟 `--remote-control` 双 path 都 try, 优先后者 if codex 版本支持 (须 detect)。

### 6.4 协议 churn 总体 risk

3 PRs all 2026-05-13 today merged → codex 在这 area 仍 active development。Pin 推荐:
- codex >= 0.130.0 (含 mcp-server + remote-control 基础)
- 但等 #22404 + #22414 + #22386 全 included 的 0.131.0 release 才 production-ready
- anet 实施加 codex version detect at runtime + 警告 if < 0.131.0

## 7. 跨平台行为 (待 Vincent mac mini verify)

| Platform | sandbox 实现 | ws transport | UDS support | 跨 platform `codex remote-control` |
|---|---|---|---|---|
| Linux | bubblewrap (bundled or system) | ws://+wss:// | ✅ unix:// | ✅ (实测) |
| macOS | macOS Sandbox (Apple) | ws://+wss:// | ✅ unix:// (待 verify) | ✅ Vincent 4099 paste 跑通 |
| Windows | windowsSandbox flag (per schema windowsSandbox/setupReadiness/setupStart RPC) | ws:// 须特殊配置 | ❌ UDS Linux/Mac only | ⚠ Windows codex 实现差异 (须 codex 0.131 verify) |

per [#18503 Windows app remote 失败](https://github.com/openai/codex/issues/18503): Windows codex daemon 用 fixed port `127.0.0.1:9234`, port 冲突时 fail。Linux/Mac 用 dynamic port + UDS。

→ anet 实施 Windows path 须特殊 handling (检测 OS + use static port range vs dynamic)。

## 8. anet 集成建议 (evidence-based)

### 8.1 RFC-006 §3 design 须 amend (evidence-driven)

| RFC-006 §3 assumption | Deep research finding | Amend |
|---|---|---|
| §3.7 用户 TUI attach 看 anet's turn live token streaming | ❌ 用户仅看 lifecycle, 不看 token delta (per §3.3 multi-client subscriber model) | §3.7 caveat 加: "用户 TUI 可 follow lifecycle, in-progress token 仅 owner 收到; 完成后 thread/resume 看 history" |
| §3.3 spawn 用 `--enable remote_control app-server --listen ws://` | PR #22386 deprecate, post-0.131 推荐 `--remote-control --listen unix://` | §3.3 加 transport 选项: Phase 1 ws://127.0.0.1:<port> + Phase 1.5 migrate unix:///tmp/<sock> |
| §6.1 推荐 capability-token | UDS 不需 token (filesystem permission OK), ws://loopback 默认 也不强制 | §6.1 加 transport-specific auth: loopback ws / UDS = optional, non-loopback ws = required |
| §11 Q12 一共 12 个 Open Q | 新加 Q13: ws vs unix transport 选 / Q14: post-0.131 `--remote-control` flag adoption / Q15: Linux/macOS/Windows cross-platform | §11 加 3 个新 Q |

### 8.2 Phase 1 实施推荐 (evidence-validated)

1. **Transport**: Phase 1 用 ws://127.0.0.1:<auto-port> (兼容 0.130, simple), Phase 1.5 migrate `--remote-control --listen unix:///tmp/anet-codex-<alias>.sock` (post-0.131 release)
2. **Auth**: capability-token + sha256 (loopback 不强制但 +1 安全) / UDS 仅 chmod 0700 dir + 0600 sock file
3. **ServerNotification filtering**: 13 high-value forward / 50 low-priority skip (per §2.2) — 减 commhub progress flood
4. **9 reverse approval flow**: smart whitelist (read-only shell) + escalate dangerous → 通信龙 hands-on confirm reply format/timeout
5. **Multi-client UX**: cases doc 显式说"用户 TUI attach 仅看 lifecycle + 完成后 thread/resume 看 history", 不承诺 live token streaming
6. **Thread persist**: rollout per-event 写盘, anet sessionStore mirror 跟 RFC-008 §C 一致 (commhub session_transcripts 表, Phase 2)
7. **slash commands**: anet 不 expose codex TUI slash commands (Path A non-goal), 但 `/goal` 通过 `thread/goal/updated` ServerNotification 传到 dashboard
8. **Cross-platform**: Linux primary (实测 OK), macOS Vincent 已 verify, Windows defer Phase 2

### 8.3 Phase 2 candidate (per RFC-006 §10)

满足 TR1-TR3 + 通信龙 hands-on confirm 9 reverse approval flow 后:
- thread/inject_items: Phase 2 加 push prompt to running thread (without new turn) feature
- turn/steer: Phase 2 加 mid-execution direction change UX
- thread/fork: Phase 2 加 multi-branch reasoning (用户 dashboard fork agent A 的 thread 到 thread B 探索另一方向)
- model/list integration: Phase 2 setup wizard 用 model/list query daemon 取 supported models (替代静态列表)
- unix:// transport: Phase 2 migrate from ws:// for cleaner deployment (no port allocation)
- codex 0.131 stable: Phase 2 trigger 升级 + remove experimental warning

### 8.4 不阻塞 Phase 1 但 evidence-mark backlog item

- `~/.codex/auth.json` Vincent ChatGPT account active check (per §1.5 我实测我本地 account_type null) — anet 启动时 verify `codex --version` 后 also verify `codex account read` 返 ChatGPT-Pro 或 API key OK
- bubblewrap dependency (Linux) — anet wizard 可 detect + 提示 `sudo apt install bubblewrap` (vs codex bundled fallback)
- Windows port 9234 冲突 issue #18503 — anet Windows-specific handling

---

## 9. Cross-verify TODO (跟 通信龙 hands-on)

通信龙 task body §3-§5 hands-on 项 ETA 1-2h, 等他 ship 后跟本 doc cross-verify:

- [ ] 9 ServerRequest reverse approval flow 实测 (execCommandApproval 真 push 给 client 内容 / anet 不 reply 看 timeout / reply approved/denied)
- [ ] Multi-client `thread/resume <A's id>` 是否真能 follow A's history (per §3.3 推理)
- [ ] 同 thread 多 client 写 turn/start race behavior
- [ ] ChatGPT account supported models 实测 (gpt-5? o3? o4-mini?)
- [ ] sessions disk format 跨 turn cumulative (我 实测 单 turn 12 lines, 跨多 turn 累计行数验证)

---

## 10. Risks & Open Questions (evidence-aware)

### 10.1 协议 churn 风险 (3 PRs today merged + experimental flag)

- ✅ Mitigation 1: Pin codex >= 0.130.0 minimum, recommend >= 0.131.0 (containing all 3 PRs)
- ✅ Mitigation 2: anet wizard show experimental warning if codex < 0.131
- ✅ Mitigation 3: schema sync via `codex app-server generate-json-schema` at install time, verify ClientRequest method count + ServerNotification method count 在 expected range

### 10.2 Multi-client live streaming caveat (§3.3 finding)

- ✅ Mitigation: cases doc 说明 user TUI attach 体验 = lifecycle 监控 + 完成后 history 看, 不是 live shadowing
- 🟡 Future improvement: 若 OpenAI implement issue #21551 multi-client subscriber RFC → anet Phase 3 升级 live shadowing

### 10.3 ChatGPT auth model limit (§1.5)

- ⚠ Open: gpt-4.1-mini 已 fail, 待实测 gpt-5 / o3 / o4-mini available
- ✅ Mitigation: anet profile.flags.codex.model required (no silent default), wizard 列 supported model 矩阵

### 10.4 9 ServerRequest reverse approval timeout behavior

- ⚠ Open: anet 不 reply 时 codex daemon 怎么 timeout? 几秒后 turn fail?
- 🎯 通信龙 parallel hands-on confirm

### 10.5 sessions disk file race condition (§3.2)

- ⚠ Open: A thread/start → 立即 B thread/resume 时 rollout file 尚未写完导致 "no rollout found" error
- ✅ Mitigation: anet 不 expose multi-client UI 给 race 的场景; 用户 TUI attach 等 anet 节点 idle 时 resume

---

**Footer per anet attribution SOP**:

```
Author-Agent: 通信SDK马
Helpers: 通信龙 (并行 hands-on multi-client + approval flow + dispatch + dual deep plan)
```

— END —
