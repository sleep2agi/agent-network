# agent-network 2.3.0-preview.150

配对版本：`PAIRED_AGENT_NETWORK_VERSION` → `2.3.0-preview.150`，`PAIRED_AGENT_NODE_VERSION` → `2.5.0-preview.117`（见 [`release-v2.5.0-preview.117.md`](./release-v2.5.0-preview.117.md)）。

自 `.149`（发版合并 `a0ee5b93`，#2435）以来，`agent-network/` 没有功能改动（`git log a0ee5b93..<发版提交> -- agent-network/` 只有本次发版提交）。本版只移动配对：随 anet 自动拉取的 agent-node 从 `.116` 升到 `.117`。

## 你会看到的变化

- 配对的 agent-node 升到 `.117`（#2439，#648）：daemon 子节点 PATH 可通过 daemon 节点 `config.json` 的 `daemonExtraPath` 追加绝对目录；建节点时 runtime 的 CLI 判为 `missing_cli` 会在 spawn 前拒绝，报错写明缺哪个命令和去哪里配。详见 agent-node 说明。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.150 @sleep2agi/agent-node@2.5.0-preview.117
```

## Upgrade

```bash
anet upgrade --channel preview
# 或显式指定：
npm i -g @sleep2agi/agent-network@2.3.0-preview.150 @sleep2agi/agent-node@2.5.0-preview.117
```

两个包一起升级（`agent-network@2.3.0-preview.150 ↔ agent-node@2.5.0-preview.117`）。
- 🔴 升级前：如果 `codex` / `grok` / `claude` 不在运行 daemon 的 node 同一目录、也不在系统目录，先把它们所在目录的绝对路径写进 daemon 节点 `config.json` 的 `daemonExtraPath` 并重启 daemon，否则从 app 建这几种节点会被拒绝。
- 🔴 agent-node 仍会拒绝权限不是 `0600` 的 `secrets.env`（自 `.116`）。

## 证据

- 本版 anet 无代码改动，只有配对常量与版本号；agent-node 部分的证据见 agent-node `.117` 说明。
- 未在真实生产节点上验证。

## promote 时的 must_contain

`"version": "2.3.0-preview.150"`
