# agent-node 2.5.0-preview.205

Since `.204`: OpenCode 会话目录在工作区子目录下（例如 git worktree `<workspace>/wt/<branch>`）也算本节点的会话，可以恢复。

## Why

OpenCode 的会话 `location.directory` 会随 agent `cd` 改变。`.204` 恢复时要求它与工作区完全相等，
vdev 2026-11-11 TMA客户端欧5号 的会话位置变成 `<workspace>/wt/cli-path-visibility` 后，重启报
「OpenCode v2 session directory does not match the node workspace」，一直起不来（#3537）。
现在按路径边界判断：相等或在其下都算；`/ws-2` 不算 `/ws` 下，带 `..` 的不算。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.237 @sleep2agi/agent-node@2.5.0-preview.205
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-network `2.3.0-preview.237` 精确配对。

## What it does not do

- 不改已有节点的配置，不重启已运行的节点；只放宽恢复会话时的目录校验
