# @sleep2agi/agent-network (CLI) 2.3.0-preview.262

与 `@sleep2agi/agent-node` **2.5.0-preview.228** 精确配对（`PAIRED_AGENT_NODE_VERSION`）。

## Why

只改配对常量，指向 agent-node 2.5.0-preview.228（Antigravity 节点不再每次回复都先重复之前的内容；Claude 节点日志写明所用的 claude 程序，见该版说明）。CLI 自身没有行为变化。

## Install

```bash
npm install -g @sleep2agi/agent-network@2.3.0-preview.262 @sleep2agi/agent-node@2.5.0-preview.228
```

## Upgrade

```bash
anet pair     # 应显示 2.5.0-preview.228
anet upgrade
```

## 未验

- 无新增；Windows 上的已知问题见 2.3.0-preview.259 的说明。
