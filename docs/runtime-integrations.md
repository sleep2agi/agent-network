# Runtime 集成成果固化：Codex / Grok / OpenCode

状态日期：2026-07-13（北京时间）

> 本文只描述已有证据支持的能力。未过独立审查的项目一律标为“审查中”或“锁定”；`latest`、生产发布和安全门豁免均不由本文授权，仍需 Vincent 单独批准。

## 1. codex-app-server —— Codex TUI preview runtime 与生产候选（RFC-030）

### 定位

`codex-app-server` 的目标是把 OpenAI Codex TUI 接成 anet 的独立 runtime。当前 npm preview 仍是 Phase 0 的 direct-client 形态；目标生产设计采用单 upstream Policy Gateway，由 gateway 仲裁 Human/TUI 与 Agent 的任务、会话和回复生命周期。不能把已发布 preview 和尚未合并的生产 gateway 写成同一个成熟度层级。

### 当前门状态

- `@sleep2agi/agent-node@2.5.0-preview.20` 包含 Phase 0 direct-client preview runtime；Policy Gateway 仍在未合并的 Wave 1 工作中。
- **Commit 1 FINAL FREEZE PASS @ `bd0dfd7`**：凭据 scrub、子进程环境 allowlist、TUI admission/lease、真实 Codex 0.144.0 bootstrap smoke 等 A-layer 能力完成内部冻结审查。
- 上述 freeze pass **只表示该提交可作为后续集成的冻结基线，不表示可发布或可部署**。
- Commit 2（lifecycle teardown / truthful terminal state）尚无 PASS：首个候选 `d2ca6f0` 为 REQUEST CHANGES，corrective `eb22db2` 仍在整改和复审中。
- Wave 1 integrated checkpoint、RFC-030 §8 独立安全审查、Wave 2、merge、部署、生产 enablement、package promotion 和 `latest` **全部锁定**。

### CLI 入口

[Draft PR #441](https://github.com/sleep2agi/agent-network/pull/441) 中的 runtime 值是 `codex-app-server`：

```bash
anet node create <name> --runtime codex-app-server
anet node start <name>
```

该命令已在 PR 分支的隔离环境验证“配置写入为 `codex-app-server`、agent-node 拉起、节点注册成功”。当前发布的 `@sleep2agi/agent-network@2.3.0-preview.22` 尚未包含 #441 对 explicit create/picker 和 start dispatch 的修复，因此这不是当前 npm preview 的可靠入口。证据范围仅是 **CLI 候选的启动与注册**；它不证明 Policy Gateway 已通过 §8，也不解锁生产流量。

### 已核实的技术事实

- 固定证据版本为 `codex-cli 0.144.0`。真实 TUI 启动命令形态是 `codex --remote ws://127.0.0.1:<port> --remote-auth-token-env <env-name>`。
- WebSocket Upgrade 使用根路径 **`/`**，不是 `/rpc`；Bearer 值经环境变量提供，不进入 argv。
- Codex frame 是 WebSocket text JSON，`jsonrpc` 字段可省略。bootstrap smoke 只证明第一个 authorizer 调用是 `account/read`；当前 `GatewayLifecycle` 的生产 authorizer 仍是**空 allowlist、默认拒绝**，不能把 smoke 扩写成“四个读取方法已在生产放行”。
- Durable gateway ledger 固定使用本地 SQLite：Bun 走 `bun:sqlite`，Node 需 `node:sqlite` 且版本至少为 22.13；不满足条件时只让该 runtime fail closed。当前不声称存在 PostgreSQL gateway-ledger 路径。

### 证据

- [RFC-030](rfcs/RFC-030-codex-tui-bridge.md)
- [Tracking issue #428](https://github.com/sleep2agi/agent-network/issues/428)
- [Implementation-plan PR #433](https://github.com/sleep2agi/agent-network/pull/433)
- [CLI PR #441](https://github.com/sleep2agi/agent-network/pull/441)
- [Commit 1 `bd0dfd7`](https://github.com/sleep2agi/agent-network/commit/bd0dfd7)
- Commit 2 candidates：`d2ca6f0`（REQUEST CHANGES）、`eb22db2`（corrective，仍待修/复审）

**Owner 复核**：副指挥。Commit 2、§8、Wave 2 和所有发布门仍开放。

## 2. grok co-presence —— Grok 原生 TUI 人机共存 runtime（grok-agent-leader）

### 定位

目标是让 Grok 原生 TUI 成为人机共存界面：Human 在 TUI 中输入，网络任务也在同一个 TUI 中呈现；headless ACP lane 与 co-presence lane 分开。

### 当前门状态

- 目前是 source-only，尚未发布 npm runtime。
- Phase 0 Round 5 的 persisted owner fixture 已完成部分独立审查：approval-owner 的独立 wire tap 证据已通过。
- exact method/enum allowlist **未通过**：未知 method/enum 仍可能先被泛化为占位值，再被 verifier 接受。Round 6 必须从 raw/native frame 入口证明未知值真正 omit 或 fail closed；不能从 post-sanitize artifact 起测。
- Phase 1A 锁定；Human approval、100 轮 Busy/race、half-close/recovery、cancel/interrupt、serve close、transport late-reset 和 Hub #440 等门仍开放。
- Agent turn approval 仍固定为 `never`；TUI owner 处理外部 approval 仍可能 no-go，不能写成已支持。

### 当前源码入口

设计中的 co-presence runtime 值是 `grok-build-cli`，headless ACP runtime 是 `grok-build-acp`：

```bash
anet node create <name> --runtime grok-build-cli
anet node start <name>
anet grok attach <name>
```

这组命令目前只是 source lane 的目标入口：公开 anet CLI 尚未完整暴露 `grok-build-cli`，因此不能作为已发布的复制即用命令。现有 headless lane 可继续使用 `--runtime grok-build-acp`。

### 已核实的技术事实

- 顶层 Grok TUI 需要隐藏 flag `--leader` 才能 live render network turn；只有 `--leader-socket` 不足。
- Native IPC 是 uint32-BE length prefix + UTF-8 outer JSON，载荷内承载 ACP JSON-RPC。
- Hub `DeliveryConsumerLease` 与本机 `TurnReservation` / `TuiOwnerLease` 是不同责任层，不能合并成同一种 lease。
- Phase 0 使用固定 Grok build 进行抓包和 fixture 审查；这不等于 runtime 已具备生产兼容范围。

### 证据

- `docs/plans/grok-agent-leader-runtime-design.md`
- `docs/plans/grok-agent-leader-runtime-design-addendum-hub-lease.md`
- `docs/analysis/grok-agent-leader-phase0-wire.md`
- `docs/tests/report-test223.txt`
- [Tracking issue #439](https://github.com/sleep2agi/agent-network/issues/439)
- [Shared Hub ownership dependency #440](https://github.com/sleep2agi/agent-network/issues/440)

**状态依据**：通信牛的 Round 5 committed candidate、独立 gate verdict 与 tracking 记录。Phase 1A、Hub #440 和发布门保持锁定；本 Draft PR 继续请求 runtime owner 复核。

## 3. opencode-cli —— 自动 ACP 节点；MCP-only 是独立的人驱动模式

### 两条接入路径

- **自动节点**：canonical runtime 是 `opencode-cli`（`opencode` 是归一化 alias）。`anet node start` 把配置交给 agent-node；agent-node 订阅 CommHub SSE/inbox，并通过常驻 `opencode acp` stdio 子进程处理任务和自动回复。
- **MCP-only**：现有 OpenCode 会话可通过 Hub `/mcp` 主动调用通信工具。该模式不会订阅任务 SSE，也不会在来活时自动唤醒，因此不能称为全自动节点，也不能替代 `opencode-cli` runtime。

### 当前状态

- runtime enum、normalize、start dispatch 和 agent-node ACP 主链已合入 `main`；内置 pin 是 `opencode-ai@1.17.13`。
- 隔离 Docker 已验证 keyless Hub 闭环：`send_task → SSE → ACP session → 免费模型回复 → task replied`，约 7 秒且无 vendor key。
- 该证据直接配置了 agent-node 和隔离的 OpenCode HOME，证明 runtime 内核与 Hub 闭环；它**不等于公开 `anet node create/start` 已经完成零摩擦 keyless onboarding**。

### 源码对应的 runtime 入口

```bash
npm install --global opencode-ai@1.17.13
anet node create <name> --runtime opencode-cli
anet node start <name>
```

上述 runtime 值与 start dispatch 的源码一致，但当前公开 CLI 仍有三个缺口，修复前不能把这组命令宣传为“安全、零 key、复制即用”：

1. named TTY create 的 explicit-runtime 判断和局部 picker 漏了 `opencode-cli`，显式 flag 可能被交互选择覆盖；
2. profile 的 `--model` 会落盘，但 OpenCode ACP runtime 没有读取它，不能靠 `--model` 选择免费模型；
3. OpenCode child HOME 当前来自 `process.cwd()`，未使用已解析的 per-node `NODE_DIR`，公开 `anet node start` 尚未实现文档所声称的 per-node HOME 隔离。

因此当前只能确认 source runtime 和已验证内核，不提供规避这些缺口的临时生产做法。MCP-only 配置适合人驱动主动通信，不是自动节点的替代方案。

### keyless 证据边界

- 已验证的免费模型路径使用 `opencode/deepseek-v4-flash-free`，证明 vendor key 不是**活体验证**的硬前置。
- 这不承诺免费代理长期可用、配额稳定、模型不变或具备生产输出质量。
- Anthropic/OpenAI paid-vendor live path 不在 keyless 证据范围内。
- `opencode serve + attach` 只证明本地共存/TUI 路径，不能替代 CommHub 自动节点闭环证据。

### 证据

- [OpenCode integration research](opencode-deep-research.md)
- [RFC-029 real ACP/free-model kernel gate](tests/p-rfc-029-pr4-kernel-live/verify-summary.md)
- [MCP-only capability boundary](opencode-mcp-node.md)
- [RFC-029 kernel-live PR #408](https://github.com/sleep2agi/agent-network/pull/408)

**Owner 复核**：副指挥。Source runtime 与 keyless kernel/Hub 闭环已验证；公开 CLI onboarding 和发布状态仍未完成。

## 汇总门状态

| Runtime | 代码/发布形态 | 独立审查与证据 | 发布状态 |
|---|---|---|---|
| `codex-app-server` | Draft/preview candidate | Commit 1 内部冻结通过；Commit 2 审查中；§8 未过 | **锁定**：Wave 2、merge、生产、`latest` 均未授权 |
| Grok co-presence | source-only | Phase 0 部分通过；exact allowlist P0 待 Round 6；Phase 1A 锁定 | **锁定** |
| `opencode-cli` | 主链 source 已合 `main`，未据此宣称 preview 已发布 | keyless Docker 闭环已验证；公开 CLI/HOME onboarding 有三个缺口 | **未完成公开发布门** |

## 统一红线

- 未过独立审查的能力不得写成“已支持”。
- Fixture、kernel smoke、source wiring 和公开 CLI onboarding 是不同证据层，不能互相替代。
- MCP-only、headless runtime 与 TUI co-presence 必须分开描述。
- `latest`、生产部署和安全门豁免一律由 Vincent 单独授权。
