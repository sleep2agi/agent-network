# agent-node 2.5.0-preview.203

Since `.202`: OpenCode 共存节点启动时限 35s → 90s；fork 带过去的 AGENTS.md 标题改成新节点名。

## Why

vdev 2026-11-11 实测：挂共享 serve 的 OpenCode 节点从拉起到就绪要 33–60 秒，daemon（35s）和
`anet node start`（30s，CLI `.235`）都在就绪前一刻把它杀掉。fork 出来的节点读 AGENTS.md 第一行仍是源节点名。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.235 @sleep2agi/agent-node@2.5.0-preview.203
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-network `2.3.0-preview.235` 精确配对。

## What it does not do

- 不改已有节点的配置，不重启已运行的节点；只影响 daemon 处理 clone_node
