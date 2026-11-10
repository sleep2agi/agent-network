# agent-node 2.5.0-preview.200

Since `.199`: fork 到新目录（clone_node new_empty，#3504）。

## Why

admin 2026-11-10 要「fork 到新目录」：新节点放在源目录旁边独立干活。daemon 侧：
- 新目录取源目录旁边第一个空着的 `<源目录名>-N`（与 vdev 上 client-oe / -2 / -3 的习惯一致）；
- 收编（adopt）来的节点也能当克隆源（workdir 从对象型登记读）；
- 只把 AGENTS.md / CLAUDE.md 带进新目录；opencode.json / ANET-COMMHUB.md 逐节点生成、带源节点 MCP 凭证，绝不复制；
- OpenCode 克隆到新目录起新会话，不再与源节点共用一份 transcript（上下文由 App 发交接消息）。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.232 @sleep2agi/agent-node@2.5.0-preview.200
```

## Upgrade

```bash
anet pair     # 打印与当前 CLI 精确配对的那一行
```

⚠️ 与 agent-network `2.3.0-preview.232` 精确配对。

## What it does not do

- 不改已有节点的配置，不重启已运行的节点；只影响 daemon 处理 clone_node
