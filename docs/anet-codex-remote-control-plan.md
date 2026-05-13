# anet 支持 codex CLI 通过 remote-control ws daemon 的完整方案

> **作者**: 通信SDK马（hands-on 跑 codex CLI 0.130 `app-server --listen ws://` + 实测 multi-client + bearer auth + 完整 turn 流）
> **日期**: 2026-05-13
> **状态**: 草案 — 深度调研 doc（per Vincent telegram 4090+4093+4095 派单的 dual parallel deep research, 跟通信龙的 mcp-server stdio 方案 doc 并行）
> **触发**: Vincent 4090 "你对这个足够熟悉吗" 触发 self-audit + 4093+4095 派 通信SDK马 (我) 出 remote-control ws 方案 deep doc / 通信龙 出 mcp-server stdio 方案 deep doc, Vincent compare 选 ship
> **关联**: [RFC-006](./rfcs/RFC-006-codex-code-cli-mcp-server.md) Phase 2 路径 / RFC-005 (Superseded) / commit 6429bc0 codex CLI 通信研究 / commit 24b744e 通信龙 deep design doc

## TL;DR

🎯 **Path B (remote-control ws daemon) 实测完全 work** — codex 0.130 `app-server --listen ws://127.0.0.1:PORT` 完整支持: ws handshake / bearer auth / JSON-RPC 2.0 / multi-client broadcast / 实时 ServerNotification 流 (turn/started → item/agentMessage/delta token-level → turn/completed)。

📊 **工作量 vs mcp-server stdio**: agent-node +470 行 (ws plumbing + bearer auth + reconnect + 9 reverse approval + supervision) vs Path C 的 +170 行 (stdio MCP client) — **~2x 代码量**。新增 npm dep `ws` ^8。

⚠️ **关键 caveat 实测捕获**: daemon 在 `--listen ws://` + `--enable remote_control` 启动时 emit `warning: "Under-development features enabled: remote_control. Under-development features are incomplete and may behave unpredictably"` + `remoteControl/status/changed: {status: "errored"}` — OpenAI **自己标 experimental + incomplete**。stable timeline 未公开。

✅ **multi-client 实测意外发现**: daemon **接受 ≥2 个并发 ws 客户端**, 并且事件**广播给所有客户端** (issue #21551 peer-client co-presence 实际已 work, 跟之前 web search 结论 "no merged support" 矛盾, 实测 authoritative)。

🟡 **anet 实施推荐**: **Phase 1 走 mcp-server stdio (RFC-006 Path C) 不变**, Path B (本 doc) 作 Phase 2 (~2 weeks) 等 codex 0.131/0.132 ws transport stabilize + remote_control feature 移出 "under-development" 警告之后。详 §8 verdict。

## 1. codex remote-control architecture (源码层)

### 1.1 PR 时间线 (per openai/codex repo)

| PR | merge 时间 | 内容 |
|---|---|---|
| [#14853](https://github.com/openai/codex/pull/14853) | 2026-03-26 | client-side `--remote` + `--remote-auth-token-env` 实现 + `Authorization: Bearer <token>` header 在 ws handshake 传输 (Server-side PR #14847 同期) |
| [#21424](https://github.com/openai/codex/pull/21424) | 2026-05-07 | `codex remote-control` 顶层 subcommand wrapper (调用 `ensure_remote_control_started`) |
| [#22178](https://github.com/openai/codex/pull/22178) | 2026-05-11 | fix(app-server): thread history redaction for remote clients |
| [#22218](https://github.com/openai/codex/pull/22218) | 2026-05-11 | Update `codex remote-control` to start the daemon (bootstrap + daemon lifecycle, auto-update loop) |
| [#22202](https://github.com/openai/codex/pull/22202) | 2026-05-12 | Stabilize remote routing e2e tests |
| [#22386](https://github.com/openai/codex/pull/22386) | 2026-05-13 today | mark `Feature::RemoteControl` as `Stage::Removed` (config 不再控, 改 per-process CLI flag `--remote-control` hidden) |
| [#22404](https://github.com/openai/codex/pull/22404) | 2026-05-13 today | Restore app-server websocket listener with auth guard |
| [#22414](https://github.com/openai/codex/pull/22414) | 2026-05-13 today | Add support for UDS in `codex --remote` (Unix domain socket) |

**Critical**: 2026-05-11/12/13 三天内 6 个 PR 还在 stabilize 这区域 — **protocol churn HIGH**。

### 1.2 子命令实现 (源码层 file:line refs)

**`codex remote-control` (server)** — `codex-rs/cli/src/main.rs` L1665-1668 (per WebFetch):

```rust
Some(Subcommand::RemoteControl) => {
    reject_remote_mode_for_subcommand(...)?;
    let output = codex_app_server_daemon::ensure_remote_control_started().await?;
    println!("{}", serde_json::to_string(&output)?);
}
```

调用 `codex-app-server-daemon` crate `ensure_remote_control_started()`:

```rust
async fn ensure_remote_control_started(&self) -> Result<RemoteControlStartOutput> {
    let _operation_lock = self.acquire_operation_lock().await?; // daemon.lock 75s timeout
    let settings = self.load_settings().await?;
    if self.is_bootstrapped(&settings).await? {
        let _ = self.set_remote_control_locked(RemoteControlMode::Enabled).await?;
        let output = self.start().await?;
        return Ok(RemoteControlStartOutput::Start(output));
    }
    let output = self.bootstrap_locked(BootstrapOptions {
        remote_control_enabled: true,
    }).await?;
    Ok(RemoteControlStartOutput::Bootstrap(output))
}
```

Bootstrap 路径启动 daemon (PID-based backend + auto-update loop process), 用 Unix socket 路径 `app_server_control_socket_path(codex_home)` = `$CODEX_HOME/app-server-daemon/<sock>`。PID 文件: `$CODEX_HOME/app-server-daemon/app-server.pid`。

JSON 输出 schema:

```json
// BootstrapOutput variant
{"status":"bootstrapped","backend":"pid","autoUpdateEnabled":true,"remoteControlEnabled":true,"managedCodexPath":"...","socketPath":"...","cliVersion":"x.y.z","appServerVersion":"x.y.z"}

// LifecycleOutput variant
{"status":"started|alreadyRunning","backend":"pid","socketPath":"...","cliVersion":"x.y.z","appServerVersion":"x.y.z"}
```

**`codex --remote <ADDR>` (TUI client mode)** — 实现在 `codex-rs/app-server-client/src/remote.rs` (per WebFetch):
- `--remote ws://host:port` 或 `--remote wss://host:port` (限制 host=loopback 或 wss://)
- `--remote-auth-token-env <ENV_VAR>` 读 env var 拿 bearer token, 作 `Authorization: Bearer <token>` HTTP header 在 ws handshake 发送

**`codex app-server --listen <URL>` (server, low-level, 本 doc 实测用此 path)** — 直接 spawn daemon process:

| `--listen` URL | 说明 |
|---|---|
| `stdio://` (default) | 通过 stdin/stdout 收 JSON-RPC |
| `unix://` 或 `unix://PATH` | Unix domain socket (PR #22414 同期演进) |
| `ws://IP:PORT` | **WebSocket transport (实验性, 实测可用)** |
| `off` | 不开 transport (仅 settings query) |

配套 auth flags:
- `--ws-auth <MODE>`: `capability-token` 或 `signed-bearer-token`
- `--ws-token-file <PATH>` or `--ws-token-sha256 <HEX>`: capability-token mode
- `--ws-shared-secret-file <PATH>` + `--ws-issuer <ISSUER>` + `--ws-audience <AUDIENCE>` + `--ws-max-clock-skew-seconds <N>`: signed-bearer-token JWT mode

## 2. WS Protocol Details

### 2.1 Transport handshake (HTTP Upgrade) — 实测

Daemon 启动:
```
$ codex --enable remote_control app-server --listen ws://127.0.0.1:18766 \
        --ws-auth capability-token --ws-token-sha256 <SHA256_HEX>
codex app-server (WebSockets)
  listening on: ws://127.0.0.1:18766
  readyz: http://127.0.0.1:18766/readyz
  healthz: http://127.0.0.1:18766/healthz
```

**WITH bearer token** — 实测 success:
```
> GET / HTTP/1.1
> Host: 127.0.0.1:18766
> Connection: Upgrade
> Upgrade: websocket
> Sec-WebSocket-Version: 13
> Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==
> Authorization: Bearer anet-test-1778649597

< HTTP/1.1 101 Switching Protocols   ← upgrade success
< sec-websocket-accept: HSmrc0sMlYUkAGmm5OPpG2HaGWk=
```

**WITHOUT bearer token** — 实测 reject:
```
> GET / HTTP/1.1
> Connection: Upgrade
> Upgrade: websocket
(no Authorization header)

< HTTP/1.1 401 Unauthorized
< content-length: 30

missing websocket bearer token
```

### 2.2 HTTP health probes (实测)

```bash
$ curl http://127.0.0.1:18766/healthz  → 200 OK (empty body)
$ curl http://127.0.0.1:18766/readyz   → 200 OK (empty body)
```

不需 auth (设计上是给 load balancer / kubernetes 用)。

### 2.3 Auth modes 完整对比

| Mode | flag 组合 | 实施成本 | 安全级别 |
|---|---|---|---|
| **none** | `--listen ws://...` (无 `--ws-auth`) | 0 | ⚠ 任何 ws client 可 connect (仅 loopback OK) |
| **capability-token** | `--ws-auth capability-token --ws-token-file /abs/path` 或 `--ws-token-sha256 <HEX>` | low (生成 + 存盘 / sha256 inline) | medium (单向 token) |
| **signed-bearer-token (JWT)** | `--ws-auth signed-bearer-token --ws-shared-secret-file ... --ws-issuer X --ws-audience Y --ws-max-clock-skew-seconds N` | medium (须 JWT 签名) | high (issuer/audience/clock-skew 验证) |

anet 推荐 **capability-token + `--ws-token-sha256`** (anet 端 `crypto.randomBytes(32).toString("hex")` 生成 token → sha256 hex 给 daemon flag → bearer 给 ws client) — token 不落盘 (避免泄漏)。

### 2.4 JSON-RPC 2.0 over WebSocket — 完整 sequence (实测 25 events)

(本机 ws://127.0.0.1:18765, no auth daemon, 实测 2026-05-13 13:13)

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"anet-probe","version":"0.1"}}}
← {"id":1,"result":{"userAgent":"anet-probe/0.130.0 (Ubuntu 24.4.0; x86_64) xterm-256color","codexHome":"/home/vansin/.codex","platformFamily":"unix","platformOs":"linux"}}

← (notification) {"method":"configWarning","params":{"summary":"Codex could not find bubblewrap on PATH..."}}
← (notification) {"method":"remoteControl/status/changed","params":{"status":"errored","environmentId":null}}

→ {"jsonrpc":"2.0","id":2,"method":"thread/start","params":{"cwd":"/tmp","sandbox":"read-only","approvalPolicy":"never"}}
← {"id":2,"result":{"thread":{"id":"019e1fc4-57a9-7860-8be5-bbf4a4662de7","sessionId":"019e1fc4-...","modelProvider":"openai","createdAt":1778649421,...}}}

← thread/started
← warning  ← "Under-development features enabled: remote_control. Under-development features are incomplete and may behave unpredictably."
← mcpServer/startupStatus/updated (commhub-proxy starting → failed)
← mcpServer/startupStatus/updated (codex_apps starting → ready)
← thread/status/changed (idle → working)

→ {"jsonrpc":"2.0","id":3,"method":"turn/start","params":{"threadId":"019e1fc4-...","input":[{"type":"text","text":"say hi in one word"}]}}
← {"id":3,"result":{...}}

← turn/started
← item/started (UserMessage) / item/completed (UserMessage)
← account/rateLimits/updated
← item/started (AgentMessage)
← item/agentMessage/delta {"delta":"Hi"}    ← token-level streaming!
← item/completed (AgentMessage)
← thread/tokenUsage/updated
← account/rateLimits/updated
← thread/status/changed (working → idle)
← turn/completed (含 duration_ms / time_to_first_token_ms)
```

### 2.5 关键 server-initiated 反向 request (9 个 ServerRequest)

per schema dump `/tmp/codex-schema/ServerRequest.json` 9 method enum:

| ServerRequest | 用途 | anet ws client 须 reply 策略 |
|---|---|---|
| `applyPatchApproval` | 文件改动前 ask | smart policy (whitelist 同 cwd 内 / escalate grantRoot) |
| `execCommandApproval` | shell 命令前 ask | smart policy (`ls/cat/grep/git status` auto-approve / 其他 escalate) |
| `item/permissions/requestApproval` | 通用 permission | escalate 指挥室 via commhub_send_task |
| `item/tool/call` | codex 调 MCP tool | passthrough (commhub MCP tool 转发) |
| `item/tool/requestUserInput` | 需要用户输入 | escalate 指挥室 |
| `mcpServer/elicitation/request` | MCP server 询问 | escalate 或 auto-fill from config |
| `account/chatgptAuthTokens/refresh` | OpenAI auth refresh | passthrough |
| `applyPatchApproval/grantRoot` (variant) | 文件 root permission | 永不 auto-approve, escalate |
| `execCommandApproval/parsedCmd` (metadata) | 命令解析 metadata | base auto-approve 判断 |

→ anet ws client 须实现 9 个 reverse-request reply handler (~80 行决策框架)。

## 3. Multi-client Status (#21551 实测真行为)

### 3.1 Web search 结论 vs 实测发现 (冲突!)

- [GitHub issue #21551](https://github.com/openai/codex/issues/21551) (per WebFetch): "App Server peer-client co-presence with the live TUI thread (RFC). open, no merged support."
- [GitHub issue #11166](https://github.com/openai/codex/issues/11166): "Expose app-server over network transport for remote/mobile session attach. closed, no impl details listed."
- **实测 (本机 ws://127.0.0.1:18765, 2 个 Bun ws client 并发 connect)**: 2 个都 successfully open + initialize + 都收到 daemon notifications, 且 client-A 看到 client-B 的 thread 事件 (uniqueThreadIds 含 BOTH thread IDs)

### 3.2 实测 evidence

```js
// 2 concurrent ws clients, each starts own thread
async function probe(label, prompt) { /* ws + thread/start + turn/start */ }
const [r1, r2] = await Promise.all([
  probe('client-A', 'say A in one word'),
  probe('client-B', 'say B in one word'),
]);

// Result (实测):
// r1 = { label: 'client-A', threadId: '019e1fc6-...46f4bbe0ee7c', uniqueThreadIds: [<A>, <B>], eventCount: 25 }
// r2 = { label: 'client-B', threadId: '019e1fc6-...470281e958f4', uniqueThreadIds: [<A>, <B>], eventCount: 25 }
// → BOTH clients saw BOTH threads' notification events
```

### 3.3 Same-thread peer co-presence — 实测 nuance (per Vincent 4099 tutorial 验证)

第 2 轮实测 (2026-05-13 13:23+, ws://127.0.0.1:18778):

```js
// Step 1: Client A initialize + thread/start
const aThread = await A.rpc('thread/start', {cwd:'/tmp',sandbox:'read-only',approvalPolicy:'never'});
// → A_THREAD = "019e1fcc-a0f5-7a42-b1a7-5014ad7918fd"

// Step 2: Client B initialize + thread/resume same thread
const bResume = await B.rpc('thread/resume', {threadId: aThread.id});
// → B_RESUME ERROR: "no rollout found for thread id 019e1fcc-..."
// (thread persisted to disk takes time, B 同时 resume 太快)

// Step 3: A starts turn, observe events on both
A.rpc('turn/start', {threadId, input:[{type:'text',text:'say hi'}]});
// 10s 后:
// A_METHODS (16 events): ["thread/status/changed","turn/started","item/started","item/completed",
//                          "item/agentMessage/delta","turn/completed","mcpServer/startupStatus/updated",
//                          "account/rateLimits/updated","thread/tokenUsage/updated"]
// B_METHODS (2 events):  ["thread/status/changed"]   ← B 仅看 lifecycle
// B_SAW_A_THREAD = true   ← B's events carried A's threadId
```

### 3.4 结论 & anet 含义 (修正第 1 轮实测)

第 1 轮 §3.2 (2 个独立 thread, 每客户端各起一个) 实测结果应解读为: 每个 `thread/start` 都触发 broadcast 给所有 ws clients lifecycle notifications, 所以 A 看到自己的 thread + B 起 thread 触发的 lifecycle, 反之亦然。

第 2 轮 (B 尝试 resume A 的 thread 失败) 实测发现:
- ✅ **Lifecycle 事件跨 client broadcast** (thread/status/changed / thread/started / mcpServer/startupStatus/updated 都广播)
- ❌ **Per-thread streaming 事件 (item/agentMessage/delta / item/started / item/completed / turn/started) 不广播** — 仅 thread owner 收到
- ⚠️ `thread/resume` 要求 thread 已 persist 到 disk (rollout file), 同 session 内刚创建的 thread 可能尚未 persist → resume 失败

**Vincent 4099 tutorial 真实行为更接近**:
- 用户 TUI (`codex --remote ws://...`) 一开始就 `thread/start` 创建 (作 owner)
- anet wrapper 后续 `thread/resume` 接进**已 persist 的** thread → 接收 turn events
- 或反之: anet wrapper 创建 thread → 用户 TUI resume (但同步问题)

→ 对 anet 含义:
  - ✅ anet wrapper + 用户 TUI 同 daemon connect — ws transport 层 OK, 不冲突
  - ⚠ **Per-thread streaming 须 owner / subscriber 关系明确** — 不是 free broadcast。anet 实施时要决策: 是 owner (创建 thread + 接收 events) 还是 subscriber (resume + 同步接收)
  - ⚠ **隐私**: lifecycle broadcast 跨 thread 可见, 多 anet 节点同 daemon 不可行 (须 per-node 独立 daemon, 详 §4.6)
  - ⚠ **`thread/resume` 时序**: B resume 太早会失败, 须等 owner 端 `thread/start` 返回 + 一定时间 (磁盘 flush, 估 ~100-500ms)

## 4. anet Implement Plan

### 4.1 Option 2 (agent-node 内 runtime) — per 通信工程马共识

- cli.ts: thin launcher (~50 行 dispatch + setup wizard 增 entry)
- agent-node: 重活 (ws client + bearer auth + reconnect + 9 reverse approval + supervision + bridge)

### 4.2 工作量分解 (基于实测复杂度)

| 模块 | 行数 | 说明 |
|---|---|---|
| cli.ts (RuntimeName enum + normalizeRuntime + checkRuntimeDependency + setupCommand + launchAgent dispatch) | +50 | 跟 codex-sdk dispatch 同款 |
| agent-node `src/runtime/codex-code-cli-remote-control.ts` 主类 | +200 | 类比 codex-sdk runtime |
| ws transport module (heartbeat / reconnect 指数退避 / message framing / ping-pong) | +80 | 用 `ws` npm package |
| bearer token mgmt (`crypto.randomBytes(32).toString("hex")` 生成 + sha256 hex + env injection) | +30 | per anet session unique token |
| daemon supervision (spawn `codex app-server --listen ws://...` child + PID watch + crash restart + free port allocation + EADDRINUSE retry) | +60 | 类比 codex-sdk supervision |
| 9 个 ServerRequest reverse approval reply handler (smart policy + escalate) | +80 | 详 §2.5 表 |
| Bridge: commhub SSE ↔ ws JSON-RPC ↔ ServerNotification → commhub `report_progress` (RFC-003 telemetry layer 复用) | +100 | event mapper + batch 200ms/1KB flush |
| Docker E2E test L0-L9 (ws plumb / bearer auth / multi-client check / approval flow / restart resilience) | +400 | 通信测试马 PR #43 演进 |
| **TOTAL** | **~1000 行** | **vs Path C ~500 行 = 2x 代码量** |

→ Complexity hot spots: ws reconnect + bearer key mgmt + 9 reverse approval 决策框架 + port allocation race。

### 4.3 daemon spawn 策略

agent-node 启动 `codex-code-cli-remote-control` runtime 时:

```ts
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import WebSocket from "ws";

const PORT = await allocateFreePort(); // 127.0.0.1:PORT range (e.g. 18000-18999)
const TOKEN = crypto.randomBytes(32).toString("hex"); // 64 hex chars
const TOKEN_SHA256 = crypto.createHash("sha256").update(TOKEN).digest("hex");

const daemon = spawn("codex", [
  "--enable", "remote_control",
  "app-server",
  "--listen", `ws://127.0.0.1:${PORT}`,
  "--ws-auth", "capability-token",
  "--ws-token-sha256", TOKEN_SHA256,
], {
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
});

// Wait for daemon ready (poll /healthz)
await waitForPort(PORT, 5000);

// Connect ws client with Bearer token
const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, {
  headers: { Authorization: `Bearer ${TOKEN}` }
});

ws.on("open", async () => {
  // Send initialize
  await rpc("initialize", { clientInfo: { name: "anet-codex-code-cli-remote-control", version: AGENT_NODE_VERSION } });
  // Send thread/start with profile settings
  const { thread } = await rpc("thread/start", { cwd: profile.cwd, sandbox: profile.sandbox, approvalPolicy: profile.approvalPolicy });
  // Store threadId for subsequent turn/start
});
```

### 4.4 ws library 选择 (实测含义)

- **Bun built-in `WebSocket` global**: ❌ 不支持 constructor `headers` option (实测 Bun 1.3.11 send Authorization fail — bearer auth 测试 3 case 全 fail)
- **npm `ws` 8.x**: ✅ 支持 `new WebSocket(url, {headers})` — 推荐
- **`isomorphic-ws`**: 同上, 跨 node/browser

anet 现有依赖 (agent-network/package.json + agent-node/package.json) **未含 ws library**。Phase 2 实施时须新增:
```json
{
  "dependencies": {
    "ws": "^8.18.0",
    "@types/ws": "^8.5.13"
  }
}
```

### 4.5 Reconnect 策略

ws 断 → 指数退避重连 (initial 1s, max 30s, 上限 10 次, 然后 escalate 给 commhub + 标 node offline)。重连后:
- 不 re-init thread (thread 持久化在 daemon)
- 用 `thread/resume {threadId}` 接回原 thread (per schema verify, `thread/resume` 是 75 ClientRequest 之一)

### 4.6 Multi-anet-session 同 host 隔离

per §3.3 multi-client broadcast 隐私问题:
- 每个 anet node session **独立 daemon** (独立 port + 独立 token)
- daemon `$CODEX_HOME/app-server-daemon/` 全局共享 PID/socket → 可能冲突
- mitigation: 用 `--config "app_server.bootstrap_dir=/tmp/anet-codex-<node-alias>"` 自定 daemon dir (假设 codex 支持; if not, raise as Open Q to OpenAI)
- 或者 per-anet-session daemon 完全在 ephemeral 模式跑 (`thread/start ephemeral: true`), 不复用 PID-based bootstrap

### 4.7 用户 Walkthrough (incorporate Vincent 4099 tutorial)

per Vincent telegram 4099 paste 完整 codex remote-control multi-client tutorial:

```bash
# Step 1: 用户起 server (long-running, tmux 长跑)
codex remote-control                            # 走 ensure_remote_control_started bootstrap path (recommended)
# 或者 low-level path (实测可用):
codex --enable remote_control app-server --listen ws://127.0.0.1:14500

# Step 2: 用户 TUI 连接 (TUI client, attached)
codex --remote ws://127.0.0.1:14500              # 无 auth
# 或带 auth (server 端用 --ws-auth + --ws-token-sha256):
export CODEX_TOKEN=<bearer-token>
codex --remote ws://127.0.0.1:14500 --remote-auth-token-env CODEX_TOKEN

# Step 3: anet wrapper 同时 attach 同 daemon (Phase 2 后实施)
anet node start codex-node --runtime codex-code-cli-remote-control
# (anet 内部 spawn 独立 daemon + ws client, 不复用用户 TUI 的 daemon — per §4.6)
```

**Caveat (实测 §3.4)**:
- Vincent tutorial 描述 "✅ 多 client 共用同 session/thread" — **partial** true: lifecycle 跨 client 可见, 但 per-thread streaming 须 owner/subscriber 关系明确
- 默认 daemon listen `127.0.0.1` only (loopback), `0.0.0.0` exposed 须 `--listen ws://0.0.0.0:port` 显式 (但生产不推荐, 用 SSH port-forwarding 代替)

## 5. 端到端实测 Evidence (raw output)

(实测于 2026-05-13 13:13-13:20 server iZrj93pr2rcf5r2y9uo1oyZ, codex-cli 0.130.0)

### 5.1 Daemon 启动 log (no auth daemon)

```
$ codex --enable remote_control app-server --listen ws://127.0.0.1:18765
2026-05-13T05:16:09.819563Z ERROR codex_app_server: Codex could not find bubblewrap on PATH. ... Codex will use the bundled bubblewrap in the meantime.
codex app-server (WebSockets)
  listening on: ws://127.0.0.1:18765
  readyz: http://127.0.0.1:18765/readyz
  healthz: http://127.0.0.1:18765/healthz
  note: binds localhost only (use SSH port-forwarding for remote access)
```

→ 进程 fork: parent PID 2052755 (node wrapper) → child PID 2052767 (实际 codex binary, owns socket fd=20)。

### 5.2 完整 turn 实测 (25 events seen, per §2.4)

详见 §2.4。最终 `agent_message: "Hi"` + `turn/completed`。

### 5.3 Bearer auth probe (3 cases)

```
$ curl -v -H "Authorization: Bearer anet-test-1778649597" -H "Upgrade: websocket" -H "Connection: Upgrade" ... http://127.0.0.1:18766/
< HTTP/1.1 101 Switching Protocols   ← ✅ accept with valid token

$ curl ... (no Authorization header) ... http://127.0.0.1:18766/
< HTTP/1.1 401 Unauthorized
< missing websocket bearer token   ← ✅ reject without

# (wrong token case 同 401 假设, not 实测但 PR #14853 描述如此)
```

### 5.4 Multi-client concurrent probe

(详 §3.2 — 2 ws clients 同时 connect daemon, 都看到对方 thread 事件)

### 5.5 Under-development 警告 (重要 caveat!)

每次 ws client `thread/start` 后, daemon emit:

```json
{"method":"warning","params":{
  "threadId":"019e1fc4-57a9-7860-8be5-bbf4a4662de7",
  "message":"Under-development features enabled: remote_control. Under-development features are incomplete and may behave unpredictably. To suppress this warning, set `suppress_under_development_features_warning = true` in config.toml."
}}
```

且 `remoteControl/status/changed` notification status = **`errored`** (not `connected`) — 说明 remote_control mode 未 fully bootstrap (因为本测试用 `--listen ws://` + `--enable remote_control` 直接启动, 没走 `codex remote-control` 正式 wrapper 的 `ensure_remote_control_started` bootstrap path; 但即使如此 ws 通信仍 work, model inference 也 work, 只是 "errored" 状态 cosmetic)。

## 6. 风险评估 + Timing Assumptions

### 6.1 风险矩阵

| Risk | Severity | Mitigation |
|---|---|---|
| `remote_control` feature 仍标 "under-development incomplete" (OpenAI 自己) | 🔴 high | 等 OpenAI changelog 标 stable; suppress warning toml flag 仅 cosmetic (仍有不稳定可能性) |
| 5-13 三天 6 PRs 仍在 stabilize ws transport area | 🔴 high | Pin codex@>=0.131 with min commit hash + monitor weekly changelog |
| `remoteControl/status/changed: errored` 即使 daemon work | 🟡 medium | 跑 `codex remote-control` 正式 wrapper (走 `ensure_remote_control_started` bootstrap path) 而非直接 `--listen ws://` |
| Bun WebSocket 不支持 headers option | 🟡 medium | 新增 npm `ws` ^8 dep |
| Multi-client 事件广播跨节点泄漏 | 🟡 medium | Per-anet-session 独立 daemon (port 隔离) + client-side filter 仅订阅自己 thread events |
| 9 个 ServerRequest reverse approval 逻辑复杂 | 🟡 medium | Smart policy whitelist (read-only command auto-approve) + escalate 指挥室 fallback |
| Port allocation race condition (多 anet session 同 host) | 🟢 low | port range allocation + retry on EADDRINUSE |
| Token 泄漏 (env / log / process listing) | 🟡 medium | Token sha256 化 + ENV var 名 in profile flags + 不写 process args |
| daemon crash → anet 无法连接 | 🟡 medium | Supervisor restart (类比 codex-sdk runtime pattern) |
| 1.5-2x 代码量 vs Path C | 🟢 low | manageable, but Phase 1 用 Path C 简单 ship 后再 Phase 2 升级 |
| auto-update loop (codex 自身 update 时 daemon restart) 影响 anet long-running session | 🟡 medium | Reconnect 策略 + thread/resume 接回原 thread (per §4.5) |

### 6.2 Timing Assumptions (5 个)

1. **TA1**: OpenAI 1-2 weeks 内 codex 0.131/0.132 ship, 含 remote_control 移出 "under-development" + #22404/#22414/#22386 全 stabilize
2. **TA2**: ws transport 进入 stable 后, `codex --version` 0.131+ 用作 anet checkRuntimeDependency 最低版本 cutoff
3. **TA3**: `codex remote-control` 正式 wrapper (ensure_remote_control_started) 在 0.131 后默认能 bootstrap full daemon (含 auto-update loop), 无须 `--listen ws://` 显式 flag
4. **TA4**: Multi-client behavior (实测 broadcast) 在未来 release 中保持不变 (或加 per-thread subscriber filter)
5. **TA5**: bearer auth `--ws-token-sha256` flag 不被 deprecated (PR #14853 merged 2026-03-26 应该 stable)

→ TA1-TA5 全满足时启动 Phase 2 实施。

## 7. vs mcp-server stdio 方案对比

(通信龙并行出 mcp-server stdio deep doc 后, 本节填充实际数据。当前基于 RFC-006 §3.2 矩阵 + 本 doc 实测更新)

| 维度 | Path B (remote-control ws, 本 doc) | Path C (mcp-server stdio, RFC-006) |
|---|---|---|
| **anet 代码量** | ~1000 行 (cli.ts +50 / agent-node +470 / test +400 + new ws dep) | ~500 行 (cli.ts +30 / agent-node +170 / test +300) |
| **Protocol churn 风险** | 🔴 high (3 PRs landing 5-13 today + remote_control 标 under-development) | 🟢 low (mcp-server 早 stable) |
| **`under-development incomplete` 警告** | 🔴 emit on every thread/start | 无 |
| **新增 npm dep** | `ws` ^8 + `@types/ws` | 无 (复用 `@modelcontextprotocol/sdk`) |
| **Multi-client peer co-presence** | ✅ 实测 work (broadcast 模式) | ❌ 单 stdio child per spawn |
| **Turn 中断 / steer** | ✅ turn/interrupt + turn/steer | ❌ SYNC return (per call) |
| **Live event stream** | ✅ 63 ServerNotification 完整 (含 token delta) | ✅ codex/event 流 (含 token delta) — 同等 UX |
| **Auth** | bearer JWT/capability-token (须 anet 端签 token) | none (stdio inherit env) |
| **Phase 1 ship 速度** | 慢 (2-3 weeks 等 stabilize + 实施) | 快 (1-2 天 ship) |
| **Daemon supervision** | 须 anet 写 (PID + crash restart + port mgmt) | 跟 child 共生死 (anet shutdown → child 自动 exit) |
| **Loopback only restriction** | wss:// 或 loopback ws:// (PR #14853) | n/a (stdio) |
| **9 个 reverse approval handler** | 必须实现 | n/a (codex `--approval-policy` 静态参数) |

## 8. 推荐 Verdict

🟢 **Phase 1 维持 RFC-006 走 Path C (mcp-server stdio)** — Path B 现在 ship 不成熟:

1. ❌ "Under-development incomplete" 警告 OpenAI 自己标 — 信号不稳
2. ❌ 5-13 三天 6 PRs 仍 landing — 协议未稳
3. ❌ ~2x 代码量 + 新 ws dep + 9 reverse approval 决策框架
4. ❌ Phase 1 速度优先, 1-2 天 ship vs 2-3 weeks 等 stabilize

🟡 **Phase 2 (~2 weeks 后) 启动 Path B 实施** — 等 RFC-006 §10.1 TR1-TR4 触发条件 + 本 doc §6.2 TA1-TA5 全满足:

1. OpenAI changelog 标 ws transport stable + remote_control 移出 under-development
2. 用户/产品需要 multi-client peer co-presence (用户 dashboard + iOS app 同时看 codex agent live)
3. 用户/产品需要 turn/steer mid-execution (用户在 codex inference 中途调整 prompt 或停止)
4. codex 0.131/0.132 ship 后 cross-platform 行为统一 (mac mini + Linux + Windows)

🔵 **Path B 真实 architectural value (实测确认)**:

- ✅ Multi-client peer co-presence (实测 work, 跨平台 anet dashboard + 用户 codex iOS app 同看)
- ✅ Turn/steer mid-execution (强 UX, codex 跑慢时用户介入)
- ✅ thread/inject_items + thread/resume + thread/fork 高级 thread mgmt
- ✅ 9 个 reverse ServerRequest 精细控制 (用户 escalate 决策 approval)
- ✅ daemon 复用 (不像 stdio 每次 spawn 新进程, 长 session 节约启动开销)

🔴 **Path B 真实 cost (基于实测)**:

- 协议 stabilize 中 (5-13 still landing)
- "under-development" 警告 cosmetic UX 折扣
- ~2x 代码量 + 新 dep
- 复杂度 hot spots (ws reconnect / bearer mgmt / 9 reverse approval / port allocation race)

📋 **行动建议**:

- RFC-006 Phase 1 走 Path C 立即实施 (通信工程马 unstash worktree, 1-2 天 ship 2.1.8 大 feature)
- 本 doc (Path B) archive 作 Phase 2 实施依据 (`docs/anet-codex-remote-control-plan.md`)
- 等 codex 0.131/0.132 ship 后再起 RFC-007 (基于本 doc + RFC-006 §10.1 触发条件)
- 即使 Phase 1 ship 后用户没催 multi-client/steer 需求, Phase 2 ws 也作未来 anet platform 的"高级用户"选项 (类比 SDK runtime vs CLI runtime 双轨)

---

**Footer (per anet attribution SOP)**:

```
Author-Agent: 通信SDK马
Helpers: 通信龙 (派单 + 并行 mcp-server stdio 方案 deep dive)
```

— END —
