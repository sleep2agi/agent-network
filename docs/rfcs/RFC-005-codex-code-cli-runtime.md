# RFC-005：codex-code-cli runtime — 让 anet 用户直接用 Codex CLI 接 commhub

| 字段 | 内容 |
|---|---|
| 状态 | **草案**（等 Vincent A/B/C 决策） |
| 提出 | 2026-05-13 |
| 作者 | 通信SDK马 |
| 派单 | 通信龙（roadmap + review） |
| 关联 issue | [#14](https://github.com/sleep2agi/agent-network/issues/14) Telegram bind / RFC-002 Phase 2 跨链 |
| 关联 RFC | RFC-002 channel-bind-cli / RFC-003 node telemetry |
| 前置研究 | [commit 6429bc0](https://github.com/sleep2agi/agent-network/commit/6429bc0) codex CLI 直接通信能力研究 + issue #18 round 39 / round 8 SaaS 沙箱化 flag |
| 目标版本 | agent-network v2.2.x（具体 sub-version 待决策 A 后定）|
| 实施人 | 通信工程马（如 A 决策 — Vincent 已 noted）|

## 摘要

给 anet 加第 5 个 runtime — `codex-code-cli`，让用户在 `anet node create --runtime codex-code-cli` 后启动节点时**自动 spawn `codex` 二进制**并**自动注入 commhub MCP**（per-session inline 注入不污染用户 `~/.codex/config.toml`）。**目的**：让 codex CLI 用户能像 claude-code-cli runtime 一样**直接接入 anet mesh**，跟其他 agent 通信、用 `send_task / get_inbox / get_all_status` 等工具，而**不用手动维护私人 proxy 配置**。

## 1. 背景

### 1.1 anet 当前 runtime 矩阵

`agent-network/bin/cli.ts:133` 定义：

```ts
type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk" | "http-api";
```

4 个 runtime，覆盖：

| Runtime | 走 binary 还是 SDK | claude 侧 | codex 侧 |
|---|---|---|---|
| `claude-code-cli` | spawn `claude` 二进制 | ✅ | — |
| `claude-agent-sdk` | npm SDK `@anthropic-ai/claude-agent-sdk` | ✅ | — |
| `codex-sdk` | npm SDK `@openai/codex-sdk` | — | ✅ |
| `http-api` | OpenAI-compatible HTTP fetch | ✅ | ✅ |

**对称性缺口**：claude 侧有 CLI 二进制 path（claude-code-cli）+ SDK path（claude-agent-sdk）双轨；codex 侧**只有 SDK path**，缺 codex CLI 二进制 path。

> ⚠️ **对称性 caveat**（2026-05-13 amend per Vincent telegram 4023-4025 + 通信龙 raise）：
> 这里说的"对称"是 **functional symmetry**（MCP tools 都能用 / commhub MCP 都能注入），**不是 behavioral symmetry**（push-driven vs pull-on-prompt）。详见 §3.5 architectural reality block — codex MCP 是 pull-on-prompt，没有 channel plugin 等价 push-wake-up，commhub_send_task 进来时 codex TUI idle 不会自动响应。早期 §1 隐含 "完全对称" 措辞是 over-promise，本 caveat 修正。

### 1.2 跟 RFC-002 Phase 2 关系

RFC-002 channel-bind-cli 已经规范了 `--channels plugin:telegram@...` 注入机制（claude CLI 用），Phase 2 涉及把 channel binding 扩展到所有 runtime。codex-code-cli runtime 加上后，channel binding 可以一致 cover 两个 CLI runtime（claude-code-cli + codex-code-cli），跟 RFC-002 路径配套。

### 1.3 用户需求验证

[commit 6429bc0](https://github.com/sleep2agi/agent-network/commit/6429bc0) §3 已实证：Vincent 自己 `~/.codex/config.toml` 含半成品配置：

```toml
[mcp_servers.commhub-proxy]
command = "bun"
args = ["/home/vansin/agent-orchestra/proxy/commhub-proxy.ts"]

[mcp_servers.commhub-proxy.env]
COMMHUB_ALIAS = "codex-硅谷"
COMMHUB_URL = "http://127.0.0.1:9200"
```

但 `proxy/commhub-proxy.ts` 文件**不存在**（grep find 返回空）。Vincent 早期尝试但未完成 — 用户需求真实，但**没产品化路径**。

## 2. 现状 + Gap

### 2.1 codex CLI v0.130.0 MCP 支持已成熟（2026-05-08 ship）

`codex --help` + `codex mcp --help` + `codex exec --help` 实测（commit 6429bc0 §1）：

- **`codex mcp` 子命令**：list / get / add / remove / login / logout — 持久化管理 `~/.codex/config.toml`
- **`codex exec --config 'mcp_servers.X.url=Y'`** inline 注入 — per-session 不污染磁盘
- **`codex mcp-server`** — codex **反向**作 MCP server（暴露给 host）
- **HTTP transport** — `codex mcp add commhub --url <hub>/mcp --bearer-token-env-var COMMHUB_TOKEN` 直接接 commhub-server 的 streamable HTTP MCP

MCP 支持 v0.128+ 稳定（非实验性 feature）。

### 2.2 anet wrapper gap

`agent-network/bin/cli.ts`：

- L133 `RuntimeName` enum 缺 `codex-code-cli`
- L135-148 `normalizeRuntime` 无 codex CLI 分支
- L1640-1680 `launchAgent` 仅支持 claude CLI 二进制 spawn 路径
- L497 setup wizard `runtimeSelections` 仅 4 个 runtime

用户当前**无法**通过 anet CLI 创建 codex CLI 二进制 + commhub MCP 配套节点。

### 2.3 跟 codex-sdk runtime 的差异

`codex-sdk` runtime（agent-node 内 spawn）= **程序化** Codex 调用：

- 走 `@openai/codex-sdk` npm 包
- 内部 `codex exec --experimental-json` 走 streaming JSON
- 节点是 daemon，可后台跑
- commhub MCP 通过 SDK `Codex({config: { mcp_servers: ... }})` 注入（R39 已分析）

`codex-code-cli` runtime（提议） = **交互式** Codex 调用：

- 直 spawn `codex` 二进制
- 用户在终端看到 codex TUI
- 节点 = 用户 attached 的交互 session
- commhub MCP 通过 `--config 'mcp_servers.X=Y'` inline 注入

两者**互补不互斥**，对应不同 use case（daemon vs interactive）。

## 3. 设计

### 3.1 RuntimeName 扩展

```diff
-type RuntimeName = "claude-code-cli" | "codex-sdk" | "claude-agent-sdk" | "http-api";
+type RuntimeName = "claude-code-cli" | "codex-code-cli" | "codex-sdk" | "claude-agent-sdk" | "http-api";
```

### 3.2 `normalizeRuntime` 分支

```diff
function normalizeRuntime(profileOrRuntime?: Profile | string): RuntimeName {
  if (typeof profileOrRuntime === "string") {
+   if (profileOrRuntime === "codex-code-cli" || profileOrRuntime === "codex-cli") return "codex-code-cli";
    if (profileOrRuntime === "codex" || profileOrRuntime === "codex-sdk") return "codex-sdk";
    if (profileOrRuntime === "claude" || profileOrRuntime === "claude-sdk" || profileOrRuntime === "claude-agent-sdk") return "claude-agent-sdk";
    // ... rest unchanged
  }
}
```

### 3.3 spawn codex CLI 路径（类比 claude-code-cli — TUI attached 模式）

新增 cli.ts:1640 附近的 \"spawn claude CLI\" 之后一段 \"spawn codex CLI\"。

> **⚠️ Errata (2026-05-13 通信工程马 step 1 catch + 通信龙 verify codex --help)**：
> 早期 draft 用 `["exec", ...]` 是误抄 codex-sdk 内部 batch 模式（`exec --experimental-json`），跟 §3.7 user workflow 意图（用户 attached TUI）冲突。
> **正确**：codex CLI **无 subcommand** = TUI 模式，跟 `claude-code-cli` `spawn("claude", ...)` 对称。节点 = attached daemon，用户在终端看 codex TUI 直接跟其他 agent 通信。
> §6.6 session matters 同步修正：`codex resume <SESSION_ID>` 是 **top-level subcommand**（不是 `--resume <id>` flag）。

```ts
// (sketch — 不是最终实施代码)
if (runtime === "codex-code-cli") {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    COMMHUB_ALIAS: profile.alias,
    ...(token ? { COMMHUB_TOKEN: token } : {}),
  };
  for (const [k, v] of Object.entries(profile.env)) {
    env[k] = v.replace(/^~/, home);
  }

  // TUI 模式：codex 无 subcommand = interactive attached
  // (跟 claude-code-cli L1677 `spawn("claude", claudeArgs)` 对称)
  const codexArgs: string[] = [];

  // session 续接 (TUI mode 用 top-level `resume` subcommand)
  if (profile.session) {
    codexArgs.push("resume", profile.session);
  }

  // commhub MCP inline 注入 — 不污染 ~/.codex/config.toml
  // 注意: 使用 array args, 不走 shell, 避免 shell injection (cf. #86 patch round 2)
  // inner double-quote 是 TOML literal 语法需要 (codex --config value 侧 TOML 解析)
  codexArgs.push("--config", `mcp_servers.commhub.url="${commhubUrl}/mcp"`);
  codexArgs.push("--config", `mcp_servers.commhub.bearer_token_env_var="COMMHUB_TOKEN"`);

  // SaaS 沙箱化 flag（R8 R23 分析）
  if (profile.flags.dangerouslyBypass) {
    codexArgs.push("--dangerously-bypass-approvals-and-sandbox");
  }

  // 隔离 host 用户 codex config（R8 SaaS 沙箱化建议）
  codexArgs.push("--ignore-user-config", "--ignore-rules");

  // 跟 claude-code-cli 同款：spawn 后 pid 写入 .pid file，exit handler 清理
  // TUI 模式: stdio:"inherit" attach 用户终端
  const child = spawn("codex", codexArgs, { env, stdio: "inherit" });
  const pidFile = join(nodesDir(), nodeId, ".pid");
  if (child.pid) writeFileSync(pidFile, String(child.pid));
  child.on("exit", (code) => {
    try { rmSync(pidFile, { force: true }); } catch {}
    // ... handler 同 claude path
  });
}
```

**关键细节**：

1. `spawn("codex", codexArgs, { stdio: "inherit" })` — **不带 `shell: true`**（跟 #86 patch round 2 一致）
2. `--config 'mcp_servers.commhub.url=...'` 使用 array args 避免 shell quoting 风险
3. `COMMHUB_TOKEN` 通过 env 注入而非 hardcode 进 config（per anet `ntok_` 命名空间）

### 3.4 commhub MCP 注入机制（HTTP transport）

codex CLI 通过 `--config` 注入的 mcp_servers config 等价于 TOML 表：

```toml
[mcp_servers.commhub]
url = "http://127.0.0.1:9200/mcp"
bearer_token_env_var = "COMMHUB_TOKEN"
```

启动后 codex CLI 自动连接 commhub-server `/mcp` endpoint（streamable HTTP MCP），获取 commhub tools：

- `send_task(alias, task)` / `send_message(alias, message)`
- `get_inbox(alias, limit?)`
- `get_all_status()`
- `report_status(status, task?)`
- `send_reply(target, message, ...)`

跟 `claude-code-cli` runtime 用的同款 commhub MCP — 用户体感跨 runtime 一致。

### 3.5 Push vs Pull 语义 — 关键架构差异（**2026-05-13 新增，per Vincent telegram 4023-4025 + 通信龙 raise**）

§1.1 对称性 caveat 提到的 **functional vs behavioral symmetry** 在此具体化。两个 runtime 行为模式根本不同：

| 维度 | `claude-code-cli` | `codex-code-cli` |
|---|---|---|
| 触发机制 | **Push-driven daemon** | **Pull-on-prompt** |
| commhub 消息到达时 | channel plugin 监听 incoming → 自动 wake → inject prompt → claude 响应 | codex TUI idle，**无 wake-up 机制** — 不知道 inbox 有新消息 |
| 用户操作要求 | 零（agent 自主接力）| 用户主动 prompt \"check inbox\" / \"get_all_status\" 才查 |
| Channel plugin 等价 | `--channels plugin:commhub@...` 存在 | **无对应机制** — codex MCP 只让 codex 知道 tools 在哪，用户 turn 触发才 call |
| 适合场景 | 多 agent 自主协作 mesh | 用户主动 chat + 偶尔派单 |

**根因**：

- **claude-code-cli channel plugin** 是 Anthropic Claude Code 自带的 daemon 机制：plugin 进程独立监听 channel（telegram / commhub），收到消息后**主动 inject 到 claude session prompt**。Claude session 是 push-receiver。
- **codex CLI MCP** 是标准 MCP client 行为：codex 知道有哪些 tools 可调用，但 **不订阅 push events**。Tools 调用走 user-turn 路径（user 发 prompt → codex 决定要不要 call tool → call → 拿结果 → 回答 user）。**没有 server-push-to-client 的 idle wake-up 机制**。

**对 commhub_send_task 链路的影响**：

```
[场景 1: claude-code-cli 节点]
Agent A send_task(alias='claude-bot', task='...')
  → commhub server 推 SSE event 到 claude-bot
  → claude-bot channel plugin 监听到 → wake claude session → 自动响应 → reply 回 A
  ✅ user 不用动

[场景 2: codex-code-cli 节点（本 RFC 提议）]
Agent A send_task(alias='codex-bot', task='...')
  → commhub server inbox 收任务
  → codex-bot TUI idle，**收不到 push wake-up**
  → 任务卡在 inbox，直到 user 在 codex TUI 里手动 type "check my inbox"
  → 那时 codex 才 call get_inbox MCP tool 拿任务 → 响应 → reply 回 A
  ⚠️ user 必须主动轮询
```

**结论**：`codex-code-cli` runtime 在 mesh 自主协作场景**不是 claude-code-cli 的对等替代品**，是另一个产品形态（user-driven codex 终端 + commhub MCP 工具）。

### 3.6 setup wizard prompt 加 codex-code-cli 选项

cli.ts:497 `runtimeSelections = await checkbox<RuntimeName>(...)`：

```diff
  const runtimeSelections = await checkbox<RuntimeName>({
    message: "你需要哪些 runtime？",
    choices: [
      { name: `claude-code-cli — Claude Code CLI${...}`, value: "claude-code-cli" },
+     { name: `codex-code-cli — Codex CLI (实验性)${isInstalled(versions.codex) ? "（已就绪 ✅）" : "（需安装 codex CLI）"}`, value: "codex-code-cli" },
      { name: `claude-agent-sdk — Claude Agent SDK`, value: "claude-agent-sdk" },
      { name: `codex-sdk — Codex SDK`, value: "codex-sdk" },
      { name: `http-api — HTTP API`, value: "http-api" },
    ],
  });
```

### 3.7 用户工作流

```bash
# 1. 装 codex CLI（必备前置）
npm install -g @openai/codex

# 2. anet setup 选 codex-code-cli runtime（一次性）
anet setup
# (在 runtimeSelections 里勾选 codex-code-cli)

# 3. 创建节点
anet node create my-codex --runtime codex-code-cli

# 4. 启动 — 自动 spawn codex 二进制 + 自动注入 commhub MCP
anet node start my-codex

# 用户进入 codex TUI，可用 commhub tools:
# > send_task(alias="claude-bot", task="...")
# > get_all_status()
# 跟其他 agent 通信，跟 claude-code-cli runtime 完全对称
```

## 4. cli.ts 改动详细（~50-80 行预估）

| 位置 | 改动 | 行数 |
|---|---|---|
| `RuntimeName` enum (L133) | + `"codex-code-cli"` | 1 |
| `normalizeRuntime` (L135-148) | + 2 个 string match 分支 + 1 个 Profile.runtime 兜底 | 3-5 |
| `assertStartCompatibility` (L589) | 加 codex-code-cli 检查（codex binary 是否在 PATH）| 5-10 |
| `checkRuntimeDependency` (L627) | 加 codex-code-cli 依赖检测 | 10-15 |
| Setup wizard `runtimeSelections` (L497) | + 1 个 choice entry | 5 |
| `installRuntimeDependencies` (L526+) | 加 codex CLI 自动安装提示 | 5-10 |
| `launchAgent` spawn 分支 (L1640+) | 新增 codex-code-cli spawn 段（参 §3.3 sketch） | 25-40 |
| Docs comment / help text 同步 | runtime 列表 4→5 处 | 2-3 |
| **总计** | | **~50-90 行** |

业务码改动严格 contained 在以上位置，**不动**：

- agent-node SDK 路径（codex-sdk / claude-agent-sdk）
- commhub-server（不需要 server 侧改动 — MCP HTTP transport 已支持）
- dashboard（不需要 — runtime 标签变化由 dashboard 自动渲染）

## 5. Migration path

### 5.1 既有 `codex-sdk` runtime 用户

**完全无影响** — codex-sdk runtime 跟 codex-code-cli runtime **并行存在**，互不冲突。用户可：

- 继续用 codex-sdk（程序化 daemon 模式）
- 或新建 codex-code-cli runtime 节点（交互式模式）
- 或两个 runtime 并跑（同一 hub 内多节点）

### 5.2 既有 `~/.codex/config.toml` 用户

如果用户已经手配过 `[mcp_servers.commhub-proxy]`（如 Vincent stale config），新 runtime 用 `--ignore-user-config` flag 不会读这部分。**用户磁盘 config 不动**，跟新 runtime 用同名 `mcp_servers.commhub` 也不冲突（per-session inline 优先）。

### 5.3 跟 RFC-002 Phase 2 实施顺序

**建议**：RFC-002 Phase 2 channel binding 实施**在前**，codex-code-cli runtime 实施**在后**。

理由：
- channel binding 是跨 runtime 的通用机制（Telegram / Feishu / WeChat）
- codex-code-cli 加上后可以**直接复用** channel binding（不用再单独写 codex 侧 channel）
- 顺序倒着做需要在 codex-code-cli 实施完后回头 patch channel 接入，多一次改动

## 6. 风险评估

### 6.1 codex CLI 版本依赖

| 维度 | 评估 |
|---|---|
| 0.128.0 起 MCP support stable | ✅ 已 verify（commit 6429bc0 §2） |
| 0.130.0 (2026-05-08 ship) latest stable | ✅ Vincent mac mini local 安装 verify |
| `--config` inline 注入 flag 起始版本 | 待 spike — RFC 草案假设 ≥ 0.128，实施前 verify |
| MCP transport push-based not polling | ✅ commhub-server `WebStandardStreamableHTTPServerTransport` 已 stable（PR #23 RFC-003 P1a 之前已用）|

**最小 codex CLI 版本要求**：建议在 `assertStartCompatibility` 加 `codex --version` 检查，要求 `>=0.128.0`，否则提示用户升级。

### 6.2 用户磁盘 config 隔离

`--ignore-user-config` + `--ignore-rules` flag 确保不读 host 用户的 `~/.codex/config.toml` 和 `.rules` 文件 — anet runtime 完全 self-contained，跟 R10 + R23 SaaS multi-tenant 沙箱化方向一致。

### 6.3 commhub token 注入安全

`bearer_token_env_var = "COMMHUB_TOKEN"` 让 codex CLI 读 `COMMHUB_TOKEN` env 而非 hardcode token 到 config — token 不进文件系统 / 不进 codex session log。

### 6.4 跨 OS 兼容性

- **Linux / macOS**：直接 spawn `codex` 二进制 ✅
- **Windows**：codex 自身 Windows 支持限定（不在 anet 主目标 OS 范畴）— 不阻塞本 RFC

### 6.5 跟 PR #36 #86 shell spawn audit 一致

本 runtime 的 spawn 调用**严格用** array args + `execFileSync` 或 `spawn(.., { stdio: "inherit" })` 形式，**不带** `shell: true`，避免 user alias 含特殊字符导致 shell injection — 跟 #86 patch round 2 防御纵深一致。

### 6.6 session 续接 vs 新建（**已 amend** per 通信工程马 step 1 catch）

codex `Thread.id` semantics 跟 claude session UUID 不同（codex thread ID 在 turn start 后才有，claude session UUID 在 spawn 前预生成）。

**TUI mode session 续接路径**（codex-code-cli runtime 实际走）:

- **首次启动**: `spawn("codex", [...flags])` — 无 resume，codex 自动生成新 thread ID
- **后续启动**: `spawn("codex", ["resume", session, ...flags])` — `resume` 是 codex CLI **top-level subcommand**（不是 flag）
- codex 把 thread 持久化到 `~/.codex/sessions/`（或 `--ignore-user-config` 之后走 anet 沙箱目录，具体 spike 验）

> ⚠️ Errata: 早期 draft 写 `codex exec resume <session>` 是混淆了 codex-sdk 内部 batch 路径 (`exec --experimental-json`)。**TUI runtime 不走 exec subcommand**，跟 §3.3 amend 一致。

跟 claude-code-cli 的 `--session-id` / `--resume` flag 行为不同（claude 用 flag，codex 用 subcommand），但都是 attached daemon 模式 — anet wrapper 抽象后用户体验对称。

## 7. Smoke matrix（Docker E2E test 设计）

类比现有 test28 debate / test32 shell spawn audit 套件：

### 7.1 test-codex-code-cli/Dockerfile

```dockerfile
FROM oven/bun:1
WORKDIR /app

# 装 codex CLI binary（脚本会 detect node + npm i -g）
RUN apt-get update && apt-get install -y nodejs npm
RUN npm install -g @openai/codex@0.130.0

# 装 commhub-server preview tag + 起 server
COPY tests/test-codex-code-cli/seed-hub.sh /seed-hub.sh

# 装 agent-network preview tag
RUN npm install -g @sleep2agi/agent-network@preview

# 跑测试脚本
COPY tests/test-codex-code-cli/run.sh /run.sh
RUN chmod +x /run.sh
CMD ["bash", "/run.sh"]
```

### 7.2 run.sh 测试步骤

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

# L0 prerequisites
which codex && echo "[L0] codex installed ✅"
which anet && echo "[L0] anet installed ✅"

# L1 起 commhub-server
anet hub start &
sleep 5
curl -s http://127.0.0.1:9200/health | grep '"ok"' && echo "[L1] hub up ✅"

# L2 create + bind codex-code-cli node
anet register --username test --password 'TestPassword2026'
anet login
anet network create test
anet network use test
anet node create codex-bot --runtime codex-code-cli
[ -f .anet/nodes/codex-bot/config.json ] && echo "[L2] config written ✅"

# L3 verify spawn — 跑 5 秒看 codex 二进制是否被 fork
timeout 5 anet node start codex-bot &
SPAWN_PID=$!
sleep 2
pgrep -f "codex exec.*mcp_servers.commhub" && echo "[L3] codex spawned with mcp_servers.commhub ✅"
kill -9 $SPAWN_PID 2>/dev/null

# L4 grep node profile env 注入正确
grep '"COMMHUB_TOKEN"' .anet/nodes/codex-bot/config.json && echo "[L4] env COMMHUB_TOKEN bound ✅"

# L5 sandbox flag check
pgrep -f "codex exec.*--ignore-user-config.*--ignore-rules" && echo "[L5] sandbox flags applied ✅"

echo "PASS test-codex-code-cli"
```

### 7.3 不测的 case（留 follow-up issue）

- 真实 codex API key auth（test env 没 OpenAI 凭据）
- 跨 agent 派单 E2E（需要 mock LLM 响应 — 留独立 test）
- session 续接（resume `<uuid>`）

## 8. 决策点（待 Vincent — **2026-05-13 重写 per §3.5 push vs pull architectural gap**）

§3.5 揭示 codex-code-cli 不是 claude-code-cli 的行为对等品（functional only）。基于此现实，决策选项 **A/B/C/D**：

### A — 降级 ship（accept pull-only + 文档清楚 caveat）

实施 §3.1-§3.4 + §3.6-§3.7 全部设计，但**接受 pull-on-prompt 限制**：

- 用户工作流文档明确写 \"codex-code-cli 是 user-driven，commhub 任务 user 须主动 check inbox\"
- setup wizard 选项加 \"(实验性: pull-mode, 跟 claude-code-cli 不行为对等)\" label
- cli.ts 改动 ~50-80 行 + Docker E2E test

**适合场景**：用户主要用 codex TUI 当 user 终端（写代码 / 跑命令），偶尔派单 / 查状态，不期待 mesh 自主接力。

**优点**：实施 scope 可控；产品形态 honest；不 over-promise；用户体感清晰；Vincent stale config 用户立刻能用产品化版本。
**缺点**：跟 claude-code-cli 用户体验不对等 — 需要 docs / dashboard 清楚标注。

### B — Background polling daemon（架构补丁）

anet wrapper 起独立 daemon listen commhub SSE → 收到 task → 外部触发 codex stdin / 或调 codex CLI `exec` 子进程处理 single task → 把结果 send_reply 回 commhub。

**优点**：可模拟 claude-code-cli 的 push 行为
**缺点**：
- **复杂 brittle**：需要 daemon process / stdin injection (security risk?) / 跟 codex TUI session 共享 thread 问题
- daemon crash 后 messages 丢失风险
- codex TUI 状态不一致（user 看的 TUI 不知道后台跑了什么）
- 不是 codex CLI 原生路径，**违反 §1 \"用官方 SDK / CLI\" 设计原则**

不推荐。

### C — HOLD 等 codex 加 channel push 等价机制（timeline 不定）

不实施本 RFC，等 codex CLI 加 \"channel plugin\" / \"SSE subscribe\" / \"daemon mode\" 等等价 push 机制后再回头。

**优点**：等到 codex 行为对等再实施，**真正**对称
**缺点**：
- timeline 完全不可控（OpenAI roadmap 不在我们手里）
- 错失当前用户需求 — Vincent 自己已经在用 stale proxy 配置
- HOLD 期间 codex 用户继续手动配，体验糟糕

### D — Telegram bind 配合（push 触发 + codex 响应）

不走 commhub MCP push 路径，借助 Telegram channel 作 push trigger：

1. 用户在 Telegram 给 codex-bot 发消息
2. anet wrapper 起 telegram bot listener daemon (类似 RFC-002 已有的 telegram plugin)
3. 收到 telegram message → 把 message 作为 prompt inject 到 codex stdin（或调 codex `exec` 一次）
4. codex 响应 → wrapper 转回 telegram

**优点**：用 Telegram 替代 commhub mesh，user 体感是 \"通过 Telegram 跟 codex 对话\"
**缺点**：
- **跳出 RFC-005 scope** — 本质是 telegram-bind-codex 新 feature，跟 RFC-002 Phase 2 重叠
- 不解决 mesh agent ↔ codex 自主接力问题（只是用户接力）
- 用户必须有 Telegram bot setup 前置

### 我的倾向（不替 Vincent 拍板）

**A** — 既然 architectural reality 是 pull-on-prompt，最 honest 路径是产品化 + 文档清楚标 caveat。**Vincent stale config 实证用户需求是 \"codex 终端能用 commhub tools\"，不是 \"codex 自主接力派单\"**。A 满足前者。

D 是好的 follow-up（跟 telegram channel 配合），但属另一个 RFC（codex-via-telegram-channel）scope。

B 复杂 + brittle 不推荐。C 时间成本不可控。

但 A/B/C/D 决策权完全归 Vincent。

## 9. 后续工作（决策 A 后）

1. 派单通信工程马 实施（按 §3 + §4 详细方案）
2. 跑 §7 Docker E2E test
3. 提 PR review（通信龙 + 通信SDK马 联合 review）
4. preview tag publish → Vincent 亲测 → latest 升级

## 10. 关联

- [前置研究 commit 6429bc0](https://github.com/sleep2agi/agent-network/commit/6429bc0) codex CLI 直接通信能力研究 doc
- [RFC-001 commhub-auth-token deprecate](RFC-001-deprecate-commhub-auth-token.md)
- [RFC-002 channel-bind-cli](RFC-002-channel-bind-cli.md)
- [RFC-003 node-telemetry-layer](RFC-003-node-telemetry-layer.md)
- [issue #14 telegram bind](https://github.com/sleep2agi/agent-network/issues/14)
- [issue #35 RFC-002 Phase 2 跟踪](https://github.com/sleep2agi/agent-network/issues/35)

## 状态变更

- 2026-05-13：草案提出（通信SDK马，通信龙 派单 + roadmap）。等 Vincent A/B/C 决策。
