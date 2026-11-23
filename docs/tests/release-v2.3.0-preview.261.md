# @sleep2agi/agent-network (CLI) 2.3.0-preview.261

与 `@sleep2agi/agent-node` **2.5.0-preview.227** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。

## Why

只改配对常量，指向 agent-node 2.5.0-preview.227（修复：被 daemon 接管的节点远程启动被误报失败，见该版说明）。CLI 自身没有行为变化。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.261 @sleep2agi/agent-node@2.5.0-preview.227
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.227
anet upgrade
```

## 未验

- 无新增；Windows 上的已知问题见 2.3.0-preview.259 的说明。
