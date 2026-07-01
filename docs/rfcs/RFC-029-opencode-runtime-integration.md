# RFC-029: opencode runtime 集成 (scoping)

| 项 | 值 |
|----|----|
| **作者** | 通信工程马 |
| **状态** | Draft v0.1 — 待 通信龙 review, review 过 → 转 Vincent 拍板 → 进实施 |
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

### 2.5 MCP 面

opencode 是 MCP **客户端** (`opencode mcp add|list|auth`, [docs/mcp-servers](https://opencode.ai/docs/mcp-servers/)). 支持连 stdio/http/sse 三类 MCP server. 也就是说 opencode 侧可以挂 CommHub MCP server, 让 opencode 侧 agent 有 `send_task`/`report_status`/`commhub_reply` 等工具.

opencode **自己不作为 MCP server** 暴露 (第三方桥 [AlaeddineMessadi/opencode-mcp](https://github.com/AlaeddineMessadi/opencode-mcp) 存在但非一等).

### 2.6 近期上游改动 (~25 commits 内)

大部分是 desktop v2 / TUI 打磨. runtime 相关:
- `fix(provider)`: force openai reasoning variants
- `fix(core)`: stop replaying stale GitHub Copilot Responses item IDs
- 模型刷新 (Sonnet 5 等)

**无** headless 相关 breaking. npm 最新 `opencode-ai@1.17.12` (2026-07-01 前 ~17h).

### 2.7 `acp` 子命令

opencode 有个 `acp` 子命令 (Agent Client Protocol), CLI docs 页面未展开. **未知**是否是 opencode 官方正在推的一等程序化入口 — grok-build-acp 已经用了 ACP 协议, 如果 opencode `acp` 走同一套, 集成成本会显著降低 (可直接复用 `grok-build-acp/client.ts` + `runtime.ts` 抽象). 需实测确认.

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

### 方案 B1 (推荐): 常驻 serve + HTTP client (类 grok-build-acp)

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

## 5. 关键未知项 (实施前必须活体验证)

| # | 未知项 | 验证方法 | 阻塞哪个方案 |
|---|---|---|---|
| U1 | `opencode run --format json` 事件 exact schema, 抽 final assistant text 的稳定 JSON path | `docker run --rm node:22 ... npm i -g opencode-ai && opencode run --format json "hi"` 抓 stdout | B2 (blocker) / B1 (nice-to-have 交叉验) |
| U2 | `opencode serve` MCP 挂载机制 (是运行时 flag 还是要 config 文件预置) | 读 opencode.ai/docs/server + 尝试 `opencode serve --help` | B1 (blocker) |
| U3 | 首启 `opencode auth login -p anthropic` 能否纯 env-var (ANTHROPIC_API_KEY) 绕过, 无需交互 | fresh docker + env + `opencode run ...` 观察是否要求 login prompt | B1/B2 都是 (安全 default) |
| U4 | opencode `acp` 子命令是否走 Agent Client Protocol (Zed ACP), 若是可直接复用 `runtime/grok-build-acp` | `opencode acp --help` + 读源码 | 影响 B1 工时上限 |
| U5 | `POST /session/:id/message` 同步返回的 `parts: Part[]` 里 final assistant text 的 canonical path | 打真 opencode serve + curl 一次 | B1 (blocker) |
| U6 | session 磁盘位置能否指定为 `.anet/nodes/<alias>/.opencode/` (避免全局污染) | 读 config docs + `opencode db path` | 两方案都影响 (多节点隔离) |
| U7 | opencode 是否支持传 image 附件 (对齐 `images?: string[]` handler 契约) | docs `--file` flag + 试真 API | 多 modal 场景 |

**建议**: 派测试号 (通信测试马 或 agent-node docker container) 起一轮活体探针跑 U1/U2/U3/U5 4 大 blocker, 耗时约 1-2h, 拿到数据回填 RFC v0.2. 通信龙 review 前建议做这一步.

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

## 7. 建议实施顺序 (若 review 通过)

**Phase 0 (前置, ~2h)**: 活体探针跑 U1/U2/U3/U5 → RFC v0.2 补数字 → 通信龙 final judge

**Phase 1 MVP (B2 冷启 route, ~7h)**: 让 opencode-cli 能作为 runtime 值出现 + 冷启 `opencode run` 能 process 一个 task → 基本 e2e docker green. 用户能创建 opencode-cli 节点 + 收 task + 回 text.

**Phase 2 常驻升级 (B1, ~15h)**: 换 `opencode serve` 常驻 + HTTP client + SSE + supervisor + MCP inject → 真生产就绪

**Phase 3 完善 (~3h)**: 多 vendor 预设 (VendorSpec 表) + wizard 交互优化 + docs + preview 发版

**总计 (含 Phase 0)**: ~27h 到 Phase 3 完成, 建议分 3 PR ship 让 review 面小.

---

## 8. 决策点 (需 通信龙 → Vincent 拍板)

| # | 决策 | 建议 |
|---|---|---|
| D1 | 是不是 B1 常驻方案作长期? | **是**, 若 24/7 无人值守是 anet 定位 (per [[project_positioning_ai_army]]) |
| D2 | 要不要先 B2 MVP 抢速度? | **是**, 若 Vincent 想尽快 demo; **否**, 若可以直接一步到 B1 |
| D3 | 支持哪几个 vendor 作为 opencode-cli 的 preset? | 建议起手 Anthropic + OpenAI 2 家 (跟现有 anet 双主 vendor 一致) |
| D4 | 命名: `opencode-cli` vs `opencode` | 建议 `opencode-cli` (跟 claude-code-cli 对齐 -cli 后缀), 留 `opencode-sdk` 命名给未来 |
| D5 | opencode 全局配置能否被 anet mount 隔离到 per-node? | 建议 `HOME=<node workdir>` env 强隔离 (per node 独立 opencode config root), 避免多节点相互污染 |
| D6 | Phase 0 活体探针派给谁跑? | 建议派 通信测试马 或 SDK马 (跟 opencode 打交道能力强的), 通信工程马自己也可以 |

---

## 9. 附录: 关键代码定位表 (实施时 quick jump)

| 需要动的地方 | 文件路径 | 大致行号 |
|---|---|---|
| RuntimeName type + normalizeRuntime | `agent-network/bin/cli.ts` | 366-390 |
| wizard runtime picker | `agent-network/bin/cli.ts` | 844-864 |
| VendorSpec 表 | `agent-network/bin/cli.ts` | 1573-1657 |
| checkRuntimeDependency | `agent-network/bin/cli.ts` | 984 |
| assertStartCompatibility | `agent-network/bin/cli.ts` | 946 |
| launchAgent runtime switch | `agent-network/bin/cli.ts` | 2431 |
| CLI usage string | `agent-network/bin/cli.ts` | 1951 |
| RUNTIME_MAP | `agent-node/src/cli.ts` | 278-284 |
| processTask runtime switch | `agent-node/src/cli.ts` | 1991-2005 |
| writebackSession pattern | `agent-node/src/cli.ts` | 388-413 |
| createCommhubSdkMcpServer | `agent-node/src/commhub-mcp.ts` | 整文件 |
| grok-build-acp 模板 | `agent-node/src/runtime/grok-build-acp/` | 整目录 |
| codex-stdio-client 参考 | `agent-node/src/runtime/codex-stdio-client.ts` | 整文件 |
| supervise-child 抽象 | `agent-node/src/util/supervise-child.ts` | 整文件 |
| server normalizeRuntime | `server/src/index.ts` | 161-168 |

---

## 10. 参考

- [opencode CLI docs](https://opencode.ai/docs/cli/)
- [opencode server docs](https://opencode.ai/docs/server/)
- [opencode config docs](https://opencode.ai/docs/config/)
- [opencode MCP docs](https://opencode.ai/docs/mcp-servers/)
- [DeepWiki: sst/opencode CLI](https://deepwiki.com/sst/opencode/6.1-command-line-interface-(cli))
- [SpillwaveSolutions/opencode_cli headless wrapper](https://github.com/spillwavesolutions/opencode_cli)
- [AlaeddineMessadi/opencode-mcp 桥 (第三方, 供参考)](https://github.com/AlaeddineMessadi/opencode-mcp)
- npm `opencode-ai@1.17.12` (2026-07-01)

---

**下一步**: 通信龙 review → 有 CHANGE_REQ 回滚修 → PASS 后 Phase 0 活体探针 + RFC v0.2 补数字 → Vincent 拍板 track 选型 → Phase 1 实施.
