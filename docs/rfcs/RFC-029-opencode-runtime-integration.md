# RFC-029: opencode runtime 集成 (scoping)

| 项 | 值 |
|----|----|
| **作者** | 通信工程马 |
| **状态** | v0.3 — **Vincent 拍板 D2 track = ① 直接一步 B1'** (常驻 ACP), 实施启动. Phase 0b U1/U3/U5/U8 探针全出 (`docs/analysis/rfc029-opencode-probe/summary.md`), ACP shim 净估 ~15-25 LOC, opencode-ai@`1.17.13` pin. 分 ~3 PR (① runtime 注册 → ② ACP shim + supervisor → ③ vendor preset + wizard hint + docs). (历史: v0.2 通信龙 v0.1 review PASS+merged PR #369) |
| **调度** | 通信龙 dispatch task_id `418d0521-0148-452a-9f5a-70ed13f195e3` (HIGH, Vincent 要求) |
| **创建** | 2026-07-01 (北京 UTC+8) |
| **关联 RFC** | [RFC-021](RFC-021-acp-capability-profile-expansion.md) (ACP capability 扩展 — grok-build-acp precedent) · [RFC-006 (project memory)](../../.claude/memory/) codex-code-cli-mcp runtime 类似 track |
| **红线** | 只做**公版 [sst/opencode](https://github.com/sst/opencode)**, 不引入任何非公开分支/fork 概念, 不在公开仓提任何私有对应物 |
| **依据** | 公版 opencode 官方文档 (`opencode.ai/docs`), 现有 4 runtime adapter 代码链 (agent-node/src/cli.ts + agent-network/bin/cli.ts + server/src/index.ts) |

---

## 摘要

给 anet 加**第 5 种 runtime**: 公版 `sst/opencode` CLI, 跟现有 `claude-code-cli` / `codex-sdk` / `claude-agent-sdk` / `grok-build-acp` 并列一档。用户可以在 `anet init node` 时选 `opencode-cli` runtime, 节点跑起来后走 `opencode` 后端做 think(), 但对 CommHub 网络 (send_task / report_status 等) 的接入语义跟其他 runtime 完全一致。

**关键调研结论**: 公版 opencode 完全可 spawn 集成, 不是 TUI-only。有两条一等程序化入口:
1. **`opencode run "..."`** — 一次性 (one-shot), 支持 `-s <id>` session resume, `--format json` 事件流输出
2. **`opencode serve`** — 常驻 HTTP server (默认 `127.0.0.1:4096`), 提供 OpenAPI + POST /session / POST /session/:id/message / GET /session/:id/message (SSE), 支持 `opencode run --attach` 连过来复用

session/model 都是一等公民, 多 vendor (Anthropic / OpenAI / Bedrock / Gemini), auth 走 env + 配置文件, 有 MCP 客户端能力 (可挂 CommHub MCP server).

**推荐**: Track B (类 grok-build-acp), 起 `opencode serve` 常驻, HTTP client 打 `/session/:id/message` + SSE 事件流。**总工时估 12-18h**, 主要不确定性在 (a) `--format json` 事件 schema 抽 final assistant text 的稳定形状 (b) MCP inject 具体机制 (c) 首启 `opencode auth login` 流程能否 headless 走 env-var 绕过.

---

## 1. 背景

Vincent 明确要求 anet 支持 opencode runtime. 当前 4 runtime:

| runtime 名 | 集成 track | 大致语义 |
|---|---|---|
| `claude-agent-sdk` | 进程内 SDK (dynamic import) | `@anthropic-ai/claude-agent-sdk` `query()` 异步 generator |
| `codex-sdk` (default) | 进程内 SDK | `@openai/codex-sdk` `Codex.startThread()` / `runStreamed()` |
| `codex-sdk` (stdio opt-in) | subprocess spawn JSON-RPC | `spawn("codex", ["app-server"])` line-delimited JSON-RPC |
| `grok-build-acp` | subprocess spawn JSON-RPC (ACP) | `spawn("grok", ["agent","stdio"])` Zed ACP 协议 |
| `claude-code-cli` | interactive subprocess (TTY) | `spawn("claude", claudeArgs, {stdio:"inherit"})`, 完全走 MCP stdio |

opencode 作为多 vendor 前端 (统一 UI + session + multi-provider auth 抽象), 让 anet 用户能"一个 runtime + 任意 vendor"的组合空间显著扩大.

---

## 2. 公版 opencode 编程接口调研

### 2.1 headless 入口

**`opencode run [message]`** — 一次性调用. 关键 flag:

```
-m, --model <provider/model>  # 必须 provider/model 形式, e.g. anthropic/claude-sonnet-4-5
-s, --session <id>            # resume 指定 session
-c, --continue                # 继续最近一次 session
--fork                        # 在 continue 时分叉
-f, --file <path>             # 附件
--format default|json         # json = 结构化事件流 (stdout)
--agent <name>
--attach <url>                # 连接已跑的 opencode serve, 复用 session/model
--title, --share, --thinking, --auto, --dir, --port, --variant
```

Source: [opencode.ai/docs/cli](https://opencode.ai/docs/cli/), 社区实证 skill wrapper [SpillwaveSolutions/opencode_cli](https://github.com/spillwavesolutions/opencode_cli).

**未知项**: stdin-fed prompt 的支持形状 (docs 未明确); `--format json` 事件的 exact schema (final text 抽取路径) — **需活体探针验证**.

### 2.2 常驻 server 入口

**`opencode serve`** — 长连 HTTP server, 默认 `127.0.0.1:4096`, `/doc` 有 OpenAPI. 端点:

| method | path | 用途 |
|---|---|---|
| POST | `/session` | 创建 session, 返 Session 对象 |
| POST | `/session/:id/message` | 同步发消息, 返 `{ info: Message, parts: Part[] }` |
| POST | `/session/:id/prompt_async` | 异步 fire-and-forget (204) |
| GET | `/session/:id/message` | SSE 流, event/data 行分隔 |
| GET | `/global/event` | 全局 SSE |

**认证**: `OPENCODE_SERVER_PASSWORD` (+ `OPENCODE_SERVER_USERNAME` 默认 `opencode`).
**Flags**: `--port --hostname --mdns --cors`.

`opencode run --attach http://localhost:4096 "..."` 让客户端打已跑的 serve — 避免每 turn 冷启动成本, **官方推荐做常驻集成的模式**.

Source: [opencode.ai/docs/server](https://opencode.ai/docs/server/).

### 2.3 session / continuation

**一等 session 模型**. `-s <id>` resume, `-c` continue, `--fork` 分叉. Session 持久化到磁盘 SQLite (`opencode db path` 子命令). `opencode session list|delete` 管理. 每次 `POST /session` 返回 session id, 父进程存下下次带回.

### 2.4 auth / model config

- 配置文件: `~/.config/opencode/opencode.json` (global) 或 `./opencode.json` (project), 也可 `OPENCODE_CONFIG` env 覆盖
- Env keys: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, Bedrock (`AWS_REGION` / `AWS_PROFILE` / `AWS_BEARER_TOKEN_BEDROCK`)
- 交互登录: `opencode auth login -p <provider>` — **未知是否可完全 env-var 绕过 headless 首启**, 需实测
- Model: `-m anthropic/claude-sonnet-4-5` (provider/model 强制形式)
- 支持 vendor: Anthropic / OpenAI / Bedrock / Gemini + 生态文档提 GitHub Copilot 等

Source: [opencode.ai/docs/config](https://opencode.ai/docs/config/).

### 2.5 MCP 面 ✅ v0.2 Phase 0 U2 已验

**docker + `opencode-ai@1.17.12` + `opencode serve --help` 抓取结果 (2026-07-01)**:

```
opencode serve
starts a headless opencode server

Options:
  --port         port to listen on              [number] [default: 0]
  --hostname     hostname to listen on          [string] [default: "127.0.0.1"]
  --mdns         enable mDNS service discovery
  --cors         additional domains to allow for CORS
```

**确认**: `serve` 命令**无任何 MCP 相关运行时 flag** — 没有 `--mcp` / `--mcp-server` / `--mcp-config` 等. **MCP 挂载必须通过配置文件预置**, 即写到 `~/.config/opencode/opencode.json` (或 `OPENCODE_CONFIG` env 覆盖) 的 `mcp:` 段, 然后 `serve` 起来后自动 load.

含义:
- anet 起 `opencode serve/acp` 前必须**先写 opencode 配置文件**, 里面挂 CommHub MCP server
- 每 node 独立配置根 (`HOME=<node workdir>` 或 `OPENCODE_CONFIG=<node workdir>/opencode.json`) 是**必须**的多节点隔离手段, 不是可选 nice-to-have
- 反过来说好处: 配置文件路径是 anet 完全掌控的一等接口, 无 runtime flag 变动风险 (opencode 版本升级只要不改 config schema, MCP 挂载语义就稳)

opencode 依然是 MCP **客户端** (`opencode mcp add|list|auth`, [docs/mcp-servers](https://opencode.ai/docs/mcp-servers/)). 支持连 stdio/http/sse 三类 MCP server. CommHub MCP server 挂进去后, opencode 侧 agent 就有 `send_task`/`report_status`/`commhub_reply` 等工具.

opencode **自己不作为 MCP server** 暴露 (第三方桥 [AlaeddineMessadi/opencode-mcp](https://github.com/AlaeddineMessadi/opencode-mcp) 存在但非一等).

**附带发现** (`opencode --help` 抓): opencode 有一等 `opencode session`, `opencode models [provider]`, `opencode providers` (旧名 `auth`), `opencode export/import`, `opencode db` 等丰富子命令 — 这些为 D3 (vendor preset), D5 (session 隔离), Phase 3 (完善) 提供了程序化入口.

### 2.6 近期上游改动 (~25 commits 内)

大部分是 desktop v2 / TUI 打磨. runtime 相关:
- `fix(provider)`: force openai reasoning variants
- `fix(core)`: stop replaying stale GitHub Copilot Responses item IDs
- 模型刷新 (Sonnet 5 等)

**无** headless 相关 breaking. npm 最新 `opencode-ai@1.17.12` (2026-07-01 前 ~17h).

### 2.7 `acp` 子命令 ✅ v0.2 Phase 0 U4 已验

**docker + `opencode-ai@1.17.12` + `opencode acp --help` 抓取结果 (2026-07-01)**:

```
opencode acp
start ACP (Agent Client Protocol) server

Options:
  --port         port to listen on               [number] [default: 0]
  --hostname     hostname to listen on          [string] [default: "127.0.0.1"]
  --mdns         enable mDNS service discovery
  --cors         additional domains to allow for CORS
  --cwd          working directory              [string] [default: "/"]
```

**确认**: opencode `acp` 是**一等 Agent Client Protocol server** — Zed 生态 ACP 协议. 跟 anet 现有 `grok-build-acp` 走的**同一套协议**.

**重大发现 — B1 工时上限可显著砍**:
- grok 是 `spawn("grok", ["agent", "stdio"])` — stdio 上跑 JSON-RPC ACP
- opencode 是 `opencode acp --port <N>` — **TCP 端口**上跑 ACP (不是 stdio)
- 协议消息格式 (initialize / session/new / prompt / etc.) **应可直接复用** `runtime/grok-build-acp/{client.ts, events.ts, runtime.ts}` — 只 transport 层 (stdio 换 TCP socket) 需要一个薄适配
- `--cwd` flag 一等支持 → 天然满足 D5 每 node 独立 cwd 隔离需求 (不需要 grok-isolated-cwd.ts 那种 workaround)

**工时下调**: B1 从原估 15-21h → **10-14h** (省掉 HTTP client + SSE 事件解析 + `POST /session/:id/message` 的自制协议对接, 直接复用 grok-build-acp 抽象)

**新方案 B1' (推荐取代 B1)** — 见 §4 更新.

---

## 3. anet runtime adapter 层现状

### 3.1 5 处 registry 需要扩展

要加 `opencode-cli`, 以下 5 处代码要动:

1. **`agent-network/bin/cli.ts:366`** — 类型 + normalize
   ```ts
   type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk" | "grok-build-acp";
   function normalizeRuntime(profileOrRuntime?): RuntimeName { ... }
   ```
2. **`agent-network/bin/cli.ts:844-864`** — 交互 wizard `checkbox<RuntimeName>` picker
3. **`agent-network/bin/cli.ts:1573-1657`** — `VendorSpec[]` 表 (per-vendor auth / model / env preset)
4. **`agent-node/src/cli.ts:278-284`** — 内部 3 值 collapse
   ```ts
   const RUNTIME_MAP: Record<string, string> = {
     "claude-agent-sdk": "claude", "codex-sdk": "codex", "grok-build-acp": "grok", ...
   };
   const RUNTIME = (RUNTIME_MAP[rawRuntime] || "claude") as "claude" | "codex" | "grok";
   ```
5. **`server/src/index.ts:161-168`** `normalizeRuntime()` — dashboard badge 用

### 3.2 两条集成 track

现有 4 runtime 分两 track:

**Track A** (类 `claude-code-cli`) — agent-network 侧 spawn 交互 TTY, 完全经 MCP 中转
- **零** `agent-node/src/cli.ts` 代码
- `agent-network/bin/cli.ts:2610` 直接 `spawn("claude", args, {stdio:"inherit"})`
- CommHub 接入靠 `agent-network/src/node-server.ts` MCP stdio bridge
- session 是 `randomUUID()` 预生成 + `--session-id <uuid>` / `--resume <uuid>`

**Track B** (类 `grok-build-acp` / `codex-stdio`) — agent-node 侧 `processWithX(task, from, images)` handler
- 加 `processWithOpencode` (~150-250 LOC) 在 `agent-node/src/cli.ts` 或独立 `runtime/opencode/` 子目录
- 若 opencode 支持 JSON-RPC/ACP stdio → 复用 `runtime/grok-build-acp/{client.ts,runtime.ts,events.ts}` 抽象
- 若 opencode 只有 HTTP → 独立 `runtime/opencode/http-client.ts` (更简单)
- CommHub 接入 3 选 1:
  - **HTTP MCP inject** (类 grok, 若 opencode serve 启动时能带 MCP config)
  - **stdio MCP** (类 codex, 走 `~/.config/opencode/opencode.json` mcp 段)
  - **in-process SDK MCP** (类 claude-agent-sdk, 需 opencode 有 JS SDK, 目前 opencode 只有 CLI + HTTP server, 不适合)

### 3.3 session 持久化模式

anet 现有 4 种 session 写回模式:
| runtime | 字段 | 触发点 |
|---|---|---|
| claude-agent-sdk | `cfg.session` | SDK `system.init` message |
| codex-sdk | `cfg.session` | 每次 turn 完 `codexThread.id` |
| codex-stdio | `cfg.session` | `thread/start` 回复后 |
| grok-build-acp | `cfg.grokSession` (独立字段!) | `onSession` callback |
| claude-code-cli | `cfg.session` = 预生成 uuid | create 时 |

opencode session 若跟 anet 其他 session 语义不同 (opencode 有 `--fork` 概念), 建议**独立字段** `cfg.opencodeSession` 复用 grok 的 precedent.

---

## 4. 集成方案对比

三个方向, 按推荐度排:

### 方案 B1' (v0.2 新推荐): 常驻 `opencode acp` + 复用 grok-build-acp 抽象

**v0.2 Phase 0 U4 探针后新增**. 直接跑 `opencode acp --port <随机> --hostname 127.0.0.1 --cwd <node workdir>` 起 ACP TCP server, agent-node 侧新增一个薄 TCP transport 适配 (~50-100 LOC) 复用 `runtime/grok-build-acp/{client.ts, events.ts, runtime.ts}` — 因为 opencode acp 跟 grok agent stdio 走**同一 Agent Client Protocol 协议消息格式**.

**优点**:
- **协议层零重写**: initialize / session/new / prompt / turn 全靠 grok-build-acp 现成抽象, 只 transport 换 stdio → TCP socket
- `--cwd` 一等支持 → 天然多节点隔离, 免掉 grok-isolated-cwd.ts 那类 workaround
- session/model/vendor 全走 opencode 自己一等抽象
- MCP inject 通过 `OPENCODE_CONFIG=<node workdir>/opencode.json` 预写配置文件 (类 codex ~/.codex/config.toml precedent)

**风险**:
- opencode acp 消息 schema 跟 grok acp 是否 byte-exact 未验 (虽同协议但 opencode 可能有 vendor extension) — **需 U8 补验** (打通 ACP client 后一次真 turn, 拿到实际消息 dump)
- opencode acp 是 TCP 不是 stdio, supervisor 重启语义 (端口重绑 / socket 断连恢复) 需要 supervise-child + 端口 free 检测
- `opencode acp` 首次运行是否需要 opencode auth 前置 (跟 U3 同一未知) 未验

**工时 (细拆)**:
- opencode acp 子进程管理 (spawn + supervise + shutdown, 复用 supervise-child): **2h**
- TCP transport 薄适配 (类 grok-build-acp/client.ts 但走 net.Socket 而非 stdio 管道): **2-3h**
- 复用 grok-build-acp {events.ts, runtime.ts} 到 opencode 路径: **1h** (基本 import 换 path)
- session 写回 (cfg.opencodeSession) + turn 循环整合: **1h**
- `agent-node/src/cli.ts` runtime switch + `RUNTIME_MAP` + processWithOpencode: **1h**
- `agent-network/bin/cli.ts` enum + wizard + VendorSpec + checkRuntimeDependency + assertStartCompatibility: **2h**
- CommHub MCP inject (写 opencode.json config 文件 + `OPENCODE_CONFIG` env): **1-2h**
- server-side normalizeRuntime + dashboard badge: **0.5h**
- 单测 (TCP client + session writeback + ACP message parse): **2h**
- docker e2e (spawn opencode acp + real turn + MCP inject + real session resume): **2h**
- 独立 claude 预审 + fix round: **1-2h**

**总计**: **10.5-15.5h**, 折中值 **~13h** (相比 v0.1 B1 的 18h 省 5h)

### 方案 B1 (v0.1 原推荐, 保留作 fallback): 常驻 opencode serve + HTTP client (类 grok-build-acp)

**保留在 RFC 里做 U8 探针万一失败的 fallback**. 若 U8 打通 ACP transport 发现 opencode acp 消息 schema 跟 grok 严重不兼容, 就退回 B1 用 `POST /session/:id/message` + SSE 自制协议对接. 详细描述看 v0.1 (git blame `origin/main` 前一版本).

启动: agent-node 首次 process 前起 `opencode serve --port <随机> --hostname 127.0.0.1`, 存 pid + port 到 `.anet/nodes/<alias>/.opencode-serve.pid`. 后续每 turn:
1. `POST /session` (首次) → `sessionId`, 写回 `cfg.opencodeSession`
2. `POST /session/:id/message` with prompt
3. `GET /session/:id/message` SSE 拉事件流, 抽 final assistant text
4. 返回 text 给 CommHub

**优点**:
- 官方推荐的持久集成模式
- SSE 事件流是稳定 API 而不是 CLI stdout 解析
- session/continuation/fork 全一等
- 冷启动只 1 次 (每 node 一个 serve 进程)
- MCP 可以在 serve 启动前通过 `~/.config/opencode/opencode.json` 或 `OPENCODE_CONFIG` 挂

**风险**:
- 需要管理 opencode serve 子进程生命周期 (启/停/崩溃重启), 但 anet 已有 `superviseChild` 抽象可复用
- 端口冲突可能, 但用随机高位端口可解
- opencode auth 首启若真非 headless, 每台新机器要手动 login 一次 (可通过 env-var 提前设 `ANTHROPIC_API_KEY` 等绕过, 需实测)

**工时** (细拆):
- serve 生命周期管理 (spawn + supervise + shutdown): **3-4h**
- HTTP client (POST /session, POST /message, SSE parse): **2-3h**
- session 写回 (cfg.opencodeSession) + turn 循环整合: **1-2h**
- `agent-node/src/cli.ts` runtime switch + `RUNTIME_MAP` + processWithOpencode: **1h**
- `agent-network/bin/cli.ts` enum + wizard + VendorSpec + checkRuntimeDependency + assertStartCompatibility: **2h**
- CommHub MCP inject (走 opencode 配置文件): **1-2h**
- server-side normalizeRuntime + dashboard badge: **0.5h**
- 单测 (HTTP client + session writeback + SSE parse): **2h**
- docker e2e (spawn opencode serve + real turn + real session resume): **2-3h**
- 独立 claude 预审 + fix round: **1-2h**

**总计**: **15.5-21.5h**, 折中值 **~18h**

### 方案 B2: 每 turn 冷起 `opencode run --format json` (类 codex-stdio 但更笨)

每次收到 task → `spawn("opencode", ["run", "-s", sessionId, "-m", model, "--format", "json", task])` → 收集 stdout JSON 事件 → 抽 final text → 写回 session id.

**优点**:
- 实现最简 (~5-8h 总工时), spawn+read stdout+parse+exit 就完事
- 无进程管理复杂度
- 每 turn 完全隔离, 一台机器 die 不影响其他 node

**风险**:
- 每 turn 冷启动成本 (opencode + SDK 初始化 + auth check), 实测 1-3s per turn, 高频短对话下不友好
- `--format json` 事件 schema 未公开明确, 抽 final text 靠 heuristic, 上游改可能挂
- MCP inject 每 turn 都要走一遍 opencode config load, 性能次
- 无法长连保状态, 大 session 每次重新 hydrate

**工时**: 5-8h, 折中 **~7h**

**适用**: 如果 Vincent 要求"最快见到能跑" 的 MVP, 可以 B2 先行, B1 后续 upgrade.

### 方案 A: 类 claude-code-cli, spawn 交互 TTY

`agent-network/bin/cli.ts` 直接 `spawn("opencode", [...], {stdio:"inherit"})`, 让 opencode 接管终端, 走 `.anet/node-server.js` MCP stdio 中转 CommHub. session 靠 opencode 自己管.

**优点**:
- agent-node 零改动
- opencode UI 保真 (用户能看到原生 TUI)

**风险**:
- 需要 opencode `--session-id` 或类似 flag 支持外部 uuid 注入 (未知是否支持, 需实测)
- 需要 opencode 支持从命令行注入 MCP server 或走配置文件 (前一节已确认有)
- 交互式 TTY + agent-node 后台任务派发到 opencode 的桥接: 每收到 CommHub task 时如何 "输入" 给 opencode? — 走 `.anet/node-server.js` MCP 让 opencode-agent 主动 poll_inbox? claude-code-cli 就是这个模式, 但那需要 opencode 侧 agent 明白 "我要循环 poll_inbox" — 需要 prompt engineering
- 断连恢复复杂

**工时**: 3-5h (agent-network 侧改动为主), 但**运行时可靠性打问号**

**适用**: 如果只想让本地用户能用 opencode UI 玩 CommHub, 不需要 headless 无人值守

### 方案对比

| 项 | B1 (常驻 serve) | B2 (每 turn 冷起) | A (交互 TTY) |
|---|---|---|---|
| 工时 | 15-21h | 5-8h | 3-5h |
| 每 turn 延迟 | ~200ms | 1-3s | 交互 |
| 24/7 无人值守 | ✅ | ✅ | ⚠️ (TTY 断开) |
| MCP 稳定 | ✅ | ⚠️ (每次 load) | ✅ |
| 上游 breaking 抗性 | ✅ (HTTP schema 稳) | ⚠️ (JSON stdout 事件不稳) | ⚠️ (TTY flag) |
| session 一等 | ✅ | ✅ | ⚠️ (uuid 注入未验) |
| 用户能看 opencode UI | ❌ | ❌ | ✅ |

**推荐**: B1 做长期方案, 若 Vincent 明确要求"最快能跑"可以 B2 先行 MVP, 后续再升 B1. 方案 A 只做为"用户想手动跟 opencode 交互 + 顺便挂 CommHub" 的可选 track, 不作主推.

---

## 5. 关键未知项 (Phase 0b 探针完 — 全 verified)

| # | 未知项 | 验证方法 | v0.3 状态 |
|---|---|---|---|
| U1 | `opencode run --format json` 事件 exact schema, 抽 final assistant text 的稳定 JSON path | fresh docker + `opencode run --format json "hi"` 抓 stdout | ✅ **verified** — JSONL, 事件 `type: step_start / text / step_finish` (snake_case), 每事件包 `{type, timestamp, sessionID, part}` envelope. Canonical `jq -r 'select(.type=="text")\|.part.text'`; usage 在 `step_finish.part.tokens`. 详见 `docs/analysis/rfc029-opencode-probe/u1-run-json.txt` |
| U2 | `opencode serve` MCP 挂载机制 (是运行时 flag 还是要 config 文件预置) | ~~读 docs + `opencode serve --help`~~ | ✅ **verified — 必须 config 文件预置**, 无 runtime flag |
| U3 | 首启 opencode 能否纯 env-var / auth.json 绕过 headless login prompt | fresh docker + env + `opencode run ...` 观察是否要求 login prompt | ✅ **verified — 可纯 env-var + 直写 `~/.local/share/opencode/auth.json` 绕过 headless prompt**. 🔴 但 opencode 内建 anthropic client **硬编码 `x-api-key`**, Bearer-only 兼容网关 (Kimi coding 等) 开箱 401 → 见 §8 D3 一等结论. 详见 `docs/analysis/rfc029-opencode-probe/u3-gate-report.txt` |
| U4 | opencode `acp` 子命令是否 Zed ACP, 若是可复用 `runtime/grok-build-acp` | ~~`opencode acp --help`~~ | ✅ **verified — 🔴 修正: opencode acp = stdio JSON-RPC 不是 TCP** (`--port`/`--hostname` v1.17.13 被忽略, 要 `spawn('opencode acp')` 走子进程 stdio). 跟 grok-build-acp 传输层同构, 之前 v0.2 打算的 TCP transport ~50-100 LOC adapter 不需要了 |
| U5 | `POST /session/:id/message` 同步返回 `parts: Part[]` 里 final assistant text 的 canonical path | 打真 opencode serve + curl 一次 | ✅ **verified** — `POST /session` → `POST /session/:id/message`, response `{info, parts[]}`, canonical `jq -r '.parts[]\|select(.type=="text")\|.text'`. ⚠️ U5 用 kebab-case `step-start/finish` vs U1 snake_case, REST fallback 用要归一化 |
| U6 | session 磁盘位置能否指定为 `.anet/nodes/<alias>/.opencode/` | 读 config docs + `opencode db path` | ✅ **verified — 有 `opencode db` 子命令 + `--cwd` flag + `OPENCODE_CONFIG` env**, 隔离手段齐全; §8 D5 已定 `HOME=<node workdir>` 强隔离 |
| U7 | opencode 是否支持 image 附件 | `opencode run --file <path>` 一等支持 | ✅ **verified — `-f/--file` flag 一等**, 每 turn 附件走 anet 现有 images[] 接 --file 参数 |
| U8 | opencode acp 消息 schema 跟 grok-build-acp/events.ts byte-exact 兼容度, 需多少 shim | `spawn('opencode acp')` 跑 initialize→session/new→session/prompt 真 turn, dump 消息对比 | ✅ **verified — 关键路径字节兼容**: 都 JSON-RPC 2.0 over stdio, 都 `method: "session/update"` 通知; `sessionUpdate: "agent_message_chunk"` + `content: {type:"text", text}` 字节一致. 差异: turn-end 信号 (opencode 用 `session/prompt` 响应带 `stopReason` vs grok 的 `_x.ai/…/prompt_complete` 通知) + opencode 多 `agent_thought_chunk`/`usage_update`/`available_commands_update`. **B1' shim 净估 ~15-25 LOC** (new `agent-node/src/runtime/opencode-acp/events.ts`, 继承 grok reducer 骨架). 详见 `docs/analysis/rfc029-opencode-probe/u8-acp.txt` |

**v0.3 状态 (Phase 0b 完, 工程马跑, opencode 免费 model 零 vendor key)**: U1/U3/U5/U8 全验完. 三个决定性结论:

1. **opencode acp = stdio JSON-RPC** (`--port`/`--hostname` v1.17.13 被忽略) — v0.2 打算的 TCP adapter 不需要, 直接 spawn 子进程走 stdio, 跟 grok-build-acp 传输层同构.
2. **ACP 关键路径字节兼容** — `session/update` + `agent_message_chunk` + `content:{type:"text",text}` 跟 `agent-node/src/runtime/grok-build-acp/events.ts` **零 diff**. 差异只在 turn-end 信号 + opencode 多 chunk 类型, 全是可控 branch swap. **B1' shim 净估 ~15-25 LOC**, 零风险项.
3. **Bearer-only vendor 门槛** — opencode 内建 anthropic client 硬编码 `x-api-key`, 只吃 Anthropic 原生格式; Bearer-only 兼容网关 (Kimi coding 等) 开箱 401. 起手 preset 用 Anthropic 原生 + OpenAI; Bearer vendor 支持走 opencode plugin 自控 auth path (实施期 backlog, 非 scoping blocker). 见 §8 D3.

**B1' 方案定** (工程马推荐, 通信龙 approve, Vincent D2=① 拍板): 走 ACP stdio 路径 — 原生流式无 cold-start (acp ~500ms 冷启 vs run ~2-3s 每 turn), 复用 grok-build-acp reducer 骨架, ~15-25 LOC shim. 真号 in `docs/analysis/rfc029-opencode-probe/{summary.md, u1-run-json.txt, u5-serve.txt, u8-acp.txt, u3-gate-report.txt}`. opencode-ai@`1.17.13` pin (上游迭代快, npm latest 每天动 — `assertStartCompatibility()` 硬锁 exact + `anet opencode upgrade-pin <version>` 显式升级命令带 e2e smoke, 见 §8 D6).

---

## 6. 风险

| # | 风险 | 缓解 |
|---|---|---|
| R1 | 上游 opencode 快速迭代 (每周多次 release), 集成靠的 CLI/HTTP surface 可能变 | pin `opencode-ai@<preview 时 exact version>` 到 `assertStartCompatibility()` (类 grok-build-acp precedent), 每次 npm bump 前手动 smoke |
| R2 | opencode serve 崩溃 → node 卡住 | 复用 anet 现有 `superviseChild` (agent-node/src/util/supervise-child.ts) 抽象, exponential backoff + markStable + 崩溃重启保留 session id (若 serve 持久化 session 到 SQLite 就能续) |
| R3 | 用户 auth 泄露 (opencode 全局 config 存 token) | 建议 anet 侧不去 mount / read `~/.config/opencode/`, opencode 自管 auth; agent-node 只通过 env 传 vendor key |
| R4 | 多 node 场景 `opencode serve` 端口冲突 / auth state 交叉污染 | 每 node 独立 `--port <random>` + `HOME=<node workdir>` env 隔离 opencode 配置根 (类 grok isolated cwd 的 precedent, `grok-isolated-cwd.ts`) |
| R5 | 走 MCP CommHub 时, opencode-agent 不理解 anet 的 `send_task` / `report_status` 语义 | 参考 claude-code-cli 的 developer_instructions 注入模式, 起 opencode-cli 时写一段 CommHub developer prompt 到 `~/.config/opencode/AGENTS.md` 或类似 |
| R6 | 命名冲突: `opencode-cli` vs `opencode-sdk` 未来 (opencode 若出 JS SDK) | 用 `opencode-cli` 命名保留 -sdk 后缀给未来 SDK 版; wizard hint 里写 "使用 opencode 命令行版" |

---

## 7. 实施顺序 (v0.3 — Vincent D2=① 直接 B1', 分 3 PR)

Phase 0a ✅ 完成 (v0.2 交付, ~1h): U2/U4/U6/U7 无 key 探针 → 打开 B1' 新方案 + 砍 5h 工时.
Phase 0b ✅ 完成 (v0.3 交付, ~2.5h): U1/U3/U5/U8 全验完 (`opencode/deepseek-v4-flash-free` 免费 model, 零 vendor key). ACP 字节兼容锁定, shim 净估 ~15-25 LOC.

以下 3 PR 顺序 ship, 每 PR 独立 review + docker e2e non-mock 复验:

### PR① — runtime 注册 (~2-3h)

作用面: 让 `opencode-cli` 出现在 `RuntimeName` union / wizard picker / VendorSpec 表 / assertStartCompatibility 版本 pin / launchAgent switch. 无实际 think() 能力, 但 CLI/wizard 走通 + `anet node create --runtime opencode-cli` 能存到 `config.json`.

具体 hook (§9 表精确定位):
- `agent-network/src/normalize-runtime.ts` — `RuntimeName` 加 `"opencode-cli"` 分支
- `agent-network/bin/cli.ts` — wizard picker + VendorSpec preset + `checkRuntimeDependency` + `assertStartCompatibility` (opencode 硬锁 `1.17.13`) + `launchAgent` runtime switch 加 opencode-cli 分支 (先 stub 报"not-yet-implemented" 明确错误 by design)
- `agent-node/src/cli.ts` — `RUNTIME_MAP` 加 `"opencode-cli": "opencode"`; `processTask` runtime switch 加 opencode 分支占位
- `server/src/index.ts` — `normalizeRuntime` 认 `agent-node:opencode` → `opencode-cli`

Docker e2e: `anet node create test-oc --runtime opencode-cli` 走通 + `anet node start test-oc` 明确报"opencode-acp not yet implemented (PR②)" 而不是崩. RuntimeName 单元测试 `opencode-cli` 分支加入.

### PR② — ACP shim + supervisor (~4-6h) — 核心真活

作用面: 让 `anet node start test-oc` 真跑起来做 think(). 

具体 hook:
- 新 `agent-node/src/runtime/opencode-acp/` 目录:
  - `events.ts` — reducer, ~15-25 LOC (继承 grok-build-acp reducer 骨架, turn-end 换 `session/prompt` 响应带 `stopReason`, 加 `agent_thought_chunk` / `usage_update` 分支)
  - `client.ts` — `spawn('opencode', ['acp'])` stdio JSON-RPC client (仿 codex-stdio-client / grok-build-acp client)
  - `runtime.ts` — think() entry, session state machine (initialize → session/new → session/prompt 循环)
- `agent-node/src/cli.ts` processTask 分支接 opencode-acp `runtime.ts`
- 复用 `agent-node/src/util/supervise-child.ts` 抽象 (类 grok-build-acp / feishu bridge)
- `HOME=<node workdir>` env 隔离 (per node 独立 opencode config root)

Docker e2e non-mock: 起独立 hub + `anet node start`, feed 一个真 task, 观察 IPC reply 是真 opencode text (走 `opencode/deepseek-v4-flash-free` 免费 model). pre/post 对比 (no reply / real reply) 贴 PR body.

### PR③ — vendor preset + wizard hint + docs (~2-3h)

作用面: 端 UX 完善.

具体 hook:
- `agent-network/bin/cli.ts` VendorSpec — 加 Anthropic 原生 + OpenAI 两 preset (per §8 D3), wizard 选完 vendor 自动写 `~/.local/share/opencode/auth.json` (via HOME 隔离到 node workdir)
- CommHub developer prompt 注入 (per §6 R5) — 起 opencode-cli 时写 `AGENTS.md` 到 node workdir 让 opencode agent 懂 anet 语义
- `anet opencode upgrade-pin <version>` 命令 (per §8 D6) — 显式升级带 e2e smoke, 输出 pass/fail 决定是否更新 `assertStartCompatibility()` 常量
- `docs-site/docs/guide/` 加 opencode-cli 使用文档

**总计到 3 PR ship 完**: ~8-12h (显著低于 v0.2 估的 ~19h, 因 Phase 0b 探针确认 ACP 传输层同构 + shim 极小).

**Bearer-only vendor plugin** (Kimi coding 等, §8 D3) — 实施期 backlog, 非 v0.3 scope. Anthropic + OpenAI preset 覆盖后再评估 plugin 优先级.

---

## 8. 决策点 (v0.3 — 全 locked)

| # | 决策 | 结论 |
|---|---|---|
| D1 | 是不是 B1 常驻方案作长期? | **[通信龙 定] 是** — 24/7 无人值守的数字员工军团是 anet 定位, 常驻 runtime 才配得上 |
| D2 | ① 直接 B1' 常驻 ACP vs ② 先 B2 MVP 抢 demo | **[Vincent 拍板] ① 直接 B1'** — Phase 0b 探针证明 ACP shim 仅 ~15-25 LOC 零风险, B2 冷启方案 (每 turn 2-3s bun 启动) 又笨又要额外 ~7h; MVP-first 性价比变低 |
| D3 | 起手 preset 哪几个 vendor? | **[通信龙 定, Vincent 认] Anthropic 原生 + OpenAI**. 🔴 v0.3 实测: opencode 内建 anthropic client 硬编码 `x-api-key`, 只吃 Anthropic 原生格式; Bearer-only 兼容网关 (Kimi coding 等) 开箱 401 → Bearer vendor 支持得写 opencode plugin 自控 auth path (实施期 backlog, 非 scoping blocker) |
| D4 | 命名: `opencode-cli` vs `opencode` | **[通信龙 定] `opencode-cli`** — 跟 claude-code-cli 对齐 -cli 后缀, 留 `opencode-sdk` 命名给未来 |
| D5 | opencode 全局配置能否 mount 隔离到 per-node? | **[通信龙 定] `HOME=<node workdir>` env 强隔离** — per node 独立 opencode config root (auth.json + opencode.json + session 缓存), 避免多节点相互污染. shared read-only cache mount (models catalog 3.9MB × N 节点) 记 backlog, 现在 disk × N 直连最简 |
| D6 | opencode-ai 版本 pin 策略 (上游每天动) | **[通信龙 定] 硬锁 exact v1.17.13** — `assertStartCompatibility()` spawn 前 `opencode --version` 抓字符串硬对比, 差一个字都 clear-error 拒 + 提示 `anet opencode upgrade-pin <version>` 命令; 不 tolerate patch drift (pre-1.0 churn 不可信), 跟 grok-build-acp R1 precedent 一致. 升级命令带 e2e smoke, smoke 过才更新 `assertStartCompatibility` 常量 |

---

## 9. 附录: 关键代码定位表 (实施时 quick jump; 行号 refresh at v0.3)

| 需要动的地方 | 文件路径 | 行号 |
|---|---|---|
| `RuntimeName` union + `normalizeRuntime` + `DEFAULT_RUNTIME` | `agent-network/src/normalize-runtime.ts` | 14-57 |
| wizard runtime picker (interactive choices) | `agent-network/bin/cli.ts` | 1957 (create wizard) / 2149 (batch) |
| VendorSpec 表 (`VENDORS: Vendor[]`) | `agent-network/bin/cli.ts` | 1701+ |
| `checkRuntimeDependency` | `agent-network/bin/cli.ts` | 975 |
| `assertStartCompatibility` (add opencode-cli version pin) | `agent-network/bin/cli.ts` | 931 |
| `launchAgent` runtime switch | `agent-network/bin/cli.ts` | 2643 |
| `RUNTIME_MAP` | `agent-node/src/cli.ts` | 326 |
| `processTask` runtime switch | `agent-node/src/cli.ts` | grep `RUNTIME ===` |
| `writebackSession` pattern | `agent-node/src/cli.ts` | search `writebackSession` |
| `createCommhubSdkMcpServer` | `agent-node/src/commhub-mcp.ts` | 整文件 |
| grok-build-acp 模板 (reducer + client + runtime) | `agent-node/src/runtime/grok-build-acp/` | 整目录 (events.ts 是 shim 起点) |
| codex-stdio-client 参考 | `agent-node/src/runtime/codex-stdio-client.ts` | 整文件 |
| `superviseChild` 抽象 (crash restart + backoff) | `agent-node/src/util/supervise-child.ts` | 整文件 |
| server `normalizeRuntime` (recognize `agent-node:opencode`) | `server/src/index.ts` | 170 |

---

## 10. 参考

- [opencode CLI docs](https://opencode.ai/docs/cli/)
- [opencode server docs](https://opencode.ai/docs/server/)
- [opencode config docs](https://opencode.ai/docs/config/)
- [opencode MCP docs](https://opencode.ai/docs/mcp-servers/)
- [DeepWiki: sst/opencode CLI](https://deepwiki.com/sst/opencode/6.1-command-line-interface-(cli))
- [SpillwaveSolutions/opencode_cli headless wrapper](https://github.com/spillwavesolutions/opencode_cli)
- [AlaeddineMessadi/opencode-mcp 桥 (第三方, 供参考)](https://github.com/AlaeddineMessadi/opencode-mcp)
- npm `opencode-ai@1.17.13` pinned exact (v0.3, per §8 D6). Upstream 迭代快 (每日 snapshot tags 见 `npm view opencode-ai dist-tags`), 差一个字 spawn 就拒 → `anet opencode upgrade-pin <version>` 显式升级带 e2e smoke.
- Phase 0b 探针真号: `docs/analysis/rfc029-opencode-probe/{summary.md, u1-run-json.txt, u3-gate-report.txt, u5-serve.txt, u8-acp.txt}` (工程马, 2026-07-03, opencode 免费 model 零 vendor key)

---

**下一步**: 通信龙 review → 有 CHANGE_REQ 回滚修 → PASS 后 Phase 0 活体探针 + RFC v0.2 补数字 → Vincent 拍板 track 选型 → Phase 1 实施.
