# agent-node 2.5.0-preview.124

自 `.123`（发版合并 `c47708c5`，#2489）以来，`agent-node/` 有 2 个改动（`git log c47708c5..<发版提交> -- agent-node/`）：

| 提交 | PR | 内容 |
|---|---|---|
| 962cc5a9 | #2487 | 看板 #703（PR-A）：codex app-server 节点在回合中途被重启 / 崩溃后，重启时为原任务补发回执，不重新执行 |
| cf7b6e18 | #2493 | 看板 #720：codex 启动时给 commhub MCP 带 `default_tools_approval_mode="approve"`，commhub 工具首次调用不再停在审批提示上 |

（同期合入、不在本包里的：#2490 Hub 任务状态 `abandoned` 和 #2492 随 commhub-server；#2491 只改官网下载页；#2493 的 anet 部分（共存 app-server 启动参数）随 agent-network 下一次发版。）

## 🔴 升级须知

- 🔴 （沿用 `.120`）**先升 Hub，再在生产节点上用本版。**
- 🔴 （沿用 `.117`）codex / grok / claude 不在系统目录时，先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。
- codex app-server 节点会在节点目录新增 `codex-turn-receipts.json`（回执账本）。

## 你会看到的变化

### 重启后补发原任务的回执（#2487，#703）

- 回合被 codex 接收时，把 任务 id / inbox 行 / 回复对象 / thread / turn 记进节点目录的 `codex-turn-receipts.json`；写不进去就让这个回合失败，不假装可以恢复。
- 重启后先重发 `pending-replies` 里已排队的原回复；账本里剩下的行再用 `thread/turns/list` 查那一个确切的 turn，按结果补发回执。被打断的 turn 回 `turn 中断于 HH:MM（东八区）`；codex 没给完成时间时回 `最晚于 HH:MM（东八区）判定中断`。
- 恢复过程不调用 `turn/start`，也不重新处理任务。
- 本版是 #703 的 PR-A：不改 Hub 存储和终态任务语义；Hub 端的迟到回复（`late=true` / `late_replies`）在 PR-B，未包含。
- 查询失败的行保留、下次重试；Hub 48 小时内一直不接收的排队回执会丢弃并打 warn；Hub 应用层拒绝、对端终态回复都会清掉账本行。

### commhub MCP 工具免审批（#2493，#720）

- 以前 codex 第一次调用每个 commhub 工具都会问「Allow the commhub MCP server to run tool …?」，`approval_policy` 管不到它；无人值守的节点没人回答，回合卡住直到 Hub 超时。
- agent-node 自己起的 app-server（`-c mcp_servers.commhub.default_tools_approval_mode="approve"`）和 codex-sdk 配置都带上这一项。只作用于 commhub，其他 MCP server 保持 codex 默认。
- 用户在自己的配置里给某个 commhub 工具单独写 `approval_mode="prompt"` 时，仍以用户为准。

两项都不经过数据库，也不要求升级 Hub。

## Install

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.124
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.124
```

升级后重启 daemon（`anet daemon restart <名字>`）和节点才会生效。
- 源码里的配对 `PAIRED_AGENT_NODE_VERSION` 已移到 `.124`；已发布的 agent-network `2.3.0-preview.155` 仍配对 `.123`，配对本版的是随后的 agent-network `2.3.0-preview.156`。

## 回滚

```bash
npm i -g @sleep2agi/agent-node@2.5.0-preview.123
```

再重启 daemon 和节点。`.123` 不读 `codex-turn-receipts.json`，留着无害；回滚后被中断的回合不会再补发回执，commhub 工具首次调用会重新出现审批提示。

## 证据

- #2487：`agent-node/src/runtime/codex-app-server/receipt-ledger.test.ts`、`receipt-inspection.test.ts`、`receipt-wiring.test.ts`；真实 codex 0.133.0 / 0.159.2 停启探针，报告见 `docs/tests/report-test703-codex-turn-receipts.txt`（9 个变异都变红）。
- #2493：`tests/test720-codex-commhub-tool-approval/`（Docker，真实 codex 0.133.0 / 0.159.2 app-server，假模型 + 假 commhub MCP；对照组不带该项时出现提示；变异 M1–M7 变红），报告见 `docs/tests/report-test720.txt`。
- 未在真实生产节点 / daemon 上验证。

## promote 时的 must_contain

`"version": "2.5.0-preview.124"`
