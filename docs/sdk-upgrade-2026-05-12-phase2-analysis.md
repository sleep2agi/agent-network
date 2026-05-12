# SDK 升级 Phase 2 — 4 SDK 影响分析

| 字段 | 内容 |
|---|---|
| 状态 | **Phase 2 完成**（通信龙 verify → 转 Vincent 备览 / 按 escalation rule 自动决策）|
| 提出 | 2026-05-13 |
| 作者 | 通信SDK马 |
| 前置 | [Phase 1 baseline](sdk-upgrade-2026-05-12-baseline.md)（commit 9c1ed47 已 push） |
| 通信龙 escalation rule | 全部 low/medium + 无业务码改动 → 自动进 Phase 3；任何 high / 业务码改动 → escalate Vincent；MCP sub-path 实际 break → 即使 medium 也 escalate |

## 总结表

| # | SDK | 当前 | latest | 落后 | Risk | 业务码改动 | 自动 / Escalate |
|---|---|---|---|---|---|---|---|
| 1 | `@openai/codex-sdk` | 0.118.0 | 0.130.0 | 12 minor | 🟢 **Low** | ❌ 否 | ✅ **可自动** |
| 2 | `@anthropic-ai/claude-agent-sdk` | 0.2.105 | 0.2.140 | 35 minor | 🟡 **Medium** | ❌ 否 | ✅ **可自动** |
| 3 | `@modelcontextprotocol/sdk` | 1.12.x | 1.29.0 | 17 minor | 🟡 **Medium**（实测 sub-path 全在）| ❌ 否（类型签名核心 API 兼容）| ⚠️ **建议 escalate**（per 通信龙 rule: 即使 medium 也 escalate）|
| 4 | `@inquirer/prompts` | 7.10.1 | 8.4.3 | **major** | 🟡 **Medium**（major bump 需手测）| ❌ 否（API 调用面小，理论兼容）| ✅ **可自动**（前提：major bump 跑 manual smoke 通过）|

**结论**：4 个 SDK **均无业务码改动需求**（仅 `package.json` 版本号 bump）。但 MCP SDK 是 commhub-server ↔ agent-node 核心链路，按通信龙 rule 即使 medium 也建议你 review 后再 escalate Vincent 拍板。

## 推荐升级顺序

1. **codex-sdk** (low, warm up) — 5 min
2. **claude-agent-sdk** (medium，R19-R26 已分析新增 union 变体) — 10 min
3. **@modelcontextprotocol/sdk** (medium，按 escalation 等 ack) — pending Vincent
4. **@inquirer/prompts** (medium，major bump，需手测) — 15 min

每步独立 commit + preview publish + Vincent 亲测 ack 后下一步。

---

## SDK-1: `@openai/codex-sdk` 0.118 → 0.130 🟢

### ✅ Breaking changes 列表

**完全无**（R26 实测）：

| 维度 | 0.118.0 | 0.130.0 | 差异 |
|---|---|---|---|
| `ThreadItem` union | 8 种 | 8 种 | 0 |
| `ThreadEvent` union | 8 种 | 8 种 | 0 |
| `ThreadOptions` 字段 | (字段集 X) | 同 X | 0 |
| `TurnOptions` 字段 | 同 | 同 | 0 |
| `CodexOptions` 字段 | 同 | 同 | 0 |

12 minor 版本 public API surface **完全冻结**。

### ✅ 我们 codebase 实际撞击点

`agent-node/src/cli.ts`:

| 行 | API | 0.130 兼容性 |
|---|---|---|
| L619 | `import("@openai/codex-sdk")` 拿 `Codex` | ✅ |
| L625 / L679 | `new Codex({ config })` | ✅ |
| L626-633 | options 5 字段 | ✅ 5/5 字段名 + type 不变 |
| L635 | `codex.resumeThread(SESSION_ID, opts)` | ✅ |
| L638 / L680 | `codex.startThread(opts)` | ✅ |
| L651 | `codexThread.runStreamed(input)` | ✅ |
| L687 | `codexThread.run(input)` | ✅ |

### ✅ 业务码改动？**❌ 否**

仅 `agent-node/package.json` peerDependency 下限 bump：

```diff
-  "@openai/codex-sdk": ">=0.118.0"
+  "@openai/codex-sdk": ">=0.130.0"
```

### ✅ Risk: 🟢 **Low**

### 自动决策：✅ **可自动进 Phase 3**

---

## SDK-2: `@anthropic-ai/claude-agent-sdk` 0.2.105 → 0.2.140 🟡

### ✅ Breaking changes 列表

R19-R26 已系统分析 0.2.96 → 0.2.139（实测 0.2.140 vs 0.2.139 SDKMessage union 无差异，patch 升级几乎可忽略）：

**新增（向后兼容）**：

| 类别 | 0.2.96 → 0.2.140 | anet 影响 |
|---|---|---|
| `SDKMessage` union | 24 → 30（+6 种）| 主循环 `m.type === 'init'/'result'` 仍 match，新 type 走 default 忽略 ✅ |
| `HookEvent` | 27 → 29（+PostToolBatch / +UserPromptExpansion）| anet 只用 PreToolUse，不受影响 ✅ |
| `Options` 字段 | +9 个 | 新字段默认 undefined，不影响现有 16 个使用字段 ✅ |
| `SDKResultError.subtype` enum | 加 `'error_max_structured_output_retries'` | anet 没消费 subtype 细分，走 else 通用 ✅ |
| `Options.maxThinkingTokens` deprecated | 标 @deprecated | anet 零引用 ✅ |
| `permissionMode` enum 加 `'dontAsk'/'auto'` | 已用 `'bypassPermissions'` 不变 | ✅ |
| MCP `claudeai-proxy` 新 transport | anet 用 `'http'` 不变 | ✅ |

**子包 `@anthropic-ai/claude-agent-sdk-linux-x64`**：cli.ts:381/394/498 动态 install 子包 binary，需要 confirm 该子包 npm latest 跟 SDK latest 同步发布。Phase 3 实施时 `npm view @anthropic-ai/claude-agent-sdk-linux-x64 version` 即可验证。

### ✅ 我们 codebase 实际撞击点

`agent-node/src/cli.ts:437-562` 主调用点。详见 [Phase 1 §3](sdk-upgrade-2026-05-12-baseline.md)。

**16 个 Options 字段全部检查**：model / tools / maxTurns / permissionMode / allowDangerouslySkipPermissions / settingSources / mcpServers / pathToClaudeCodeExecutable / env / cwd / stderr / hooks / maxBudgetUsd / systemPrompt / resume / agents — **16/16 在 0.2.140 保留**。

### ✅ 业务码改动？**❌ 否**

仅 `agent-node/package.json`:

```diff
-  "@anthropic-ai/claude-agent-sdk": "^0.2.96"
+  "@anthropic-ai/claude-agent-sdk": "^0.2.140"
```

`^0.2.140` 在 0.2.x 范围内 caret，将来 0.2.150 自动跟。

### ✅ Risk: 🟡 **Medium**

理由：35 minor 演进面大，但 anet 只用 stable API 子集，已逐字段验证兼容。

### 自动决策：✅ **可自动进 Phase 3**

---

## SDK-3: `@modelcontextprotocol/sdk` 1.12 → 1.29 🟡 (实测后从 high 降至 medium)

### ✅ Breaking changes 列表

**实测验证**（Phase 2 实施期间 `npm i @modelcontextprotocol/sdk@1.29.0` 到 `/tmp/mcp-1.29-check`）：

**5 个 anet 用到的 sub-path 全部存在**（同时 ESM + CJS）：

| sub-path | 1.29 文件是否存在 | 关键 export 是否存在 |
|---|---|---|
| `server/index.js` | ✅ | `class Server<RequestT, NotificationT, ResultT>` ✅ |
| `server/stdio.js` | ✅ | `class StdioServerTransport implements Transport` ✅ |
| `types.js` | ✅ | （tool types 等）✅ |
| `server/mcp.js` | ✅ | `class McpServer` ✅ |
| `server/webStandardStreamableHttp.js` | ✅ | `class WebStandardStreamableHTTPServerTransport implements Transport` ✅ |

**通信龙 FYI #2 最关键的 `WebStandardStreamableHTTPServerTransport` 同名 + 同 file 存在**。

**1.12 → 1.29 新增（不影响现有用法）**：

- `./client` / `./validation` / `./experimental` 等新 sub-path（anet 暂不用）
- `Server` class 加了泛型参数 `<RequestT, NotificationT, ResultT>`（anet 用法 `new Server(...)` 不显式泛型，应使用默认值兼容 — Phase 3 verify TS 编译过即可）

### ✅ 我们 codebase 实际撞击点

`agent-network/src/node-server.ts`:

```ts
L55: import { Server } from "@modelcontextprotocol/sdk/server/index.js";
L56: import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
L60: import { /* tool types */ } from "@modelcontextprotocol/sdk/types.js";
```

`server/src/tools.ts`:
```ts
L1: import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
```

`server/src/index.ts`:
```ts
L1: import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
L2: import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
```

**5/5 import 路径 1.29 仍可解析**。

### ✅ 业务码改动？**❌ 否**

仅 `agent-network/package.json` (devDep) 和 `server/package.json` (dep)：

```diff
-  "@modelcontextprotocol/sdk": "^1.12.0"
+  "@modelcontextprotocol/sdk": "^1.29.0"
```

需要 verify：
- Phase 3 `bun run build` in agent-network 必须 pass（TS 编译过）
- Phase 3 `bun test` in server (3 tests) 必须全绿
- agent-node ↔ commhub MCP 调用 smoke test (manual)

### ✅ Risk: 🟡 **Medium**（实测后从 high 降）

降级理由：5 个 sub-path 实测全在 + 4 个关键 class 同名导出存在。

**潜在残留风险**（属 Medium 但需要 Phase 3 实施时实测确认）：

1. `Server` class 加泛型 — TS strict mode 下可能要求显式泛型参数
2. Tool / Resource / Prompt types 在 types.js 内部 shape 可能演进
3. `McpServer` constructor signature 可能加 options
4. WebStandardStreamableHTTPServerTransport 的 implements Transport 内部 protocol version 可能要求新

### 自动决策：⚠️ **建议 escalate Vincent**（per 通信龙 rule: \"MCP SDK transport sub-path 实际确认 break\" 是 escalation 必触发点；本轮 sub-path 实测 NOT break，但 17 minor 演进面 + commhub 核心链路重要性，**仍建议**走严慎流程）

---

## SDK-4: `@inquirer/prompts` 7.10 → 8.4 🟡 (major bump)

### ✅ Breaking changes 列表

**Major version bump (7 → 8)**，按 semver 约定有 breaking change。`@inquirer/prompts@8.4.3` 是 meta-package，依赖：

```
@inquirer/checkbox  ^5.1.5     (anet 用)
@inquirer/confirm   ^6.0.13    (anet 用)
@inquirer/editor    ^5.1.2
@inquirer/expand    ^5.0.14
@inquirer/input     ^5.0.13
@inquirer/number    ^4.0.13
@inquirer/password  ^5.0.13
@inquirer/rawlist   ^5.2.9
@inquirer/search    ^4.1.9
@inquirer/select    ^5.1.5     (anet 用)
```

anet 用到的 3 个子 prompt：

| 子 prompt | 7.x 主版本 | 8.x 主版本（实际）|
|---|---|---|
| `checkbox` | (来自 7.10.1 的内部依赖)| **5.1.5** |
| `confirm` | 同 | **6.0.13** |
| `select` | 同 | **5.1.5** |

7.10.1 → 8.4.3 实际 underlying sub-package 主版本：
- checkbox 4.x → 5.x（major）
- confirm 5.x → 6.x（major）
- select 4.x → 5.x（major）

**API surface 变化点**（待 Phase 3 实施时 npm view 8.x changelog 详读，主要看 message / choices.name vs label / generic type 写法）。

### ✅ 我们 codebase 实际撞击点

`agent-network/bin/cli.ts`:

```ts
L18: import { checkbox, confirm, select } from "@inquirer/prompts";

// 6 个调用点：
L497:  await checkbox<RuntimeName>({ message, choices: [...] })
L516:  await confirm({ message, default: false })
L547:  await confirm({ message: "确认安装？", default: true })
L1009: await select<T>({ message: title, choices: [...] })
L1245/L1275/L1312/L2929/L3081: const { select: sel } = await import("@inquirer/prompts")  // dynamic
```

**6 个调用 + 5 个 dynamic import**。

### ✅ 业务码改动？**❌ 否**（理论上）

`agent-network/package.json`:

```diff
-  "@inquirer/prompts": "^7.10.1"
+  "@inquirer/prompts": "^8.4.3"
```

**前提**：8.x 对 `checkbox / confirm / select` 三个函数签名兼容。Phase 3 实施时第一步是跑 `bun build`，TS 报错即说明需要业务码改动 → 立刻 escalate。

### ✅ Risk: 🟡 **Medium**（major bump，但 anet 用法面小，理论兼容）

Phase 3 必须 manual smoke：
- `anet setup` 触发 L497 checkbox + L516 confirm
- `anet network create` 触发 L1009 select
- 各 dynamic import select 调用点（L1245/L1275/L1312/L2929/L3081）— 跑 `anet node create` / 类似命令

### 自动决策：✅ **可自动进 Phase 3**（但 build 失败立即降级 escalate）

---

## Phase 3 实施 checklist

按上面顺序，每步独立 commit + preview tag publish + Vincent 亲测 ack 后下一步：

```
[ ] SDK-1: codex-sdk 0.118 → 0.130 (agent-node)
    [ ] agent-node/package.json: peerDep ">=0.130.0"
    [ ] bun run build
    [ ] preview publish: @sleep2agi/agent-node@2.3.1-preview.1 --tag preview
    [ ] Vincent 亲测 codex runtime 派单 → ack
    [ ] 通过 → 自动进 SDK-2

[ ] SDK-2: claude-agent-sdk 0.2.105 → 0.2.140 (agent-node)
    [ ] agent-node/package.json: dep "^0.2.140"
    [ ] npm view @anthropic-ai/claude-agent-sdk-linux-x64 version 确认子包同步
    [ ] bun run build
    [ ] preview publish: @sleep2agi/agent-node@2.3.1-preview.2 --tag preview
    [ ] Vincent 亲测 claude-agent-sdk runtime 派单 → ack
    [ ] 通过 → 自动进 SDK-3

[ ] SDK-3: @modelcontextprotocol/sdk 1.12 → 1.29 (agent-network + server)
    [ ] **通信龙 review + escalate Vincent**（per rule）→ 拿到 ack
    [ ] agent-network/package.json: devDep "^1.29.0"
    [ ] server/package.json: dep "^1.29.0"
    [ ] bun run build (agent-network)
    [ ] bun test (server) → 3 tests 全绿
    [ ] preview publish 双包:
        @sleep2agi/agent-network@2.1.8-preview.1 --tag preview
        @sleep2agi/commhub-server@0.8.1-preview.1 --tag preview
    [ ] PINNED_SERVER_VERSION 同步 agent-network/bin/cli.ts
    [ ] Vincent 亲测 anet hub start + agent-node 派单 → ack
    [ ] 通过 → 自动进 SDK-4

[ ] SDK-4: @inquirer/prompts 7.10 → 8.4 (agent-network)
    [ ] agent-network/package.json: dep "^8.4.3"
    [ ] bun run build → 注意 TS 报错（如有立即 escalate）
    [ ] manual smoke:
        - anet setup (checkbox + confirm)
        - anet network create (select)
        - anet node create (dynamic select)
    [ ] preview publish: @sleep2agi/agent-network@2.1.8-preview.2 --tag preview
    [ ] Vincent 亲测 anet setup 全交互 → ack

[ ] 全部完成
    [ ] 三包同步 latest tag:
        @sleep2agi/agent-network@2.1.8 (latest)
        @sleep2agi/agent-node@2.3.1 (latest)
        @sleep2agi/commhub-server@0.8.1 (latest)
    [ ] docs/changelog.md 加 entry
    [ ] 任何回归 → Phase 1 §6 SOP 一键回滚
```

## 铁律继续守

- ❌ 不动 deprecated `--token` sweep（通信文档马在做）
- ❌ 不发 latest（只 preview）
- ❌ 不在生产 hub 测
- ❌ 不动 PR queue（#19/20/21/23/24/26/28/29）
- ✅ 一阶段一 ack；MCP 即使 medium 也走 escalate 路径

## 状态变更

- 2026-05-13 Phase 2 完成：4 SDK 影响分析齐全 / MCP sub-path 实测验证 / Phase 3 checklist 完整。等通信龙 review + 决策 MCP escalation 时机。
