# Runtime 集成成果固化：codex-app-server / grok co-presence / opencode

状态日期：2026-07-13（北京时间）

**纪律声明**：本文档反映**真实门状态**——未过独立审查的一律标"锁定/审查中"，能力描述**仅覆盖已验证的代码路径**，不 overclaim。各 runtime 段落由对应 owner 复核后固化。`latest`/生产发布需 Vincent 单独授权且必须先过安全门。

---

## 1. codex-app-server —— OpenAI Codex TUI 正式 runtime（RFC-030 Policy Gateway，方案 B）

**是什么**：把 OpenAI Codex 的 TUI 作为 anet 正式 runtime，用单入准入的 Policy Gateway 做人+agent 共用 TUI 的网络任务仲裁。

**当前状态（渠道要写清楚，不能只写 runtime 名）**：
- `codex-app-server` 是真实存在的 runtime：生产上已有共存节点在跑，实测路径来自源码分支 / 本地脚本编排。
- **未进入已发布 npm 包**。已发布包里拿 `--runtime codex-app-server` 不能等同于可用；今晚实测发现旧发布包会静默回落到 `claude`，不报错。已开 issue #491 跟修复。
- `--help` 不列出它不构成不存在证据；同类隐藏开关还包括 grok 的 `--leader`、opencode 的 `--copresence`。反过来，grep 已发布 dist 也不能作为否定证据，dist 混淆会产生字面量假阴性。
- 生产化分块门：**Commit1（凭据 scrub + 泄漏 detector）已 FINAL FREEZE PASS @ `bd0dfd7`**——仅内部冻结完成，**不等于发布**；Commit2（lifecycle teardown）审查中；§8 独立安全审查、Wave2、merge、prod、`latest` **全锁**。

**怎么用**（源码分支姿态，只保证已实测路径；门卫未解锁）：
```
anet node create <name> --runtime codex-app-server && anet node start <name>
```
隔离真机 smoke 已验证：写入 runtime=codex-app-server、真实 agent-node 拉起、节点注册成功。**但这只适用于含该 runtime 的源码分支 / 明确已真跑验证的版本；公开文档必须同时标明具体包版本或源码 commit。**

**判据纪律**：只有真跑才算数。最低验证应包含：
1. 创建 / 启动后节点自报 `agent-node:codex-app-server` 或等价 runtime 标识，而不是回落到 `claude`。
2. 派一个短任务确认 codex app-server thread 真实响应。
3. 若是共存节点，检查 app-server 进程 cwd：`readlink /proc/<app-server-pid>/cwd`。codex thread 的工作目录继承自 app-server 进程，不继承桥进程；只查桥进程 cwd 会漏掉风险。

**证据**：RFC-030 `docs/rfcs/RFC-030-codex-tui-bridge.md`；tracking issue #428；PR #433（doc）、#441（CLI）；Commit1 `bd0dfd7`。

**关键技术结论**：单入准入 gateway 取代多客户端语义；codex-cli 0.144.0 真实首包 = HTTP `GET /rpc` + `Upgrade: websocket`（与早期 RFC 写的 UDS+bearer 不符，已按实测修订）；安全不变量锁定 SQLite，PG 路径 fail-closed。

**开放门**：Commit2 lifecycle 整改、§8 独立安全审查、生产授权。

_owner：副指挥（待复核）_

---

## 2. grok co-presence —— grok 原生 TUI 人机共存 runtime（grok-agent-leader）

**是什么**：grok 原生 TUI 做人机共存——人在 TUI 输入即对网络说话，网络消息 live 渲染进同一 TUI。

**当前状态**：
- 源码版，**未发 npm**（grok-build-cli 共存 lane 目前 source-only）。
- Phase0 真机 wire fixture：Round5 证据经独立审查**部分接受**；决定性 P0 中——**approval-owner 已过**（独立 persisted wire tap），**exact method/enum allowlist 未过**（未知 method/enum 仍被泛化成占位并被 verifier 接受，Round6 重做，反例须从 raw 入口真转红）。
- Phase1A **锁定**；Phase2「TUI owner 安全处理外部审批」标为 **possible no-go**；agent turn approval 硬 pin = **never**。
- 设计文档已冻结（base SHA `87b47cf4…`）。

**怎么用**（源码/仓根，需精确 `grok 0.2.93` build）：
```
anet node create <name> --runtime grok-build-cli && anet node start <name>
anet grok attach <name>
```
ACP headless lane：`--runtime grok-build-acp`。
> 注：grok-build-cli 接到 anet 层 CLI 的入口尚有 gap（anet CLI 目前只暴露 grok-build-acp），待补。

**证据**：设计 `docs/plans/grok-agent-leader-runtime-design.md`（+ `-addendum-hub-lease.md`）；wire 分析 `docs/analysis/grok-agent-leader-phase0-wire.md`；报告 `docs/tests/report-test223.txt`；tracking #439。

**关键技术结论**：顶层 TUI 必须传**隐藏 flag `--leader`**（非仅 `--leader-socket`）才能 live 渲染网络 turn；native IPC = uint32-BE length prefix + UTF-8 outer JSON + ACP inner JSON-RPC；grok agent serve/leader/stdio 架构；Hub DeliveryConsumerLease（#440）与本机 TurnReservation/TuiOwnerLease 两层不合并。

**开放门**：exact allowlist raw-entry 转红（Round6）、100 轮 race/Busy、half-close/recovery、cancel/interrupt、human approval、serve close、transport 碎片化 late-reset、Hub #440。

_owner：通信牛（待复核）_

---

## 3. opencode —— keyless 免费模型节点（远程 MCP / opencode-cli）

**是什么**：opencode 作为 anet 节点接入，keyless（免费模型）即可全链路跑通。

**当前状态**：
- **keyless 全链路已验通**（P4：Docker 隔离 hub + opencode-cli + 免费模型，~7s，零 key）。
- 接入方式：远程 MCP（`mcp.commhub` type:remote + Bearer ntok）作为节点；anet CLI picker 含 `opencode-cli` 选项。
- 共存：serve + attach 已验通（POST `/session/:id/message` + SSE）。

**怎么用**：免费模型 `deepseek-v4-flash-free` / zen free 无需 key；远程 MCP 接入配置见 research 文档。
> 注：opencode 经 `anet --runtime opencode-cli` 的确切起法待核实（opencode 主要以远程 MCP 节点接入，与 agent-node 内置 runtime lane 不同）。

**证据**：`docs/research/opencode-serve-attach-copresence.md`；P4 keyless 验证记录。

**关键技术结论**：keyless 免费模型证明 vendor key 降为**质量选项**、非上手硬门槛；opencode serve+attach 做共存；出站 MCP 通、入站走 SSE 推流。

_owner：待指定（龙/副指挥 核实 opencode 段）_

---

## 汇总门状态（一眼看清）

| Runtime | npm | 独立审查进度 | 可发布？ |
|---|---|---|---|
| codex-app-server | 已发布 npm 未含；源码分支/明确版本需真跑验证 | Commit1 冻结通过；Commit2 审查中；§8 未过；#491 跟进发布包静默回落 | ❌ 锁定（待 §8 + Vincent 授权）|
| grok co-presence | 未发（source-only）| Phase0 部分接受；allowlist P0 待 Round6；Phase1A 锁 | ❌ 锁定 |
| opencode | preview picker 含 | keyless 全链路验通 | ⚠️ 可预览用，latest 待 Vincent 授权 |

**统一红线**：未过独立审查的能力不写成"已支持"；`latest`/生产发布一律 Vincent 单独授权 + 过安全门；能力描述必须对得上已过审代码路径。
