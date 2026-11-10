# agent-network 2.3.0-preview.156

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.156`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.124`（见 [`release-v2.5.0-preview.124.md`](./release-v2.5.0-preview.124.md)）。

自 `.155`（发版合并 `c47708c5`，#2489）以来，`agent-network/` 有 1 个代码改动（`git log c47708c5..<发版提交> -- agent-network/`；另有 #2495 只移动配对版本号）：

| 提交 | PR | 内容 |
|---|---|---|
| cf7b6e18 | #2493 | 看板 #720：anet 起的 codex 共存 app-server（POSIX tmux 与 Windows 两条启动路径，共用 `src/codex-commhub-mcp.ts` 一份参数表）带 `-c mcp_servers.commhub.default_tools_approval_mode="approve"` |

（同期合入、不在本包里的：#2487 只在 agent-node（见 `.124` 说明）；#2488 / #2490 / #2494 是 Hub 端，随 commhub-server；#2491 只改官网下载页。）

## 🔴 升级须知

- 🔴 （沿用 `.154`）不要把新 Hub 回滚到旧的签发器（#678）。
- （沿用 `.153`）开机脚本要和 CLI 一起更新；（沿用 `.150`）`codex` / `grok` / `claude` 不在系统目录时先配 `daemonExtraPath`；（沿用 `.116`）`secrets.env` 必须是 `0600`。
- 外部 app-server 路线（`codex-external-appserver`）不加这一项：那里 commhub 来自用户自己的 `config.toml`，单独给未定义的 server 传 `-c` 会让 codex 起不来。这类节点请在自己的 `[mcp_servers.commhub]` 下手动加 `default_tools_approval_mode = "approve"`。

## 你会看到的变化

- **commhub 工具首次调用不再弹审批（#2493，#720）。** 以前 codex 第一次调用每个 commhub 工具都会问「Allow the commhub MCP server to run tool …?」，`approval_policy` 管不到；无人值守节点没人回答，回合卡住到 Hub 超时；「always allow」重启后也丢。现在共存 app-server 启动时就预批准 commhub 的工具，只作用于 commhub。
  - anet 的 `-c` 会覆盖用户 `[mcp_servers.commhub]` 里的默认模式；用户给单个工具写的 `approval_mode="prompt"` 仍然生效。
- **配对 agent-node `.124`。** 带 #2487（#703）：codex app-server 节点重启后为被打断的原任务补发回执，不重新执行。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.156 @sleep2agi/agent-node@2.5.0-preview.124
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.156 @sleep2agi/agent-node@2.5.0-preview.124
```

两个包一起升级（`agent-network@2.3.0-preview.156 ↔ agent-node@2.5.0-preview.124`）。升级后重启 codex 共存节点（`anet node stop` / `anet node start`），新的启动参数才会带上。

## 回滚

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.155 @sleep2agi/agent-node@2.5.0-preview.123
```

再重启 daemon 和节点。回滚后 commhub 工具首次调用会重新出现审批提示。

## 证据

- #2493：`tests/test720-codex-commhub-tool-approval/`（Docker，真实 codex 0.133.0 / 0.159.2 app-server，假模型 + 假 commhub MCP；新起 / 重启 / Windows / agent-node 三种姿态；对照组不带该项时出现提示或被拒；变异 M1–M7 变红；L4 跑真实 `anet node start` 启动器断言 argv），报告见 `docs/tests/report-test720.txt`；`agent-network/src/codex-commhub-mcp.test.ts`。
- 未在真实生产节点 / daemon 上验证。
