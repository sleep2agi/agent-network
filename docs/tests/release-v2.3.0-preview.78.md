# `@sleep2agi/agent-network@2.3.0-preview.78`

## 为什么发这一版:**38 个 claude-code 裸节点在 Dashboard 上只剩「在线」两个字**(#1727)

| 用户看到的 | `.77` | `.78` |
|---|---|---|
| Dashboard 节点卡片:`claude-code` 类型的 uptime / rss / cpu / load / disk | 全空(在线舰队 38/130,29%) | 有值 —— node-server 开机注册 / 重连 / 3 分钟心跳三处都带 `host` + `process_telemetry`,与 agent-node 同一份采集器 |
| `version` 那一格 | 空 | 仍空(node-server 是 anet 生成的 bundle,没有自己的版本号;要填先定义报什么,单独开) |

`.77` 之后 `agent-network/bin|src` 只有这一个提交(`3088eef6`,#1787)。

## Install

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.78
```

## Upgrade

```bash
npm i -g @sleep2agi/agent-network@2.3.0-preview.78
# claude-code 节点的 .anet/node-server.js 是启动时由 anet 生成的,不重启不会换:
anet node stop <name> && anet node start <name>
```

## 边界

- 只对 `claude-code` 族(裸会话)有变化;agent-node 托管的节点本来就有这六个字段。
- hub 的 `report_status` schema 早就收 `host` / `process_telemetry`(agent-node 一直在发),不需要升 hub。

## promote 时的 must_contain

`cpu_load_1min`(`.77` 产物 0 命中,已用闸 4 原样命令验)。
