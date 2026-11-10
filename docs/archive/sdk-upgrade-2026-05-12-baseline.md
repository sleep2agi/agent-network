# SDK 升级 — 2026-05-13 baseline 快照 + 回滚 anchor

| 字段 | 内容 |
|---|---|
| 状态 | **Phase 1 完成，等通信龙 + Vincent ack 后启动 Phase 2** |
| 提出 | 2026-05-13 |
| 作者 | 通信SDK马 |
| 任务来源 | 通信龙转 Vincent：[\"对 anet 用到的 SDK 做升级。**铁律：升级不影响老功能**\"](https://github.com/sleep2agi/agent-network/issues/18) |
| 阶段铁律 | Module-by-Module — 每阶段 ack 后才推下一阶段（feedback_module_by_module）|

## 摘要

本文档是 anet 三包 SDK 升级前的**现状快照 + 回滚 anchor**。出现升级回归时，按 §6 SOP 可一键回滚到 baseline。

后续 Phase 2（升级清单 + 影响分析）和 Phase 3（实施 + 回归）将在本文档 ack 后另开。

## §1 当前 npm dist-tags（rollback target）

```
@sleep2agi/agent-network:    { latest: '2.1.7',  preview: '2.1.7-preview.2' }
@sleep2agi/agent-node:       { latest: '2.3.0',  preview: '2.3.1-preview.0' }
@sleep2agi/commhub-server:   { latest: '0.8.0',  preview: '0.8.0-preview.2' }
```

**Rollback target**（出问题立刻回到这里）：

- agent-network → `@sleep2agi/agent-network@2.1.7`
- agent-node → `@sleep2agi/agent-node@2.3.0`
- commhub-server → `@sleep2agi/commhub-server@0.8.0`

## §2 三包 package.json SDK 依赖快照

### `@sleep2agi/agent-network` v2.1.7（CLI 入口）

```json
{
  "dependencies": {
    "@inquirer/prompts": "^7.10.1"
  },
  "devDependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "node-pty": "^1.1.0",
    "typescript": "^5.0.0",
    "javascript-obfuscator": "^5.4.1",
    "@types/node": "^25.0.0"
  }
}
```

### `@sleep2agi/agent-node` v2.3.1-preview.0（Agent 运行时）

```json
{
  "dependencies": {
    "@anthropic-ai/claude-agent-sdk": "^0.2.96"
  },
  "peerDependencies": {
    "@openai/codex-sdk": ">=0.118.0"
  },
  "peerDependenciesMeta": {
    "@openai/codex-sdk": { "optional": true }
  }
}
```

### `@sleep2agi/commhub-server` v0.8.0（CommHub 服务）

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0"
  }
}
```

### SDK 升级目标（4 个）

| SDK | 当前声明 | 当前实际安装（doctor 显示） | npm latest | 落后 minor |
|---|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | `^0.2.96` | **v0.2.105**（caret 拉到 0.2.x latest）| **0.2.139** | 34 |
| `@openai/codex-sdk` | `>=0.118.0`（peer optional）| 用户全局装的 latest | **0.130.0** | 12 |
| `@modelcontextprotocol/sdk` | `^1.12.0` | caret 拉到 1.x latest | （需查 latest）| ? |
| `@inquirer/prompts` | `^7.10.1` | caret 拉到 7.x latest | （需查 latest）| ? |

> ⚠️ \"声明 / 实际安装 / latest\" 三个数字不同 — `^0.2.96` semver caret 会自动拉到 `0.2.x` 但不跨 `0.3.x`，所以实际安装是 `0.2.105` 而非 `0.2.96`，但跟 `0.2.139` 还差 34 minor。

### 不动（hold）

按通信龙列的 \"runtime / 工具类\"，本轮**不升级**：

- `bun` / `@types/node` / `typescript` / `javascript-obfuscator`

除非 SDK 升级强需求带动（如新 SDK 要求 `typescript >= 5.x` 而当前 5.0），否则保持现状。

## §3 SDK 使用面 grep（升级 break 风险面）

### claude-agent-sdk（仅 agent-node 用）

`agent-node/src/cli.ts`：

| 行 | API / 引用 | 升级风险点 |
|---|---|---|
| L381 / L399 / L498 | `require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/claude")` | glibc 二进制 sub-package 名是否稳定 |
| L394-395 | `npm install @anthropic-ai/claude-agent-sdk-linux-x64` (on-the-fly 安装) | 子包发布节奏是否跟主 SDK 一致 |
| L437 | `const { query } = await import("@anthropic-ai/claude-agent-sdk")` | `query` named export 是否仍存 |
| L517-540 | `query({ prompt, options })` + options 字段 (model / tools / maxTurns / permissionMode / allowDangerouslySkipPermissions / settingSources / mcpServers / pathToClaudeCodeExecutable / env / cwd / stderr / hooks / maxBudgetUsd / systemPrompt / resume) | 16 个 Options 字段 — 任何被 deprecated / renamed 都 break |
| L546-561 | `for await (const m of query(...))` + 处理 `m.type === 'system' && m.subtype === 'init'` / `m.type === 'result'` | SDKMessage union 演进（已知 0.2.105 → 0.2.139 加了 6 种 type，向后兼容看 union shape）|
| L533-537 | `hooks.PreToolUse` callback 注册 | HookEvent / HookCallback 签名是否稳定 |

**升级 break 风险面**：中。**主要风险**是 `query()` Options 字段重命名 / 类型收紧。SDKMessage union **新增**变体一般向后兼容（`for await` 主循环只识别已知 subtype，未识别走 default branch）。

### codex-sdk（仅 agent-node 用）

`agent-node/src/cli.ts`：

| 行 | API |
|---|---|
| L619 | `await import("@openai/codex-sdk")` 拿 `Codex` class |
| L625 / L679 | `new Codex({ config: CODEX_CONFIG })` |
| L626-633 | codex options（skipGitRepoCheck / approvalPolicy / model / sandboxMode / modelReasoningEffort）|
| L635 | `codex.resumeThread(SESSION_ID, codexOpts)` |
| L638 / L680 | `codex.startThread(codexOpts)` |
| L651 | `codexThread.runStreamed(input)` |
| L687 | `codexThread.run(input)` (catch 重试路径) |

**升级 break 风险面**：低（R26 已证实 codex-sdk 0.118 → 0.130 12 版本 API surface **完全冻结**）。

### MCP SDK（agent-network 用作 stdio server / commhub-server 用作 HTTP server）

`agent-network/src/node-server.ts`：

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { /* tool types */ } from "@modelcontextprotocol/sdk/types.js";
```

`server/src/index.ts` + `server/src/tools.ts`：

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
```

**升级 break 风险面**：**高** —— @modelcontextprotocol/sdk 是 anet 通信中枢，且 commhub-server 用了 `WebStandardStreamableHTTPServerTransport` 这种相对新的 transport，1.12 → latest 之间 sub-path 变化可能很大。

Phase 2 重点 review 这个。

### @inquirer/prompts（仅 agent-network CLI UX）

未做完整 grep。本轮 Phase 1 标 **待补**（Phase 2 grep + 风险分析时一并）。

## §4 现有 smoke 矩阵（升级回归 gate）

### 自动化 test files

| 包 | test 文件 | 跑法 |
|---|---|---|
| agent-network | `agent-network/src/client.test.ts` | `bun test` |
| commhub-server | `server/src/auth-validate.test.ts` | `bun test` |
| commhub-server | `server/src/password-dict.test.ts` | `bun test` |
| commhub-server | `server/src/auth-tokens.test.ts` | `bun test` |
| agent-node | （无自动化 test）| smoke 靠手动 |

### 手动 smoke 套件（`tests/` 目录）

```
tests/archive/
tests/docker-e2e/
agent-network/tests/archive/
agent-node/tests/qa-ut-01-auth-tokens/
agent-node/tests/qa-ut-02-password-dict/
agent-node/tests/qa-ut-03-auth-validate/
docs/tests/
server/tests/
```

### 升级回归 gate（**至少这些原绿的还绿**）

```bash
# Pre-upgrade baseline (run these now, save outputs as comparison)
cd /home/vansin/agent-orchestra/agent-network && bun test 2>&1 | tee /tmp/baseline-agent-network.log
cd /home/vansin/agent-orchestra/server          && bun test 2>&1 | tee /tmp/baseline-server.log

# Build sanity (no test but compile must succeed)
cd /home/vansin/agent-orchestra/agent-network && bun run build 2>&1 | tee /tmp/baseline-build-agent-network.log
cd /home/vansin/agent-orchestra/agent-node    && bun run build 2>&1 | tee /tmp/baseline-build-agent-node.log

# Smoke: spin up commhub locally + start one agent-node + run docker-e2e if applicable
```

**注**：Phase 2 实施前补全跑一遍 baseline，**所有原绿的回归后必须仍绿**。

## §5 PINNED_VERSION 同步现状

### 源码内 PINNED（必同步）

`agent-network/bin/cli.ts`：

```ts
const PINNED_SERVER_VERSION = "0.8.0-preview.2";        // ← agent-network hub start 用
const PINNED_DASHBOARD_VERSION = "0.4.5-preview.1";     // ← 不在本次 SDK 升级范围
```

**升级影响**：commhub-server 升级后**必须**bump `PINNED_SERVER_VERSION` → 否则 `anet hub start` 仍拉旧 server。

### docs-site changelog 历史（不必同步）

`docs-site/docs/changelog.md` 记录历史版本对应关系（v2.1.7 ↔ 0.8.0 等），属归档。升级**不动 changelog 历史**，新增 entry 即可。

### install scripts / README

未做完整 grep。本轮 Phase 1 标 **待补**（Phase 2 时若涉及 docs 同步 SOP，专列）。

## §6 升级失败回滚 SOP

### 一键全回滚（本机）

```bash
#!/usr/bin/env bash
# rollback-anet-sdk-upgrade.sh
set -e
echo "=== Rolling back to 2026-05-13 baseline ==="

npm uninstall -g @sleep2agi/agent-network 2>/dev/null || true
npm install -g @sleep2agi/agent-network@2.1.7

# agent-node 是 npx 启动，自动会从 npm cache 拉
# 但如果显式安装了，也回滚
npm uninstall -g @sleep2agi/agent-node 2>/dev/null || true
npm install -g @sleep2agi/agent-node@2.3.0

# commhub-server 是 agent-network 内部 spawn npx，回滚靠 PINNED 同步
# 但如果某测试机直接装了 server：
npm uninstall -g @sleep2agi/commhub-server 2>/dev/null || true
npm install -g @sleep2agi/commhub-server@0.8.0

echo "=== Rollback done. Versions: ==="
anet --version 2>&1 || echo "anet 不在 PATH"
echo "Pinned server: 0.8.0 / pinned dashboard: 0.4.5-preview.1"
echo ""
echo "Next: run 'anet doctor' to verify"
```

### 关键点

1. **本脚本只回滚 npm 包**，不动 commhub.db、`.anet/` 配置、节点日志（这些是用户数据，不能丢）
2. **不动 SDK 子包**（`@anthropic-ai/claude-agent-sdk` 直接是 agent-node 的 dep，npm 重装 agent-node 时自动恢复 caret 范围）
3. **PINNED_VERSION 一致性**：agent-network 内 `PINNED_SERVER_VERSION` / `PINNED_DASHBOARD_VERSION` 必须**跟回滚后的 agent-network 版本配套**。`agent-network@2.1.7` 已经 PINNED 到 `commhub-server@0.8.0-preview.2`，所以回滚 agent-network 后 `anet hub start` 自动拉对的 server。
4. **测试机一键**：如果用 ssh 多机部署，需要 ansible / fab 之类同步执行。**本轮 Phase 1 只覆盖单机回滚**。

### 验证回滚成功

```bash
# 期望输出：
anet --version              # → 2.1.7
npx @sleep2agi/agent-node --version  # → 2.3.0
npx @sleep2agi/commhub-server --version  # → 0.8.0 (if installed)

# 跑一次 anet doctor 确认 SDK 链路 OK
anet doctor
```

## §7 关联背景研究（R19-R26 staged）

issue #18 /loop 已经做了 **16 轮 SDK 版本漂移 + SaaS 多租户研究**，详细 staged 在 `~/anet-work/sdk-research-rfcs/SDK-VERSION-DRIFT-MEMO.md`（未 commit / 不 push，等 PR #23 RFC-003 merge 后 promote）。Phase 2 影响分析时**可复用**：

- claude-agent-sdk 0.2.96 → 0.2.139：+6 SDKMessage（含 `SDKMemoryRecallMessage` / `SDKTaskUpdatedMessage` 等）+ 2 hooks（`PostToolBatch` / `UserPromptExpansion`）+ 9 Options 字段（含 `sessionStore` / `skills` / `managedSettings` 三大 SaaS 重器）
- codex-sdk 0.118.0 → 0.130.0：**完全冻结**（ThreadItem / ThreadEvent / ThreadOptions / TurnOptions / CodexOptions 全部零变化）
- `SessionKey.projectKey` 注释明确写 \"Multi-tenant deployments should set this to a tenant ID\" — SDK 已为 SaaS 多租户预留 hook
- `forkSession()` / `enableFileCheckpointing` + `rewindFiles()` / `Options.fallbackModel` / `canUseTool` 等 SDK 新能力盘点

Phase 2 直接引用这些研究就能给出每个 SDK 升级的 break-risk 详细评估。

## §8 Phase 2 / Phase 3 预告

**Phase 2**（本文档 ack 后启动）：

- 每个 SDK 给：目标版本 / changelog 关键 breaking change / anet codebase 用法是否被 break / 风险等级（high/medium/low）/ 推荐顺序
- 建议优先升风险低的：codex-sdk（完全冻结，0 风险）→ claude-agent-sdk（中等，已知新 union 变体）→ @modelcontextprotocol/sdk（高，需详细 review sub-path 变化）→ @inquirer/prompts（待评估）

**Phase 3**（Phase 2 ack 后启动）：

- 一次升一个 SDK，跑回归（§4 smoke 矩阵）
- 通过 → 下一个
- 失败 → §6 SOP 立即回滚 + incident note
- 全部通过 → 集中 publish **preview**（NOT latest，per `feedback_release_preview_first`）

## 铁律

- ❌ 不允许跳 Phase 1 直接升级
- ❌ 不动 deprecated `--token` sweep（通信文档马在做）
- ❌ 不发 latest，发 preview，等 Vincent 亲测 ack
- ❌ 不在生产 hub 测（`feedback_no_test_on_prod`，`feedback_no_prod_db_access`）
- ✅ 每阶段独立 push + ping 通信龙 review + Vincent ack

## 状态变更

- 2026-05-13：Phase 1 baseline doc 完成（通信SDK马）。等通信龙 + Vincent ack 后启动 Phase 2。
